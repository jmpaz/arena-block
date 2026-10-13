#!/usr/bin/env python3
"""Load an unpacked extension through CDP in an empty branded Chrome profile."""
import argparse
import base64
import json
import subprocess
import tempfile
import time
import urllib.parse
from pathlib import Path

from receive_chromium import CDP, get_json, wait_for


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--browser", required=True)
    parser.add_argument("--extension", type=Path, required=True)
    parser.add_argument("--screenshot", type=Path)
    parser.add_argument("--action-screenshot", type=Path)
    parser.add_argument("--screenshot-channel", type=Path)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="arena-block-chrome-") as profile:
        process = subprocess.Popen([args.browser, "--headless=new", "--disable-gpu", "--no-first-run",
            "--no-default-browser-check", f"--user-data-dir={profile}", "--remote-debugging-port=0",
            "--remote-allow-origins=*", "about:blank"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            active = Path(profile) / "DevToolsActivePort"
            wait_for(lambda: active.exists() or process.poll() is not None)
            if not active.exists():
                raise RuntimeError(f"Chrome exited before CDP started: {process.returncode}")
            port = int(active.read_text().splitlines()[0])
            base = f"http://127.0.0.1:{port}"
            browser = CDP(get_json(base + "/json/version")["webSocketDebuggerUrl"])
            try:
                loaded = browser.command("Extensions.loadUnpacked", {"path": str(args.extension.resolve())})
                extension_id = loaded.get("id")
                worker = wait_for(lambda: next((target for target in get_json(base + "/json/list")
                    if target.get("type") == "service_worker" and target.get("url", "").endswith("/background.js")), None))
                extension_id = extension_id or worker["url"].split("/")[2]
                source = "https://example.com/arena-block-receiving"
                tab_id = browser.command("Target.createTarget", {"url": source, "forTab": True})["targetId"]
                wait_for(lambda: any(target.get("type") == "page" and target.get("url") == source
                    for target in get_json(base + "/json/list")))
                browser.command("Target.activateTarget", {"targetId": tab_id})
                browser.command("Extensions.triggerAction", {"id": extension_id, "targetId": tab_id})
                page = wait_for(lambda: next((target for target in get_json(base + "/json/list")
                    if target.get("type") == "page" and target.get("url", "").startswith(
                        f"chrome-extension://{extension_id}/editor.html")), None))
                action_editor_url = page["url"]
                action_popup_id = page["id"]
                cdp = CDP(page["webSocketDebuggerUrl"])
                try:
                    worker_reply = cdp.evaluate("chrome.runtime.sendMessage({kind:'arena-block-create',"
                        "saveId:'00000000-0000-4000-8000-000000000000'})")
                    if worker_reply.get("ok") is not False or "missing" not in worker_reply.get("error", ""):
                        raise RuntimeError(f"Background save channel did not respond safely: {worker_reply}")
                    source_prefilled = False
                    action_tab_urls = cdp.evaluate("chrome.tabs.query({active:true,currentWindow:true}).then(t=>t.map(x=>x.url))")
                    try:
                        wait_for(lambda: cdp.evaluate("document.querySelector('#primary')?.value") == source, seconds=3)
                        source_prefilled = True
                    except RuntimeError:
                        pass
                    if args.action_screenshot:
                        dimensions = cdp.evaluate("({width:document.body.getBoundingClientRect().width,"
                            "height:document.body.getBoundingClientRect().height})")
                        if dimensions["width"] != 380 or dimensions["height"] > 520:
                            raise RuntimeError(f"Action popup dimensions are wrong: {dimensions}")
                        footer = cdp.evaluate("(()=>{const r=document.querySelector('.save-section').getBoundingClientRect();"
                            "return {top:r.top,bottom:r.bottom,viewportHeight:innerHeight,"
                            "buttonBottom:document.querySelector('#save').getBoundingClientRect().bottom}})()")
                        if footer["buttonBottom"] > footer["viewportHeight"]:
                            raise RuntimeError(f"Action popup button is clipped: {footer}")
                        shot = cdp.command("Page.captureScreenshot", {"format": "png",
                            "captureBeyondViewport": False, "clip": {"x": 0, "y": 0,
                                "width": 380, "height": footer["viewportHeight"], "scale": 1}})
                        args.action_screenshot.write_bytes(base64.b64decode(shot["data"]))
                    if not source_prefilled:
                        cdp.close()
                        direct_url = f"chrome-extension://{extension_id}/editor.html?" + urllib.parse.urlencode({"source": source})
                        page = get_json(base + "/json/new?" + urllib.parse.quote(direct_url, safe=""), "PUT")
                        cdp = CDP(page["webSocketDebuggerUrl"])
                        wait_for(lambda: cdp.evaluate("document.querySelector('#primary')?.value") == source)
                    cdp.evaluate("document.querySelector('#resolve').click()")
                    wait_for(lambda: cdp.evaluate("document.querySelector('#composition-fields')?.hidden === false"))
                    if cdp.evaluate("document.querySelector('#composition').open || document.querySelector('#source-details').open"):
                        raise RuntimeError("Editing controls were exposed in the focused capture view")
                    if args.screenshot:
                        cdp.command("Emulation.setDeviceMetricsOverride", {"width": 380, "height": 520,
                            "deviceScaleFactor": 1, "mobile": False})
                        shot = cdp.command("Page.captureScreenshot", {"format": "png", "captureBeyondViewport": False,
                            "clip": {"x": 0, "y": 0, "width": 380, "height": 520, "scale": 1}})
                        args.screenshot.write_bytes(base64.b64decode(shot["data"]))
                    if args.screenshot_channel:
                        cdp.evaluate("document.querySelector('#choose-channel').click()")
                        wait_for(lambda: cdp.evaluate("document.querySelector('#channel-view')?.hidden === false"))
                        cdp.command("Emulation.setDeviceMetricsOverride", {"width": 380, "height": 580,
                            "deviceScaleFactor": 1, "mobile": False})
                        shot = cdp.command("Page.captureScreenshot", {"format": "png", "captureBeyondViewport": False,
                            "clip": {"x": 0, "y": 0, "width": 380, "height": 580, "scale": 1}})
                        args.screenshot_channel.write_bytes(base64.b64decode(shot["data"]))
                        cdp.evaluate("document.querySelector('#back-to-capture').click()")
                    cdp.evaluate("document.querySelector('#composition > summary').click();"
                        "document.querySelector('#source-details > summary').click()")
                    if not cdp.evaluate("document.querySelector('#composition').open &&"
                        "document.querySelector('#source-details').open &&"
                        "document.querySelector('#title').getClientRects().length>0 &&"
                        "document.querySelector('#primary').getClientRects().length>0"):
                        raise RuntimeError("Title and multi-source editing could not be disclosed")
                    narrow_overflow = cdp.evaluate("document.documentElement.style.width='360px';"
                        "document.body.style.width='360px';"
                        "document.documentElement.scrollWidth>document.documentElement.clientWidth ||"
                        "document.body.scrollWidth>document.body.clientWidth")
                    if narrow_overflow:
                        raise RuntimeError("Capture view overflows at 360 CSS px")
                    cdp.evaluate("document.documentElement.style.width='';document.body.style.width=''")
                    cdp.evaluate("document.querySelector('#title').value='Edited in browser'; document.querySelector('#title').dispatchEvent(new Event('input',{bubbles:true}))")
                    cdp.evaluate("document.querySelector('#default-channel').value='test-channel'; document.querySelector('#default-channel').dispatchEvent(new Event('input',{bubbles:true}))")
                    for chosen in ["first-channel", "second-channel"]:
                        cdp.evaluate(f"document.querySelector('#channel').value={json.dumps(chosen)}; document.querySelector('#add-channel').click()")
                    wait_for(lambda: cdp.evaluate("document.querySelector('#selected-count')?.textContent") == "2 / 20")
                    time.sleep(.5)
                    cdp.command("Page.reload")
                    wait_for(lambda: cdp.evaluate("document.querySelector('#title')?.value") == "Edited in browser")
                    wait_for(lambda: cdp.evaluate("document.querySelector('#default-channel')?.value") == "test-channel")
                    wait_for(lambda: cdp.evaluate("document.querySelector('#selected-count')?.textContent") == "2 / 20")
                    cdp.evaluate("document.querySelector('#title').value='Quick close';"
                        "document.querySelector('#title').dispatchEvent(new Event('input',{bubbles:true}))")
                    cdp.close()
                    browser.command("Target.closeTarget", {"targetId": page["id"]})
                    if action_popup_id != page["id"]:
                        try:
                            browser.command("Target.closeTarget", {"targetId": action_popup_id})
                        except RuntimeError:
                            pass  # Opening the direct test tab may already dismiss the popup.
                    browser.command("Extensions.triggerAction", {"id": extension_id, "targetId": tab_id})
                    reopened = wait_for(lambda: next((target for target in get_json(base + "/json/list")
                        if target.get("type") == "page" and target.get("url", "") ==
                        f"chrome-extension://{extension_id}/editor.html" and target.get("id") != action_popup_id), None))
                    cdp = CDP(reopened["webSocketDebuggerUrl"])
                    wait_for(lambda: cdp.evaluate("document.querySelector('#title')?.value") == "Quick close")
                    wait_for(lambda: cdp.evaluate("document.querySelector('#selected-count')?.textContent") == "2 / 20")
                    web_plan = cdp.evaluate("document.querySelector('#block-kind').textContent") == "Url block"
                    next_source = "https://example.com/manually-kept"
                    next_url = f"chrome-extension://{extension_id}/editor.html?" + urllib.parse.urlencode({"source": next_source})
                    manual_tab = get_json(base + "/json/new?" + urllib.parse.quote(next_url, safe=""), "PUT")
                    cdp.close()
                    cdp = CDP(manual_tab["webSocketDebuggerUrl"])
                    wait_for(lambda: cdp.evaluate("document.querySelector('#title')?.value") == "Quick close")
                    wait_for(lambda: cdp.evaluate("document.querySelector('#add-current')?.hidden === false"))
                    cdp.evaluate("document.querySelector('#new-capture').click()")
                    wait_for(lambda: cdp.evaluate("document.querySelector('#selected-count')?.textContent") == "1 / 20")
                    if cdp.evaluate("document.querySelector('#title')?.value") == "Quick close":
                        raise RuntimeError("New capture retained the previous edited block")
                    wait_for(lambda: cdp.evaluate("document.querySelector('#primary')?.value") == next_source)
                    wait_for(lambda: cdp.evaluate("chrome.storage.local.get('arena-block-editor-draft-v1').then(x=>x['arena-block-editor-draft-v1']?.primary)") == next_source)
                    fresh_source = "https://example.com/automatic-replacement"
                    fresh_url = f"chrome-extension://{extension_id}/editor.html?" + urllib.parse.urlencode({"source": fresh_source})
                    fresh_tab = get_json(base + "/json/new?" + urllib.parse.quote(fresh_url, safe=""), "PUT")
                    cdp.close()
                    cdp = CDP(fresh_tab["webSocketDebuggerUrl"])
                    wait_for(lambda: cdp.evaluate("document.querySelector('#primary')?.value") == fresh_source)
                    wait_for(lambda: cdp.evaluate("document.querySelector('#selected-count')?.textContent") == "1 / 20")
                    print(json.dumps({"browser_loaded": True, "action_opened_popup": True,
                        "action_source_prefilled": source_prefilled, "action_editor_url": action_editor_url,
                        "action_tab_urls": action_tab_urls,
                        "extension_id": extension_id,
                        "web_plan": web_plan, "new_capture_clears_prior_draft": True,
                        "manual_edit_kept_across_sources": True, "automatic_draft_replaced_by_new_source": True,
                        "draft_after_reload": True, "draft_after_dismissal": True,
                        "background_save_channel": True,
                        "narrow_360_no_overflow": True,
                        "default_channel_after_reload": True,
                        "multi_channel_after_reload": True, "host_used": False}))
                finally:
                    cdp.close()
            finally:
                browser.close()
        finally:
            process.terminate()
            try: process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill(); process.wait(timeout=3)


if __name__ == "__main__":
    main()
