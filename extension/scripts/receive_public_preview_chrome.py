#!/usr/bin/env python3
"""Capture a reviewed public x.com composition with fake channel browsing, no save."""
import argparse
import base64
import json
import shutil
import subprocess
import tempfile
import urllib.parse
from pathlib import Path

from receive_chromium import CDP, get_json, wait_for


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--browser", required=True)
    parser.add_argument("--extension", type=Path, required=True)
    parser.add_argument("--capture-screenshot", type=Path, required=True)
    parser.add_argument("--picker-screenshot", type=Path, required=True)
    args = parser.parse_args()
    fixtures = Path(__file__).resolve().parents[2] / "tests" / "fixtures"
    refs = [post["url"] for post in json.loads((fixtures / "multi-post-squares.json").read_text())["posts"]]
    with tempfile.TemporaryDirectory(prefix="arena-block-public-preview-") as temp:
        root = Path(temp)
        extension = root / "extension"
        shutil.copytree(args.extension, extension)
        manifest = json.loads((extension / "manifest.json").read_text())
        manifest["host_permissions"] = ["https://api.fxtwitter.com/*", "https://api.are.na/*"]
        (extension / "manifest.json").write_text(json.dumps(manifest))
        (extension / "oauth-client.json").write_text('{"clientId":"fixture-only"}\n')
        profile = root / "profile"
        process = subprocess.Popen([args.browser, "--headless=new", "--disable-gpu", "--no-first-run",
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
                target = get_json(base + "/json/new?about:blank", "PUT")
                page = CDP(target["webSocketDebuggerUrl"])
                try:
                    page.command("Page.enable")
                    fake_arena = """
                    (() => {
                      const actual = globalThis.fetch.bind(globalThis);
                      globalThis.fetch = async (input, init) => {
                        const url = String(input);
                        if (!url.startsWith('https://api.are.na/v3/')) return actual(input, init);
                        if (url.endsWith('/me')) return Response.json({data:{id:7}});
                        if (url.includes('/users/7/contents')) return Response.json({data:[
                          {id:1,title:'Motion Index',slug:'motion-index',visibility:'public',
                           owner:{name:'Josh',slug:'josh'},counts:{contents:12},can:{add_to:true}},
                          {id:2,title:'Reading Room',slug:'reading-room',visibility:'private',
                           owner:{name:'Josh',slug:'josh'},counts:{contents:24},can:{add_to:true}}
                        ],meta:{current_page:1,has_more_pages:false}});
                        throw new Error('No live Are.na call permitted in preview fixture: '+url);
                      };
                    })();
                    """
                    page.command("Page.addScriptToEvaluateOnNewDocument", {"source": fake_arena})
                    editor = f"chrome-extension://{extension_id}/editor.html"
                    page.command("Page.navigate", {"url": editor})
                    wait_for(lambda: page.evaluate("document.querySelector('#selected-channels')?.childElementCount") > 0)
                    page.evaluate("chrome.storage.local.set({'arena-block-oauth-v1':{accessToken:'fixture-only-token'}})")
                    page.command("Page.reload")
                    wait_for(lambda: page.evaluate("document.querySelector('#selected-channels')?.childElementCount") > 0)
                    wait_for(lambda: page.evaluate("document.querySelector('#connect-arena')?.hidden === true"))
                    page.evaluate("document.querySelector('#primary').value=" + json.dumps("\n".join(refs)) + ";"
                        "document.querySelector('#primary').dispatchEvent(new Event('input',{bubbles:true}));"
                        "document.querySelector('#thread-policy').value='off';"
                        "document.querySelector('#thread-policy').dispatchEvent(new Event('input',{bubbles:true}));"
                        "document.querySelector('#media-policy').value='all';"
                        "document.querySelector('#media-policy').dispatchEvent(new Event('input',{bubbles:true}))")
                    page.command("Runtime.evaluate", {"expression": "document.querySelector('#resolve').click()",
                        "userGesture": True})
                    try:
                        wait_for(lambda: page.evaluate("document.querySelector('#composition-fields')?.hidden === false"), 45)
                    except RuntimeError as error:
                        raise RuntimeError("Public x.com preview did not resolve: " +
                            str(page.evaluate("document.querySelector('#status').textContent"))) from error
                    if page.evaluate("document.querySelector('#source-count').textContent") != "4 sources":
                        raise RuntimeError("Public x.com preview lost thread sources")
                    wait_for(lambda: page.evaluate("document.querySelector('#capture-preview-image').naturalWidth>0"), 10)
                    page.command("Emulation.setDeviceMetricsOverride", {"width": 380, "height": 520,
                        "deviceScaleFactor": 1, "mobile": False})
                    page.evaluate("document.querySelector('.viewport').scrollTop=document.querySelector('#composition').offsetTop-50")
                    shot = page.command("Page.captureScreenshot", {"format": "png", "captureBeyondViewport": False,
                        "clip": {"x": 0, "y": 0, "width": 380, "height": 520, "scale": 1}})
                    args.capture_screenshot.write_bytes(base64.b64decode(shot["data"]))
                    page.command("Runtime.evaluate", {"expression": "document.querySelector('#choose-channel').click()",
                        "userGesture": True})
                    wait_for(lambda: page.evaluate("document.querySelectorAll('.channel-row-item').length") == 2)
                    page.evaluate("document.querySelector('.channel-choice').click()")
                    try:
                        wait_for(lambda: page.evaluate("document.querySelector('#picker-preview-image').naturalWidth>0"), 10)
                    except RuntimeError:
                        pass
                    page.command("Emulation.setDeviceMetricsOverride", {"width": 380, "height": 580,
                        "deviceScaleFactor": 1, "mobile": False})
                    shot = page.command("Page.captureScreenshot", {"format": "png", "captureBeyondViewport": False,
                        "clip": {"x": 0, "y": 0, "width": 380, "height": 580, "scale": 1}})
                    args.picker_screenshot.write_bytes(base64.b64decode(shot["data"]))
                    print(json.dumps({"public_x_read": True, "sources": 4,
                        "picker_preview_title": page.evaluate("document.querySelector('#picker-preview-title').textContent"),
                        "picker_preview_image": page.evaluate("document.querySelector('#picker-preview-image').hidden === false"),
                        "image_loaded": page.evaluate("document.querySelector('#picker-preview-image').naturalWidth>0"),
                        "fixture_channels": True, "live_write": False}))
                finally:
                    page.close()
            finally:
                browser.close()
        finally:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=3)


if __name__ == "__main__":
    main()
