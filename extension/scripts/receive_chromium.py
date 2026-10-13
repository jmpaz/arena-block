#!/usr/bin/env python3
"""Load an unpacked extension in an empty headless Chromium profile and test web capture."""
import argparse
import base64
import json
import os
import socket
import struct
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request
from pathlib import Path


def get_json(url, method="GET"):
    with urllib.request.urlopen(urllib.request.Request(url, method=method), timeout=3) as response:
        return json.load(response)


class CDP:
    def __init__(self, url, origin="http://localhost"):
        parsed = urllib.parse.urlsplit(url)
        self.socket = socket.create_connection((parsed.hostname, parsed.port), timeout=5)
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        origin_header = f"Origin: {origin}\r\n" if origin else ""
        request = (f"GET {parsed.path or '/'} HTTP/1.1\r\nHost: {parsed.hostname}:{parsed.port}\r\n"
                   f"Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
                   f"Sec-WebSocket-Version: 13\r\n{origin_header}\r\n")
        self.socket.sendall(request.encode("ascii"))
        header = bytearray()
        while b"\r\n\r\n" not in header:
            header.extend(self.socket.recv(1))
        if b" 101 " not in header.split(b"\r\n", 1)[0]:
            raise RuntimeError(f"CDP WebSocket rejected: {header.splitlines()[0]!r}")
        self.counter = 0

    def close(self):
        self.socket.close()

    def read_exact(self, length):
        result = bytearray()
        while len(result) < length:
            data = self.socket.recv(length - len(result))
            if not data:
                raise RuntimeError("CDP socket closed")
            result.extend(data)
        return bytes(result)

    def send(self, value):
        payload = json.dumps(value).encode("utf8")
        header = bytearray([0x81])
        if len(payload) < 126:
            header.append(0x80 | len(payload))
        elif len(payload) < 65536:
            header.extend([0x80 | 126]); header.extend(struct.pack("!H", len(payload)))
        else:
            header.extend([0x80 | 127]); header.extend(struct.pack("!Q", len(payload)))
        mask = os.urandom(4)
        self.socket.sendall(header + mask + bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload)))

    def receive(self):
        first, second = self.read_exact(2)
        length = second & 127
        if length == 126:
            length = struct.unpack("!H", self.read_exact(2))[0]
        elif length == 127:
            length = struct.unpack("!Q", self.read_exact(8))[0]
        if second & 128:
            mask = self.read_exact(4)
        else:
            mask = None
        body = self.read_exact(length)
        if mask:
            body = bytes(byte ^ mask[index % 4] for index, byte in enumerate(body))
        if first & 15 != 1:
            return {}
        return json.loads(body)

    def evaluate(self, expression):
        result = self.command("Runtime.evaluate", {"expression": expression, "returnByValue": True, "awaitPromise": True})
        return result.get("result", {}).get("value")

    def command(self, method, params=None):
        self.counter += 1
        request_id = self.counter
        self.send({"id": request_id, "method": method, "params": params or {}})
        while True:
            result = self.receive()
            if result.get("id") == request_id:
                if "error" in result or "exceptionDetails" in result.get("result", {}):
                    raise RuntimeError(str(result))
                return result.get("result", {})


def wait_for(predicate, seconds=10):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(.1)
    raise RuntimeError("Browser condition did not become true")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--browser", required=True)
    parser.add_argument("--extension", type=Path, required=True)
    args = parser.parse_args()
    extension = args.extension.resolve()
    with tempfile.TemporaryDirectory(prefix="arena-block-chromium-") as profile:
        process = subprocess.Popen([args.browser, "--headless=new", "--no-sandbox", "--disable-gpu",
            "--ozone-platform=headless", "--no-first-run", "--no-default-browser-check",
            f"--user-data-dir={profile}", f"--disable-extensions-except={extension}",
            f"--load-extension={extension}", "--remote-debugging-port=0",
            "--remote-allow-origins=*", "about:blank"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            active = Path(profile) / "DevToolsActivePort"
            wait_for(lambda: active.exists() or process.poll() is not None)
            if not active.exists():
                raise RuntimeError(f"Chromium exited before CDP started: {process.returncode}")
            port = int(active.read_text().splitlines()[0])
            base = f"http://127.0.0.1:{port}"
            worker = wait_for(lambda: next((target for target in get_json(base + "/json/list")
                if target.get("type") == "service_worker" and target.get("url", "").endswith("/background.js")), None))
            extension_id = worker["url"].split("/")[2]
            source = "https://example.com/arena-block-receiving"
            editor_url = f"chrome-extension://{extension_id}/editor.html?" + urllib.parse.urlencode({"source": source})
            page = get_json(base + "/json/new?" + urllib.parse.quote(editor_url, safe=""), "PUT")
            cdp = CDP(page["webSocketDebuggerUrl"])
            try:
                wait_for(lambda: cdp.evaluate("document.querySelector('#primary')?.value") == source)
                cdp.evaluate("document.querySelector('#resolve').click()")
                wait_for(lambda: cdp.evaluate("document.querySelector('#composition-fields')?.hidden === false"))
                kind = cdp.evaluate("document.querySelector('#block-kind').textContent")
                if kind != "Url block":
                    raise RuntimeError(f"Unexpected plan kind: {kind}")
                cdp.evaluate("document.querySelector('#title').value='Edited in browser'; document.querySelector('#title').dispatchEvent(new Event('input',{bubbles:true}))")
                cdp.evaluate("document.querySelector('#default-channel').value='test-channel'; document.querySelector('#default-channel').dispatchEvent(new Event('input',{bubbles:true}))")
                for chosen in ["first-channel", "second-channel"]:
                    cdp.evaluate(f"document.querySelector('#channel').value={json.dumps(chosen)}; document.querySelector('#add-channel').click()")
                wait_for(lambda: cdp.evaluate("document.querySelector('#selected-count')?.textContent") == "2 / 20")
                time.sleep(.5)
                cdp.send({"id": 999, "method": "Page.reload", "params": {}})
                wait_for(lambda: cdp.evaluate("document.querySelector('#title')?.value") == "Edited in browser")
                wait_for(lambda: cdp.evaluate("document.querySelector('#default-channel')?.value") == "test-channel")
                wait_for(lambda: cdp.evaluate("document.querySelector('#selected-count')?.textContent") == "2 / 20")
                print(json.dumps({"browser_loaded": True, "extension_id": extension_id, "web_plan": True,
                    "draft_after_reload": True, "default_channel_after_reload": True,
                    "multi_channel_after_reload": True, "host_used": False}))
            finally:
                cdp.close()
        finally:
            process.terminate()
            try: process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill(); process.wait(timeout=3)


if __name__ == "__main__":
    main()
