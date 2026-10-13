#!/usr/bin/env python3
"""Read public X and Bluesky examples through a temporary Chrome extension."""
import argparse
import json
import shutil
import subprocess
import sys
import tempfile
import urllib.parse
from pathlib import Path

from receive_chromium import CDP, get_json, wait_for


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--browser", required=True)
    parser.add_argument("--extension", type=Path, required=True)
    parser.add_argument("--fixtures", type=Path)
    args = parser.parse_args()
    fixtures = args.fixtures or Path(__file__).resolve().parents[2] / "tests" / "fixtures"
    x_posts = json.loads((fixtures / "multi-post-squares.json").read_text())["posts"]
    bluesky = json.loads((fixtures / "bluesky-op-thread.json").read_text())
    cases = [
        ("x", [post["url"] for post in x_posts], "off", [str(post["id"]) for post in x_posts]),
        ("bluesky", [bluesky["source"]], "on",
         ["3mxjzbrinf22d", "3mxjzmgx6sc2d", "3mxk2eqkcks2d", "3mxk2iwcjec2a"]),
    ]
    with tempfile.TemporaryDirectory(prefix="arena-block-public-browser-") as temp:
        root = Path(temp)
        extension = root / "extension"
        shutil.copytree(args.extension, extension)
        manifest = json.loads((extension / "manifest.json").read_text())
        manifest["host_permissions"] = ["https://api.fxtwitter.com/*", "https://public.api.bsky.app/*"]
        (extension / "manifest.json").write_text(json.dumps(manifest))
        profile = root / "profile"
        linux_flags = ["--no-sandbox", "--ozone-platform=headless"] if sys.platform == "linux" else []
        process = subprocess.Popen([args.browser, "--headless=new", "--disable-gpu", *linux_flags, "--no-first-run",
            "--no-default-browser-check", f"--user-data-dir={profile}", "--remote-debugging-port=0",
            "--remote-allow-origins=*", "about:blank"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            active = profile / "DevToolsActivePort"
            wait_for(lambda: active.exists() or process.poll() is not None)
            if not active.exists():
                raise RuntimeError(f"Chrome exited before CDP started: {process.returncode}")
            port = int(active.read_text().splitlines()[0])
            base = f"http://127.0.0.1:{port}"
            browser = CDP(get_json(base + "/json/version")["webSocketDebuggerUrl"])
            try:
                extension_id = browser.command("Extensions.loadUnpacked", {"path": str(extension)})["id"]
                for provider, urls, thread, expected in cases:
                    url = f"chrome-extension://{extension_id}/editor.html"
                    target = get_json(base + "/json/new?" + urllib.parse.quote(url, safe=""), "PUT")
                    page = CDP(target["webSocketDebuggerUrl"])
                    try:
                        wait_for(lambda: page.evaluate("document.querySelector('#primary') !== null"))
                        page.evaluate(f"document.querySelector('#primary').value={json.dumps(chr(10).join(urls))};"
                            "document.querySelector('#primary').dispatchEvent(new Event('input',{bubbles:true}))")
                        page.evaluate(f"document.querySelector('#thread-policy').value={json.dumps(thread)};"
                            "document.querySelector('#thread-policy').dispatchEvent(new Event('input',{bubbles:true}));"
                            "document.querySelector('#media-policy').value='all';"
                            "document.querySelector('#media-policy').dispatchEvent(new Event('input',{bubbles:true}))")
                        page.command("Runtime.evaluate", {"expression": "document.querySelector('#resolve').click()",
                            "userGesture": True})
                        try:
                            wait_for(lambda: page.evaluate("document.querySelector('#composition-fields').hidden === false"), 45)
                        except RuntimeError as error:
                            status = page.evaluate("document.querySelector('#status').textContent")
                            raise RuntimeError(f"{provider} did not resolve: {status}") from error
                        count = page.evaluate("document.querySelector('#source-count').textContent")
                        media = page.evaluate("document.querySelectorAll('#media-list li').length")
                        if count != f"{len(expected)} sources" or media < 1:
                            raise RuntimeError(f"{provider} lost sources or media: {count}, {media}")
                        print(json.dumps({"provider": provider, "public_read": True, "source_count": len(expected),
                            "media_rows": media, "live_write": False}))
                    finally:
                        page.close()
            finally:
                browser.close()
        finally:
            process.terminate()
            try: process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill(); process.wait(timeout=3)


if __name__ == "__main__":
    main()
