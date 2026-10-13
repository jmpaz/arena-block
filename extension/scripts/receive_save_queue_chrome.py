#!/usr/bin/env python3
"""Exercise pre-preview Save and popup dismissal with an intercepted Are.na API."""
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
    parser.add_argument("--deferred-auth", action="store_true")
    parser.add_argument("--edited-stale", action="store_true")
    parser.add_argument("--ambiguous", action="store_true")
    parser.add_argument("--invalid-channel", action="store_true")
    parser.add_argument("--double-click", action="store_true")
    parser.add_argument("--screenshot", type=Path)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="arena-block-save-queue-") as temp:
        root = Path(temp)
        extension = root / "extension"
        shutil.copytree(args.extension, extension)
        manifest = json.loads((extension / "manifest.json").read_text())
        manifest["host_permissions"] = ["https://api.are.na/*"]
        (extension / "manifest.json").write_text(json.dumps(manifest))
        (extension / "oauth-client.json").write_text('{"clientId":"fixture-only"}\n')
        mock = """
        const actualFetch = globalThis.fetch.bind(globalThis);
        globalThis.fetch = async (input, init) => {
          const url = String(input), method = init?.method ?? 'GET';
          if (!url.startsWith('https://api.are.na/v3/')) return actualFetch(input, init);
          if (url.endsWith('/me')) return Response.json({data:{id:7}});
          if (url.endsWith('/channels/one')) return Response.json({data:{id:10}});
          if (url.endsWith('/blocks') && method === 'POST') {
            const stored = await chrome.storage.local.get(['fixturePostCount']);
            await chrome.storage.local.set({fixturePostCount:(stored.fixturePostCount ?? 0)+1,
              fixturePayload:JSON.parse(init.body)});
            return Response.json({data:{id:900}});
          }
          if (url.endsWith('/blocks/900')) {
            const {fixturePayload} = await chrome.storage.local.get('fixturePayload');
            return Response.json({data:{id:900,state:'available',type:'Link',
              title:fixturePayload.title,description:fixturePayload.description ?? null}});
          }
          if (url.includes('/blocks/900/connections')) return Response.json({data:[{id:10}],
            meta:{current_page:1,total_pages:1,has_more_pages:false}});
          throw new Error('Fixture blocked unexpected Are.na request: '+method+' '+url);
        };
        """
        if args.ambiguous:
            mock = mock.replace("return Response.json({data:{id:900}});",
                "throw new TypeError('Fixture response lost after POST');")
        if args.double_click:
            mock = mock.replace("if (url.endsWith('/channels/one')) return Response.json({data:{id:10}});",
                "if (url.endsWith('/channels/one')) {"
                "const x=await chrome.storage.local.get('fixturePrepareCount');"
                "await chrome.storage.local.set({fixturePrepareCount:(x.fixturePrepareCount??0)+1});"
                "await new Promise(resolve=>setTimeout(resolve,450));"
                "return Response.json({data:{id:10}}); }")
        background = extension / "background.js"
        background.write_text(mock + "\n" + background.read_text())
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
                editor = f"chrome-extension://{extension_id}/editor.html"
                target = get_json(base + "/json/new?" + urllib.parse.quote(editor, safe=""), "PUT")
                page = CDP(target["webSocketDebuggerUrl"])
                try:
                    wait_for(lambda: page.evaluate("document.querySelector('#primary') !== null"))
                    if not args.deferred_auth:
                        page.evaluate("chrome.storage.local.set({'arena-block-oauth-v1':{accessToken:'fixture-only-token'}})")
                    page.command("Page.addScriptToEvaluateOnNewDocument", {"source": mock})
                    page.command("Page.reload")
                    wait_for(lambda: page.evaluate("document.querySelector('#selected-channels')?.childElementCount") > 0)
                    wait_for(lambda: page.evaluate("document.querySelector('#connect-arena')?.hidden") == (not args.deferred_auth))
                    page.evaluate(mock)
                    page.evaluate("document.querySelector('#primary').value='https://example.com/queued';"
                        "document.querySelector('#primary').dispatchEvent(new Event('input',{bubbles:true}));"
                        f"document.querySelector('#default-channel').value='{('missing' if args.invalid_channel else 'one')}';"
                        "document.querySelector('#default-channel').dispatchEvent(new Event('input',{bubbles:true}))")
                    wait_for(lambda: page.evaluate("document.querySelector('#save').disabled === false"))
                    if args.invalid_channel:
                        page.evaluate("document.querySelector('#resolve').click()")
                        wait_for(lambda: page.evaluate("document.querySelector('#composition-fields').hidden===false"))
                        page.command("Runtime.evaluate", {"expression": "document.querySelector('#save').click()",
                            "userGesture": True})
                        wait_for(lambda: page.evaluate("document.querySelector('#save-status').classList.contains('error')"))
                        invalid = page.evaluate("chrome.storage.local.get(null).then(x=>({"
                            "pending:x['arena-block-editor-draft-v1']?.pending,"
                            "posts:x.fixturePostCount??0,editable:!document.querySelector('#default-channel').disabled}))")
                        if invalid.get("pending") is not None or invalid["posts"] != 0 or not invalid["editable"]:
                            raise RuntimeError(f"Prewrite channel failure trapped the draft: {invalid}")
                        page.evaluate("document.querySelector('#new-capture').click()")
                        wait_for(lambda: page.evaluate("document.querySelector('#primary').value===''"))
                        print(json.dumps({"fixture_only": True, "invalid_channel_recoverable": True,
                            "post_count": 0, "live_write": False}))
                        return
                    if args.double_click:
                        page.evaluate("document.querySelector('#resolve').click()")
                        wait_for(lambda: page.evaluate("document.querySelector('#composition-fields').hidden===false"))
                    if args.edited_stale:
                        wait_for(lambda: page.evaluate("document.querySelector('#composition-fields').hidden === false"))
                        page.evaluate("document.querySelector('#title').value='My edited title';"
                            "document.querySelector('#title').dispatchEvent(new Event('input',{bubbles:true}));"
                            "document.querySelector('#primary').value='https://example.com/new-source';"
                            "document.querySelector('#primary').dispatchEvent(new Event('input',{bubbles:true}))")
                    elif not args.double_click and page.evaluate("document.querySelector('#composition-fields').hidden") is not True:
                        raise RuntimeError("The block was previewed before Save")
                    click = "document.querySelector('#save').click();"
                    if args.double_click:
                        click += "document.querySelector('#save').click()"
                    page.command("Runtime.evaluate", {"expression": click,
                        "userGesture": True})
                    try:
                        wait_for(lambda: page.evaluate("chrome.storage.local.get('arena-block-editor-draft-v1').then(x=>!!x['arena-block-editor-draft-v1']?.pending?.saveId)"))
                    except RuntimeError as error:
                        state = page.evaluate("chrome.storage.local.get('arena-block-editor-draft-v1').then(x=>({"
                            "save:document.querySelector('#save-status').textContent,"
                            "status:document.querySelector('#status').textContent,"
                            "disabled:document.querySelector('#save').disabled,"
                            "pending:x['arena-block-editor-draft-v1']?.pending,"
                            "source:document.querySelector('#primary').value,"
                            "defaultChannel:document.querySelector('#default-channel').value}))")
                        raise RuntimeError(f"Save did not queue: {state}") from error
                    if not page.evaluate("document.querySelector('#choose-channel').disabled &&"
                        "document.querySelector('#default-channel').disabled &&"
                        "document.querySelector('#default-mode').disabled"):
                        raise RuntimeError("Frozen save still allowed destination edits")
                    if not page.evaluate("document.querySelector('#primary').disabled &&"
                        "document.querySelector('#title').disabled &&"
                        "document.querySelector('#writing').disabled &&"
                        "document.querySelector('#description').disabled &&"
                        "document.querySelector('#media-policy').disabled &&"
                        "document.querySelector('#resolve').disabled"):
                        raise RuntimeError("Frozen save still allowed source or block edits")
                    page.evaluate("document.querySelector('#choose-channel').click()")
                    if not page.evaluate("document.querySelector('#channel-view').hidden"):
                        raise RuntimeError("Frozen save opened a mutable channel picker")
                    if args.deferred_auth:
                        wait_for(lambda: page.evaluate("chrome.storage.local.get('arena-block-editor-draft-v1').then(x=>x['arena-block-editor-draft-v1']?.pending?.phase==='needs_auth')"))
                        page.evaluate("chrome.storage.local.set({'arena-block-oauth-v1':{accessToken:'fixture-only-token'}})")
                finally:
                    page.close()
                reopened = get_json(base + "/json/new?" + urllib.parse.quote(editor, safe=""), "PUT")
                page = CDP(reopened["webSocketDebuggerUrl"])
                try:
                    wait_for(lambda: page.evaluate("typeof chrome.storage?.local === 'object'"))
                    wait_for(lambda: page.evaluate("chrome.storage.local.get('fixturePostCount').then(x=>x.fixturePostCount===1)"), 30)
                    if args.ambiguous:
                        wait_for(lambda: page.evaluate("chrome.storage.local.get('arena-block-editor-draft-v1').then("
                            "x=>x['arena-block-editor-draft-v1']?.pending?.phase==='unknown')"), 30)
                        original = page.evaluate("chrome.storage.local.get('arena-block-editor-draft-v1').then("
                            "x=>x['arena-block-editor-draft-v1'].pending.saveId)")
                        page.evaluate("document.querySelector('#new-capture').click()")
                        wait_for(lambda: page.evaluate("chrome.storage.local.get('arena-block-earlier-saves-v1').then("
                            "x=>x['arena-block-earlier-saves-v1']?.length===1)"))
                        state = page.evaluate("chrome.storage.local.get(null).then(x=>({"
                            "pending:x['arena-block-editor-draft-v1']?.pending,"
                            "earlier:x['arena-block-earlier-saves-v1'],posts:x.fixturePostCount,"
                            "visible:!document.querySelector('#earlier-saves').hidden}))")
                        if state.get("pending") is not None or state["posts"] != 1 or not state["visible"] \
                                or state["earlier"][0]["saveId"] != original:
                            raise RuntimeError(f"Ambiguous save was not retained on New: {state}")
                        page.evaluate("document.querySelector('#earlier-save-list button').click()")
                        wait_for(lambda: page.evaluate("document.querySelector('#earlier-save-list button').disabled===false"))
                        checked = page.evaluate("chrome.storage.local.get(null).then(x=>({"
                            "phase:x['arena-block-earlier-saves-v1']?.[0]?.phase,posts:x.fixturePostCount}))")
                        if checked != {"phase": "unknown", "posts": 1}:
                            raise RuntimeError(f"Earlier check replayed an ambiguous save: {checked}")
                        if args.screenshot:
                            page.command("Emulation.setDeviceMetricsOverride", {"width": 380,
                                "height": 520, "deviceScaleFactor": 1, "mobile": False})
                            page.evaluate("document.querySelector('#earlier-saves').open=true")
                            image = page.command("Page.captureScreenshot", {"format": "png",
                                "captureBeyondViewport": False})["data"]
                            args.screenshot.parent.mkdir(parents=True, exist_ok=True)
                            args.screenshot.write_bytes(base64.b64decode(image))
                        page.command("Page.reload")
                        wait_for(lambda: page.evaluate("document.querySelector('#earlier-count')?.textContent==='1'"))
                        print(json.dumps({"fixture_only": True, "ambiguous_post": True,
                            "earlier_save_persisted": True, "post_count": 1, "live_write": False}))
                        return
                    try:
                        wait_for(lambda: page.evaluate("document.querySelector('#save-status')?.textContent === 'Saved to Are.na.'"), 30)
                    except RuntimeError as error:
                        state = page.evaluate("chrome.storage.local.get(null).then(x=>{"
                            "const p=x['arena-block-editor-draft-v1']?.pending;"
                            "const j=p?x['arena-block-capture-job-'+p.saveId]:null;"
                            "const i=p?x['arena-block-browser-save-'+p.saveId]:null;"
                            "return {status:document.querySelector('#save-status')?.textContent,"
                            "pendingPhase:p?.phase,jobPhase:j?.phase,jobError:j?.error,"
                            "intentPhase:i?.phase,blockId:i?.blockId,posts:x.fixturePostCount}})")
                        raise RuntimeError(f"Queued save did not reach a visible receipt: {state}") from error
                    result = page.evaluate("chrome.storage.local.get(null).then(x=>({"
                        "posts:x.fixturePostCount,saveId:x['arena-block-editor-draft-v1']?.pending?.saveId,"
                        "phase:x['arena-block-editor-draft-v1']?.pending?.phase,"
                        "intentCount:Object.keys(x).filter(k=>k.startsWith('arena-block-browser-save-')).length,"
                        "title:x.fixturePayload?.title}))")
                    if result["posts"] != 1 or result["phase"] != "saved":
                        raise RuntimeError(f"Queued save did not verify: {result}")
                    if args.double_click and (result["intentCount"] != 1 or
                        page.evaluate("chrome.storage.local.get('fixturePrepareCount').then("
                            "x=>x.fixturePrepareCount)") != 1):
                        raise RuntimeError(f"Double-click began a second save intent: {result}")
                    if not page.evaluate("document.querySelector('#default-channel').disabled &&"
                        "document.querySelector('#default-channel').value==='one'"):
                        raise RuntimeError("Saved receipt no longer showed the frozen destination")
                    if args.edited_stale and result["title"] != "My edited title":
                        raise RuntimeError(f"Edited title was lost from queued save: {result}")
                    print(json.dumps({"fixture_only": True, "save_before_preview": True,
                        "popup_dismissed": True, "phase": result["phase"], "post_count": result["posts"],
                        "deferred_auth": args.deferred_auth, "edited_stale": args.edited_stale,
                        "double_click": args.double_click,
                        "live_write": False}))
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
