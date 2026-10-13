#!/usr/bin/env python3
"""Temporarily install the unsigned add-on through Firefox BiDi in an empty profile."""
import argparse
import base64
import json
import socket
import subprocess
import tempfile
import time
import urllib.parse
import zipfile
from pathlib import Path

from receive_chromium import CDP


def free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


class BiDi(CDP):
    def command(self, method, params=None):
        self.counter += 1
        request_id = self.counter
        self.send({"id": request_id, "method": method, "params": params or {}})
        while True:
            result = self.receive()
            if result.get("id") == request_id:
                if result.get("type") != "success":
                    raise RuntimeError(str(result))
                return result.get("result", {})

    def evaluate(self, context, expression):
        result = self.command("script.evaluate", {"expression": expression,
            "target": {"context": context}, "awaitPromise": True})
        if result.get("type") != "success":
            raise RuntimeError(str(result))
        return result.get("result", {}).get("value")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--browser", required=True)
    parser.add_argument("--extension", type=Path, required=True)
    parser.add_argument("--public-providers", action="store_true")
    parser.add_argument("--fixtures", type=Path)
    parser.add_argument("--screenshot", type=Path)
    args = parser.parse_args()
    port = free_port()
    source_url = "https://example.com/arena-block-receiving"
    with tempfile.TemporaryDirectory(prefix="arena-block-firefox-") as profile:
        archive = Path(profile) / "arena-block-test.xpi"
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as output:
            for source in args.extension.resolve().rglob("*"):
                if source.is_file():
                    if source.name == "background.js":
                        # This line exists only in the temporary test XPI. It opens
                        # the editor so BiDi can discover Firefox's ephemeral UUID.
                        editor_path = "editor.html?" + urllib.parse.urlencode({"source": source_url})
                        bootstrap = "\nconst testBrowser = globalThis.browser ?? globalThis.chrome;\n" \
                            + f"testBrowser.tabs.create({{url:testBrowser.runtime.getURL({json.dumps(editor_path)})}});\n"
                        output.writestr("background.js", source.read_text() + bootstrap)
                    elif source.name == "manifest.json" and args.public_providers:
                        manifest = json.loads(source.read_text())
                        manifest["host_permissions"] = ["https://api.fxtwitter.com/*", "https://public.api.bsky.app/*"]
                        output.writestr("manifest.json", json.dumps(manifest))
                    else:
                        output.write(source, source.relative_to(args.extension.resolve()))
        (Path(profile) / "user.js").write_text('user_pref("toolkit.telemetry.enabled", false);\n'
            'user_pref("datareporting.healthreport.uploadEnabled", false);\n'
            'user_pref("app.normandy.enabled", false);\n')
        log = Path(profile) / "remote.log"
        with log.open("wb") as stderr:
            process = subprocess.Popen([args.browser, "--headless", "--no-remote", "--profile", profile,
                "--remote-debugging-port", str(port), "-remote-allow-system-access", "about:blank"],
                stdout=subprocess.DEVNULL, stderr=stderr)
            try:
                deadline = time.monotonic() + 15
                while time.monotonic() < deadline and process.poll() is None:
                    if "WebDriver BiDi listening" in log.read_text(errors="replace"):
                        break
                    time.sleep(.15)
                else:
                    relevant = [line for line in log.read_text(errors="replace").splitlines()
                        if any(word in line.lower() for word in ["webdriv", "remote agent", "listening", "debugging", "error"])]
                    raise RuntimeError(f"Firefox remote agent unavailable on {port}: {relevant[-12:]}")
                bidi = BiDi(f"ws://127.0.0.1:{port}/session", origin=None)
                try:
                    bidi.command("session.new", {"capabilities": {"alwaysMatch": {"webSocketUrl": True}}})
                    installed = bidi.command("webExtension.install", {"extensionData": {
                        "type": "archivePath", "path": str(archive) }})
                    def editor_context():
                        return next((item for item in bidi.command("browsingContext.getTree")["contexts"]
                            if item["url"].startswith("moz-extension://") and "/editor.html?" in item["url"]), None)
                    deadline = time.monotonic() + 10
                    page = None
                    while time.monotonic() < deadline:
                        page = editor_context()
                        if page:
                            break
                        time.sleep(.1)
                    if not page:
                        raise RuntimeError("Temporary Firefox editor tab did not open")
                    context = page["context"]
                    if bidi.evaluate(context, "document.title") != "Arena Block":
                        raise RuntimeError("Firefox editor title did not render")
                    worker_reply = json.loads(bidi.evaluate(context,
                        "browser.runtime.sendMessage({kind:'arena-block-create',"
                        "saveId:'00000000-0000-4000-8000-000000000000'}).then(x=>JSON.stringify(x))"))
                    if worker_reply.get("ok") is not False or "missing" not in worker_reply.get("error", ""):
                        raise RuntimeError(f"Background save channel did not respond safely: {worker_reply}")
                    if bidi.evaluate(context, "document.querySelector('#primary')?.value") != source_url:
                        raise RuntimeError("Firefox editor did not prefill source")
                    bidi.evaluate(context, "document.querySelector('#resolve').click()")
                    deadline = time.monotonic() + 10
                    while time.monotonic() < deadline:
                        if bidi.evaluate(context, "document.querySelector('#composition-fields')?.hidden === false"):
                            break
                        time.sleep(.1)
                    else:
                        raise RuntimeError("Firefox editor did not compose ordinary URL")
                    if bidi.evaluate(context, "document.querySelector('#block-kind').textContent") != "Url block":
                        raise RuntimeError("Firefox editor produced an unexpected plan")
                    layout = json.loads(bidi.evaluate(context, "JSON.stringify({width:document.body.getBoundingClientRect().width,"
                        "height:document.body.getBoundingClientRect().height,footerVisible:"
                        "document.querySelector('#save').getBoundingClientRect().bottom<=document.body.getBoundingClientRect().bottom})"))
                    if layout != {"width": 380, "height": 520, "footerVisible": True}:
                        raise RuntimeError(f"Firefox popup dimensions are wrong: {layout}")
                    bidi.evaluate(context, "document.querySelector('#choose-channel').click()")
                    picker_layout = json.loads(bidi.evaluate(context, "JSON.stringify({height:document.body.getBoundingClientRect().height,"
                        "visible:!document.querySelector('#channel-view').hidden,"
                        "footerVisible:document.querySelector('#save').getBoundingClientRect().bottom<=document.body.getBoundingClientRect().bottom})"))
                    if picker_layout != {"height": 580, "visible": True, "footerVisible": True}:
                        raise RuntimeError(f"Firefox channel view dimensions are wrong: {picker_layout}")
                    bidi.evaluate(context, "document.querySelector('#back-to-capture').click()")
                    screenshot_error = None
                    if args.screenshot:
                        try:
                            shot = bidi.command("browsingContext.captureScreenshot", {"context": context,
                                "origin": "viewport", "clip": {"type": "box", "x": 0, "y": 0,
                                    "width": 380, "height": 520}})
                            args.screenshot.write_bytes(base64.b64decode(shot["data"]))
                        except RuntimeError as error:
                            if "privileged scope" not in str(error):
                                raise
                            screenshot_error = "Firefox BiDi does not capture privileged extension pages"
                    bidi.evaluate(context, "document.querySelector('#title').value='Edited in Firefox'; "
                        "document.querySelector('#title').dispatchEvent(new Event('input',{bubbles:true})); "
                        "document.querySelector('#default-channel').value='test-channel'; "
                        "document.querySelector('#default-channel').dispatchEvent(new Event('input',{bubbles:true}))")
                    for chosen in ["first-channel", "second-channel"]:
                        bidi.evaluate(context, f"document.querySelector('#channel').value={json.dumps(chosen)}; "
                            "document.querySelector('#add-channel').click()")
                    if bidi.evaluate(context, "document.querySelector('#selected-count')?.textContent") != "2 / 20":
                        raise RuntimeError("Firefox editor did not select both channels")
                    time.sleep(.5)
                    bidi.command("browsingContext.reload", {"context": context, "wait": "complete"})
                    if bidi.evaluate(context, "document.querySelector('#title')?.value") != "Edited in Firefox":
                        raise RuntimeError("Firefox editor did not retain title")
                    if bidi.evaluate(context, "document.querySelector('#default-channel')?.value") != "test-channel":
                        raise RuntimeError("Firefox editor did not retain default channel")
                    if bidi.evaluate(context, "document.querySelector('#selected-count')?.textContent") != "2 / 20":
                        raise RuntimeError("Firefox editor did not retain both channels")
                    public_checks = []
                    if args.public_providers:
                        fixtures = args.fixtures or Path(__file__).resolve().parents[2] / "tests" / "fixtures"
                        x_posts = json.loads((fixtures / "multi-post-squares.json").read_text())["posts"]
                        bluesky = json.loads((fixtures / "bluesky-op-thread.json").read_text())
                        for provider, urls, thread in [
                            ("x", [post["url"] for post in x_posts], "off"),
                            ("bluesky", [bluesky["source"]], "on"),
                        ]:
                            bidi.evaluate(context, f"document.querySelector('#primary').value={json.dumps(chr(10).join(urls))}; "
                                "document.querySelector('#primary').dispatchEvent(new Event('input',{bubbles:true})); "
                                f"document.querySelector('#thread-policy').value={json.dumps(thread)}; "
                                "document.querySelector('#thread-policy').dispatchEvent(new Event('input',{bubbles:true})); "
                                "document.querySelector('#media-policy').value='all'; "
                                "document.querySelector('#media-policy').dispatchEvent(new Event('input',{bubbles:true})); "
                                "document.querySelector('#resolve').click()")
                            deadline = time.monotonic() + 45
                            while time.monotonic() < deadline:
                                if bidi.evaluate(context, "document.querySelector('#source-count').textContent") == "4 sources" \
                                    and bidi.evaluate(context, "document.querySelector('#source-link').href") == urls[0]:
                                    break
                                time.sleep(.15)
                            else:
                                status = bidi.evaluate(context, "document.querySelector('#status').textContent")
                                raise RuntimeError(f"Firefox {provider} did not resolve four posts: {status}")
                            media = bidi.evaluate(context, "document.querySelectorAll('#media-list li').length")
                            if media < 1:
                                raise RuntimeError(f"Firefox {provider} lost source media")
                            public_checks.append({"provider": provider, "sources": 4, "media_rows": media})
                    print(json.dumps({"browser_loaded": True, "extension_id": installed.get("extension"),
                        "temporary": True, "editor_loaded": True, "source_prefilled": True,
                        "web_plan": True, "draft_after_reload": True, "background_save_channel": True,
                        "default_channel_after_reload": True, "multi_channel_after_reload": True,
                        "popup_layout": layout, "picker_layout": picker_layout,
                        "screenshot_error": screenshot_error,
                        "host_used": False, "public_provider_checks": public_checks}))
                finally:
                    bidi.close()
            finally:
                process.terminate()
                try: process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill(); process.wait(timeout=3)


if __name__ == "__main__":
    main()
