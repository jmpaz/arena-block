#!/usr/bin/env python3
"""Exercise an installed Codex MCP client without model turns or live publishing."""
import argparse
import json
import os
from pathlib import Path
import queue
import shutil
import signal
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def client_environment(home):
    environment = dict(os.environ)
    environment["CODEX_HOME"] = str(home)
    for name in tuple(environment):
        if name.startswith("ARENA_"):
            del environment[name]
    return environment


class CodexClient:
    def __init__(self, executable, home, transcript):
        self.transcript = transcript
        self.responses = queue.Queue()
        self.next_id = 0
        self.stderr = (home / "app-server.stderr").open("w")
        self.process = subprocess.Popen(
            [executable, "app-server", "--stdio", "--strict-config"],
            cwd=home, env=client_environment(home), stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=self.stderr, text=True, start_new_session=True,
        )
        self.reader = threading.Thread(target=self.read, daemon=True)
        self.reader.start()

    def read(self):
        for line in self.process.stdout:
            try:
                response = json.loads(line)
            except json.JSONDecodeError:
                self.responses.put({"invalidOutput": line[:500]})
                continue
            self.transcript.append({"direction": "received", "message": response})
            self.responses.put(response)

    def send(self, message):
        self.transcript.append({"direction": "sent", "message": message})
        self.process.stdin.write(json.dumps(message) + "\n")
        self.process.stdin.flush()

    def request(self, method, params, timeout=40):
        self.next_id += 1
        request_id = self.next_id
        self.send({"id": request_id, "method": method, "params": params})
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                response = self.responses.get(timeout=max(0.01, deadline-time.monotonic()))
            except queue.Empty:
                break
            if "invalidOutput" in response:
                raise RuntimeError("Codex emitted a non-JSON protocol line")
            if "id" in response and "method" in response:
                self.send({"id": response["id"], "error": {"code": -32601, "message": "No interactive approvals in qualification"}})
                continue
            if response.get("id") == request_id:
                if "error" in response:
                    raise RuntimeError(f"{method}: {json.dumps(response['error'])}")
                return response["result"]
        raise RuntimeError(f"{method}: client response deadline exceeded")

    def close(self):
        try:
            self.process.stdin.close()
        except BrokenPipeError:
            pass
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.signal_group(signal.SIGTERM)
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.signal_group(signal.SIGKILL)
                self.process.wait()
        self.signal_group(signal.SIGTERM)
        self.signal_group(signal.SIGKILL)
        self.reader.join(timeout=2)
        self.stderr.close()

    def signal_group(self, action):
        try:
            os.killpg(self.process.pid, action)
        except ProcessLookupError:
            pass


def result_content(response):
    # Codex returns the MCP CallToolResult under `result`.
    value = response.get("result", response)
    if value.get("isError"):
        raise RuntimeError("MCP tool returned an error: " + json.dumps(value))
    if "structuredContent" in value:
        return value["structuredContent"]
    return json.loads(value["content"][0]["text"])


