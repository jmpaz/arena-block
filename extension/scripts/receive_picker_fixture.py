#!/usr/bin/env python3
"""Exercise the channel picker with fake Are.na responses in an empty Chrome profile."""
import argparse
import base64
import json
import shutil
import subprocess
import tempfile
import urllib.parse
from pathlib import Path

from receive_chromium import CDP, get_json, wait_for


def press_enter(page):
    page.evaluate("document.querySelector('#channel').focus()")
    page.command("Input.dispatchKeyEvent", {"type": "keyDown", "key": "Enter", "code": "Enter",
        "windowsVirtualKeyCode": 13, "nativeVirtualKeyCode": 13})
    page.command("Input.dispatchKeyEvent", {"type": "keyUp", "key": "Enter", "code": "Enter",
        "windowsVirtualKeyCode": 13, "nativeVirtualKeyCode": 13})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--browser", required=True)
    parser.add_argument("--extension", type=Path, required=True)
    parser.add_argument("--screenshot", type=Path)
    parser.add_argument("--dark-screenshot", type=Path)
    parser.add_argument("--composition-screenshot", type=Path)
    parser.add_argument("--action-picker-screenshot", type=Path)
    parser.add_argument("--initial-error", action="store_true")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="arena-block-picker-fixture-") as temp:
        root = Path(temp)
        extension = root / "extension"
        shutil.copytree(args.extension, extension)
        manifest = json.loads((extension / "manifest.json").read_text())
        manifest["host_permissions"] = ["https://api.are.na/*"]
        (extension / "manifest.json").write_text(json.dumps(manifest))
        (extension / "oauth-client.json").write_text('{"clientId":"fixture-only"}\n')
        profile = root / "profile"
        process = subprocess.Popen([args.browser, "--headless=new", "--disable-gpu", "--no-first-run",
            "--no-default-browser-check", f"--user-data-dir={profile}", "--remote-debugging-port=0",
            "--remote-allow-origins=*", "about:blank"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            active = profile / "DevToolsActivePort"
            wait_for(lambda: active.exists() and active.stat().st_size > 0 or process.poll() is not None)
            if not active.exists() or active.stat().st_size == 0:
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
                    fixture = """
                    (() => {
                      const original = globalThis.fetch.bind(globalThis);
                      globalThis.fetch = async (input, init) => {
                        const url = String(input);
                        if (!url.startsWith('https://api.are.na/v3/')) return original(input, init);
                        if (url.endsWith('/me')) return Response.json({data:{id:7}});
                        const params = new URL(url).searchParams;
                        const make = (id,title,canAdd=true) => ({id,title,slug:title.toLowerCase().replaceAll(' ','-'),
                          visibility:id===2?'private':'public',owner:{name:'Josh',slug:'josh'},
                          counts:{contents:id*12},can:{add_to:canAdd}});
                        if (url.includes('/users/7/contents')) {
                          const page = Number(params.get('page'));
                          if (page===1) return Response.json({data:[make(1,'Motion Index'),make(2,'Reading Room')],
                            meta:{current_page:1,has_more_pages:true,next_page:2}});
                          if (page===2) return Response.json({data:[make(2,'Reading Room Updated'),make(3,'Archive',false)],
                            meta:{current_page:2,has_more_pages:false}});
                        }
                        if (url.includes('/search')) {
                          await new Promise(resolve => setTimeout(resolve, 450));
                          const query = params.get('query');
                          return Response.json({data:query==='reading'?[make(2,'Reading Room')]:[make(1,'Motion Index')],
                            meta:{current_page:1,has_more_pages:false}});
                        }
                        throw new Error('Fixture blocked an unexpected Are.na request: '+url);
                      };
                    })();
                    """
                    if args.initial_error:
                        fixture = fixture.replace("if (page===1) return Response.json",
                            "if (page===1 && !globalThis.fixtureFailedOnce) {"
                            "globalThis.fixtureFailedOnce=true; return Response.json({}, {status:503}); }"
                            "if (page===1) return Response.json")
                    page.command("Page.addScriptToEvaluateOnNewDocument", {"source": fixture})
                    url = f"chrome-extension://{extension_id}/editor.html?" + urllib.parse.urlencode({
                        "source": "https://example.com/arena-block-receiving"})
                    page.command("Page.navigate", {"url": url})
                    wait_for(lambda: page.evaluate("document.querySelector('#channel') !== null"))
                    wait_for(lambda: page.evaluate("document.querySelector('#connect-arena').hidden === false"))
                    page.evaluate("chrome.storage.local.set({'arena-block-oauth-v1':{accessToken:'fixture-only-token'}})")
                    page.command("Page.reload")
                    wait_for(lambda: page.evaluate("document.querySelector('#selected-channels')?.childElementCount") > 0)
                    wait_for(lambda: page.evaluate("document.querySelector('#connect-arena')?.hidden === true"))
                    page.command("Runtime.evaluate", {"expression": "document.querySelector('#choose-channel').click()", "userGesture": True})
                    if args.initial_error:
                        wait_for(lambda: page.evaluate("document.querySelector('#more-channels')?.textContent==='Retry' &&"
                            "document.querySelector('#more-channels').hidden===false"))
                        page.evaluate("document.querySelector('#more-channels').click()")
                        wait_for(lambda: page.evaluate("document.querySelectorAll('.channel-row-item').length>=2"))
                        print(json.dumps({"fixture_only": True, "initial_channel_retry": True,
                            "live_write": False}))
                        return
                    try:
                        wait_for(lambda: page.evaluate("document.querySelectorAll('.channel-row-item').length") >= 2)
                    except RuntimeError as error:
                        state = page.evaluate("({progress:document.querySelector('#channel-progress').textContent, rows:document.querySelectorAll('.channel-row-item').length, open:!document.querySelector('#channel-results').hidden, token:!!chrome.storage.local, config:document.querySelector('#connect-arena').hidden})")
                        raise RuntimeError(f"Picker did not load: {state}") from error
                    page.evaluate("document.querySelector('#channel').value='archive';"
                        "document.querySelector('#channel').dispatchEvent(new Event('input',{bubbles:true}))")
                    wait_for(lambda: page.evaluate("document.querySelector('#channel-list .channel-row-item')?.dataset.rowId") == "3")
                    page.evaluate("document.querySelector('#channel').value='';"
                        "document.querySelector('#channel').dispatchEvent(new Event('input',{bubbles:true}))")
                    wait_for(lambda: page.evaluate("document.querySelectorAll('.channel-row-item').length") == 3)
                    page.evaluate("document.querySelector('.channel-choice').click()")
                    page.evaluate("const list=document.querySelector('#channel-list');list.scrollTop=list.scrollHeight;"
                        "list.dispatchEvent(new Event('scroll'))")
                    wait_for(lambda: page.evaluate("document.querySelectorAll('.channel-row-item').length") == 3)
                    after = page.evaluate("[...document.querySelectorAll('.channel-row-item')].map(row=>row.dataset.rowId).join(',')")
                    if after != "1,2,3":
                        raise RuntimeError(f"Channel order changed: {after}")
                    if page.evaluate("document.querySelector('#selected-count').textContent") != "1 / 20":
                        raise RuntimeError("Channel selection did not persist across pages")
                    if page.evaluate("document.querySelector('[data-row-id=\"2\"] .channel-text strong').textContent") != "Reading Room Updated":
                        raise RuntimeError("Channel metadata did not refresh in place")
                    page.evaluate("document.querySelector('[data-row-id=\"3\"] .channel-menu').click()")
                    if not page.evaluate("document.querySelector('[data-row-id=\"3\"] .channel-options button').disabled"):
                        raise RuntimeError("Unavailable channel could become the default")
                    page.evaluate("document.querySelector('[data-row-id=\"2\"] .channel-menu').click()")
                    page.evaluate("document.querySelector('[data-row-id=\"2\"] .channel-options button').click()")
                    if page.evaluate("document.querySelector('#selected-count').textContent") != "1 / 20":
                        raise RuntimeError("Opening channel options toggled selection")
                    if page.evaluate("document.querySelector('#default-channel').value") != "2":
                        raise RuntimeError("Channel menu did not set the default")
                    page.evaluate("document.querySelector('#channel').value='mtion'; document.querySelector('#channel').dispatchEvent(new Event('input',{bubbles:true}))")
                    if page.evaluate("document.querySelectorAll('.channel-row-item').length") != 1:
                        raise RuntimeError("Retained local channel search did not filter")
                    page.evaluate("document.querySelector('#channel').value='reading';"
                        "document.querySelector('#channel').dispatchEvent(new Event('input',{bubbles:true}))")
                    press_enter(page)
                    if page.evaluate("document.querySelector('#selected-count').textContent") != "2 / 20":
                        raise RuntimeError("Enter did not select the first matching channel")
                    page.evaluate("document.querySelector('.channel-choice').click()")
                    page.evaluate("document.querySelector('#channel').value=''; document.querySelector('#channel').dispatchEvent(new Event('input',{bubbles:true}))")
                    if args.screenshot:
                        page.command("Emulation.setEmulatedMedia", {"features": [
                            {"name": "prefers-color-scheme", "value": "light"}]})
                        page.command("Emulation.setDeviceMetricsOverride", {"width": 380, "height": 580,
                            "deviceScaleFactor": 1, "mobile": False})
                        shot = page.command("Page.captureScreenshot", {"format": "png", "captureBeyondViewport": False,
                            "clip": {"x": 0, "y": 0, "width": 380, "height": 580, "scale": 1}})
                        args.screenshot.write_bytes(base64.b64decode(shot["data"]))
                    if args.dark_screenshot:
                        page.command("Emulation.setEmulatedMedia", {"features": [
                            {"name": "prefers-color-scheme", "value": "dark"}]})
                        page.command("Emulation.setDeviceMetricsOverride", {"width": 380, "height": 580,
                            "deviceScaleFactor": 1, "mobile": False})
                        shot = page.command("Page.captureScreenshot", {"format": "png", "captureBeyondViewport": False,
                            "clip": {"x": 0, "y": 0, "width": 380, "height": 580, "scale": 1}})
                        args.dark_screenshot.write_bytes(base64.b64decode(shot["data"]))
                        page.command("Emulation.setEmulatedMedia", {"features": [
                            {"name": "prefers-color-scheme", "value": "light"}]})
                    if args.composition_screenshot:
                        page.evaluate("document.querySelector('#back-to-capture').click()")
                        page.evaluate("document.querySelector('#resolve').click()")
                        wait_for(lambda: page.evaluate("document.querySelector('#composition-fields').hidden === false"))
                        page.command("Emulation.setDeviceMetricsOverride", {"width": 380, "height": 520,
                            "deviceScaleFactor": 1, "mobile": False})
                        shot = page.command("Page.captureScreenshot", {"format": "png", "captureBeyondViewport": False,
                            "clip": {"x": 0, "y": 0, "width": 380, "height": 520, "scale": 1}})
                        args.composition_screenshot.write_bytes(base64.b64decode(shot["data"]))
                    if args.action_picker_screenshot:
                        source_target = browser.command("Target.createTarget", {
                            "url": "https://example.com/arena-block-receiving", "forTab": True})["targetId"]
                        browser.command("Target.activateTarget", {"targetId": source_target})
                        browser.command("Extensions.triggerAction", {"id": extension_id, "targetId": source_target})
                        action = wait_for(lambda: next((item for item in get_json(base + "/json/list")
                            if item.get("type") == "page" and item.get("url", "") ==
                            f"chrome-extension://{extension_id}/editor.html"), None))
                        popup = CDP(action["webSocketDebuggerUrl"])
                        try:
                            popup.evaluate(fixture)
                            popup.evaluate("chrome.permissions.request = async () => true")
                            wait_for(lambda: popup.evaluate("document.querySelector('#selected-count')?.textContent") == "1 / 20")
                            wait_for(lambda: popup.evaluate("document.querySelector('#connect-arena')?.hidden === true"))
                            popup.evaluate("document.querySelector('#channel').value='';"
                                "document.querySelector('#channel').dispatchEvent(new Event('input',{bubbles:true}))")
                            popup.evaluate("document.querySelector('#choose-channel').click()")
                            try:
                                wait_for(lambda: popup.evaluate("document.querySelectorAll('.channel-row-item').length") >= 2)
                            except RuntimeError as error:
                                state = popup.evaluate("({progress:document.querySelector('#channel-progress').textContent,"
                                    "rows:document.querySelectorAll('.channel-row-item').length,"
                                    "pickerOpen:!document.querySelector('#channel-view').hidden,"
                                    "resultsOpen:!document.querySelector('#channel-results').hidden,"
                                    "connectHidden:document.querySelector('#connect-arena').hidden})")
                                raise RuntimeError(f"Action picker did not load: {state}") from error
                            bounds = popup.evaluate("(()=>{const r=document.querySelector('#save').getBoundingClientRect();"
                                "return {width:innerWidth,height:innerHeight,buttonBottom:r.bottom}})()")
                            if bounds["width"] < 380 or bounds["buttonBottom"] > bounds["height"]:
                                raise RuntimeError(f"Action picker is clipped: {bounds}")
                            shot = popup.command("Page.captureScreenshot", {"format": "png", "captureBeyondViewport": False,
                                "clip": {"x": 0, "y": 0, "width": 380, "height": bounds["height"], "scale": 1}})
                            args.action_picker_screenshot.write_bytes(base64.b64decode(shot["data"]))
                        finally:
                            popup.close()
                    page.evaluate("document.querySelector('#back-to-capture').click();"
                        "document.querySelector('#resolve').click()")
                    wait_for(lambda: page.evaluate("document.querySelector('#composition-fields').hidden === false"))
                    page.evaluate("document.querySelector('#composition > summary').click();"
                        "document.querySelector('#source-details > summary').click();"
                        "document.querySelector('.viewport').scrollTop=120")
                    before = page.evaluate("document.querySelector('.viewport').scrollTop")
                    if before < 60:
                        raise RuntimeError(f"Capture view did not have enough scroll room: {before}")
                    page.evaluate("document.querySelector('#choose-channel').click();"
                        "document.querySelector('#back-to-capture').click()")
                    after = page.evaluate("document.querySelector('.viewport').scrollTop")
                    if abs(after - before) > 1:
                        raise RuntimeError(f"Picker return lost capture scroll position: {before} -> {after}")
                    page.evaluate("document.querySelector('#choose-channel').click();"
                        "document.querySelector('[data-channel-scope=all]').click()")
                    wait_for(lambda: page.evaluate("document.querySelector('#channel-list .channel-row-item')?.dataset.rowId") == "1")
                    selected_before = page.evaluate("document.querySelector('#selected-count').textContent")
                    page.evaluate("document.querySelector('#channel').value='reading';"
                        "document.querySelector('#channel').dispatchEvent(new Event('input',{bubbles:true}))")
                    press_enter(page)
                    if page.evaluate("document.querySelector('#selected-count').textContent") != selected_before:
                        raise RuntimeError("Enter selected a stale network search result")
                    wait_for(lambda: page.evaluate("document.querySelector('#channel-list .channel-row-item')?.dataset.rowId") == "2")
                    press_enter(page)
                    if page.evaluate("document.querySelector('#selected-count').textContent") == selected_before:
                        raise RuntimeError("Enter could not select the new network search result")
                    page.evaluate("document.querySelector('#picker-selected-channels button').focus();"
                        "document.querySelector('#picker-selected-channels button').click()")
                    if page.evaluate("document.activeElement?.tagName") != "BUTTON":
                        raise RuntimeError("Removing a selected channel lost keyboard focus")
                    page.evaluate("document.querySelector('#clear-channels').click()")
                    for index in range(20):
                        page.evaluate(f"document.querySelector('#channel').value='choice-{index}';"
                            "document.querySelector('#add-channel').click()")
                    page.evaluate("document.querySelector('#default-channel').value='extra';"
                        "document.querySelector('#default-mode').value='always';"
                        "document.querySelector('#default-channel').dispatchEvent(new Event('input',{bubbles:true}))")
                    if not page.evaluate("document.querySelector('#save').disabled &&"
                        "document.querySelector('#save').textContent==='Check channels' &&"
                        "document.querySelector('#save-status').textContent==='Choose at most 20 channels'"):
                        raise RuntimeError("Over-limit destinations had no visible guidance")
                    page.evaluate("document.querySelector('#clear-channels').click();"
                        "document.querySelector('#default-channel').value='bad channel';"
                        "document.querySelector('#default-channel').dispatchEvent(new Event('input',{bubbles:true}))")
                    if page.evaluate("document.querySelector('#save-status').textContent") != "Choose a channel slug or numeric ID":
                        raise RuntimeError("Invalid default channel had no visible guidance")
                    print(json.dumps({"fixture_only": True, "account_id": 7, "pages": 2,
                        "stable_row_order": True, "retained_selection": True, "metadata_updated_in_place": True,
                        "default_menu_did_not_toggle": True, "local_search": True,
                        "keyboard_select": True, "live_write": False}))
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