def require(condition, detail):
    if not condition:
        raise RuntimeError(detail)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cli", required=True, type=Path)
    parser.add_argument("--plan", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--codex", default=shutil.which("codex"))
    args = parser.parse_args()
    if not args.codex:
        parser.error("Use an already installed Codex executable")
    cli, output = args.cli.resolve(strict=True), args.output.absolute()
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    with args.plan.open("rb") as file:
        encoded_plan = file.read(2 * 1024 * 1024 + 1)
    require(len(encoded_plan) <= 2 * 1024 * 1024, "Qualification plan exceeds 2 MiB")
    plan = json.loads(encoded_plan)
    # This daemon double cannot publish. Unrecognized paths/methods are rejected.
    calls = []
    class OwnerFixture(BaseHTTPRequestHandler):
        def do_GET(self):
            calls.append({"method": "GET", "path": self.path})
            if self.path == "/v1/save-policy":
                body = {"credential": {"profile": "shared", "arenaTokenEnv": "ARENA_WRITE_ACCESS_TOKEN"}, "mcpPublishingEnabled": True}
                code = 200
            else:
                body, code = {"error": "Unknown fixture save"}, 404
            encoded = json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)
        def do_POST(self):
            calls.append({"method": "POST", "path": self.path})
            self.send_error(405, "Publishing is impossible in this qualification")
        def log_message(self, *unused):
            pass
    version = subprocess.check_output([args.codex, "--version"], env=client_environment(output), text=True, timeout=10).strip()
    fixture = ThreadingHTTPServer(("127.0.0.1", 0), OwnerFixture)
    thread = threading.Thread(target=fixture.serve_forever, daemon=True)
    thread.start()
    report = {"outcome": "failed", "codexVersion": version, "cli": str(cli), "modelTurnStartRequests": 0, "saveToolCalls": 0, "networkObservation": "Only the isolated loopback owner fixture is observed; no global packet capture", "modes": []}
    transcripts = []
    try:
        for enabled in (False, True):
            name = "publishing-catalog-fixture" if enabled else "default-preview"
            home = output / name
            home.mkdir(mode=0o700)
            user_config = home / "arena-config.json"
            user_config.write_text(json.dumps({"schemaVersion": 1}))
            user_config.chmod(0o600)
            cli_args = ["mcp", "--config", str(user_config)] + (["--publish"] if enabled else [])
            config = '\n'.join([
                'model = "qualification-no-generation"',
                'model_provider = "qualification"',
                '[model_providers.qualification]',
                'name = "Qualification (no turns)"',
                f'base_url = "http://127.0.0.1:{fixture.server_port}/never-model"',
                'wire_api = "responses"',
                '[mcp_servers.arena_block]',
                'command = ' + json.dumps(str(cli)),
                'args = ' + json.dumps(cli_args),
                'startup_timeout_sec = 15',
                'tool_timeout_sec = 160',
                '[mcp_servers.arena_block.env]',
                'ARENA_BLOCK_ENDPOINT = ' + json.dumps(f'http://127.0.0.1:{fixture.server_port}'),
                'ARENA_BLOCK_ACCESS_TOKEN = "fictional-loopback-fixture-never-a-real-credential"',
            ]) + '\n'
            (home / "config.toml").write_text(config)
            (home / "config.toml").chmod(0o600)
            transcript = []
            transcripts.append(transcript)
            client = CodexClient(args.codex, home, transcript)
            try:
                client.request("initialize", {"clientInfo": {"name": "arena-block-installed-client-qualification", "version": "1"}, "capabilities": {"experimentalApi": True, "explicitGatewayOauth": True}})
                client.send({"method": "initialized"})
                thread_info = client.request("thread/start", {"cwd": str(home), "ephemeral": True, "sandbox": "read-only", "approvalPolicy": "never"})
                thread_id = thread_info["thread"]["id"]
                inventory = client.request("mcpServerStatus/list", {"threadId": thread_id, "serverName": "arena_block"})
                server = next(s for s in inventory["data"] if s["name"] == "arena_block")
                expected = {"arena_block_preview_save", "arena_block_policy"} | ({"arena_block_save", "arena_block_save_status", "arena_block_cancel_save"} if enabled else set())
                require(not server.get("toolsError"), "Codex tool discovery failed: " + str(server.get("toolsError")))
                require(set(server["tools"]) == expected, "Unexpected tool catalog: " + str(list(server["tools"])))
                def call(tool, arguments):
                    return client.request("mcpServer/tool/call", {"threadId": thread_id, "server": "arena_block", "tool": tool, "arguments": arguments})
                policy = result_content(call("arena_block_policy", {}))
                preview = result_content(call("arena_block_preview_save", {"plan": plan, "destinations": ["fictional-qualification-destination"], "agent": {"label": "Fictional qualification", "workflowId": "qualification:installed-codex"}}))
                snapshot = preview["snapshot"]
                require(snapshot["origin"] == "mcp-local", "Wrong transport origin")
                require(snapshot["authentication"] == {"credentialProfile": "shared", "authenticatedAccountVerified": False}, "Preview invented authenticated identity")
                require(snapshot["routing"]["destinations"] == ["fictional-qualification-destination"], "Preview changed destinations")
                require("remoteInbox" not in snapshot["routing"], "Preview activated Remote Inbox")
                require(snapshot["plan"] == plan, "Preview changed the original source plan")
                require(snapshot["client"]["identityBasis"] == "declared", "Preview promoted client identity")
                require(snapshot["fidelity"]["originalPlanPreserved"], "Preview lost source fidelity")
                require(policy["publishingExposed"] == enabled, "Adapter opt-in does not match its policy")
                report["modes"].append({"name": name, "tools": sorted(server["tools"]), "serverInfo": server.get("serverInfo"), "runtimeStatus": server.get("runtimeStatus"), "preview": preview, "policy": policy})
            finally:
                try:
                    client.close()
                finally:
                    (home / "protocol.json").write_text(json.dumps(transcript, indent=2) + '\n')
        require(bool(calls) and all(c == {"method": "GET", "path": "/v1/save-policy"} for c in calls), "Unexpected owner fixture traffic: " + str(calls))
        report["outcome"] = "passed"
    except Exception as error:
        report["failure"] = str(error)
        raise
    finally:
        fixture.shutdown()
        fixture.server_close()
        thread.join(timeout=2)
        report["mockOwnerRequests"] = calls
        sent = [event["message"] for transcript in transcripts for event in transcript if event["direction"] == "sent"]
        report["modelTurnStartRequests"] = sum(message.get("method") == "turn/start" for message in sent)
        report["saveToolCalls"] = sum(message.get("method") == "mcpServer/tool/call" and message.get("params", {}).get("tool") == "arena_block_save" for message in sent)
        (output / "qualification.json").write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({"output": str(output), "outcome": report["outcome"], "modes": [{"name": m["name"], "tools": len(m["tools"])} for m in report["modes"]], "mockOwnerRequests": len(calls), "modelTurnStartRequests": 0, "saveToolCalls": 0}))


if __name__ == "__main__":
    main()
