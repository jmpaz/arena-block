#!/usr/bin/env python3
"""Exercise media edits and draft restoration with a fictional X post in Chrome."""
import argparse
import json
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.parse
from pathlib import Path

from receive_chromium import CDP, get_json, wait_for


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--browser", required=True)
    parser.add_argument("--extension", type=Path, required=True)
    parser.add_argument("--first-use", action="store_true")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="arena-block-media-fixture-") as temp:
        root = Path(temp)
        extension = root / "extension"
        shutil.copytree(args.extension, extension)
        manifest = json.loads((extension / "manifest.json").read_text())
        manifest["host_permissions"] = [] if args.first_use else ["https://api.fxtwitter.com/*"]
        (extension / "manifest.json").write_text(json.dumps(manifest))
        profile = root / "profile"
        linux_flags = ["--no-sandbox", "--ozone-platform=headless"] if sys.platform == "linux" else []
        process = subprocess.Popen([args.browser, "--headless=new", "--disable-gpu", *linux_flags,
            "--no-first-run", "--no-default-browser-check", f"--user-data-dir={profile}",
            "--remote-debugging-port=0", "--remote-allow-origins=*", "about:blank"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
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
                source_url = "https://x.com/fixture/status/123"
                editor = f"chrome-extension://{extension_id}/editor.html?" + urllib.parse.urlencode({"source": source_url})
                target = get_json(base + "/json/new?about:blank", "PUT")
                page = CDP(target["webSocketDebuggerUrl"])
                try:
                    page.command("Page.enable")
                    fixture = """
                    (() => {
                      const original = globalThis.fetch.bind(globalThis);
                      globalThis.fetch = async (input, init) => {
                        const url = String(input);
                        if (!url.startsWith('https://api.fxtwitter.com/')) return original(input, init);
                        if (url.endsWith('/fixture/status/124')) return Response.json({tweet:{id:'124',
                          author:{screen_name:'fixture'},text:'Single image fixture',
                          created_at:'2026-10-11T00:00:00Z',media:{all:[
                            {type:'photo',url:'https://cdn.example.test/only.jpg',original_info:{width:800,height:600}}
                          ]}}});
                        if (!url.endsWith('/fixture/status/123')) throw new Error('Unexpected fixture read');
                        return Response.json({tweet:{id:'123',author:{screen_name:'fixture'},
                          text:'Fixture writing',created_at:'2026-10-11T00:00:00Z',media:{all:[
                            {type:'photo',url:'https://cdn.example.test/one.jpg',original_info:{width:800,height:600}},
                            {type:'photo',url:'https://cdn.example.test/two.jpg',original_info:{width:800,height:600}},
                            {type:'video',url:'https://cdn.example.test/video.mp4',
                             thumbnail_url:'https://cdn.example.test/poster.jpg',
                             original_info:{width:800,height:600},duration:5}
                          ]}}});
                      };
                    })();
                    """
                    page.command("Page.addScriptToEvaluateOnNewDocument", {"source": fixture})
                    page.command("Page.navigate", {"url": editor})
                    wait_for(lambda: page.evaluate("document.querySelector('#primary')?.value") == source_url)
                    if args.first_use:
                        wait_for(lambda: page.evaluate("document.querySelector('#preview-source')?.hidden===false"))
                        if not page.evaluate("document.querySelector('#composition-fields').hidden &&"
                            "document.querySelector('#preview-source').textContent==='Preview'"):
                            raise RuntimeError("Ungrantable social source lacks a visible Preview action")
                        print(json.dumps({"fixture_only": True, "ungranted_social_preview_visible": True,
                            "live_write": False}))
                        return
                    page.evaluate("document.querySelector('#thread-policy').value='off';"
                        "document.querySelector('#thread-policy').dispatchEvent(new Event('input',{bubbles:true}));"
                        "document.querySelector('#media-policy').value='all';"
                        "document.querySelector('#media-policy').dispatchEvent(new Event('input',{bubbles:true}))")
                    page.command("Runtime.evaluate", {"expression": "document.querySelector('#resolve').click()",
                        "userGesture": True})
                    try:
                        wait_for(lambda: page.evaluate("document.querySelectorAll('#media-list li').length") == 3)
                    except RuntimeError as error:
                        state = page.evaluate("({status:document.querySelector('#status').textContent,rows:document.querySelectorAll('#media-list li').length,kind:document.querySelector('#block-kind').textContent,fixture:String(fetch).includes('Unexpected fixture read')})")
                        raise RuntimeError(f"Fixture media did not render: {state}") from error
                    page.evaluate("document.querySelector('#composition > summary').click()")
                    if not page.evaluate("document.querySelector('#composition').open &&"
                        "document.querySelector('#media-list').getClientRects().length>0"):
                        raise RuntimeError("Media editing could not be disclosed")
                    page.evaluate("document.querySelector('#title').value='Edited title';"
                        "document.querySelector('#title').dispatchEvent(new Event('input',{bubbles:true}));"
                        "document.querySelector('#writing').value='Edited text';"
                        "document.querySelector('#writing').dispatchEvent(new Event('input',{bubbles:true}));"
                        "document.querySelector('#description').value='Edited description';"
                        "document.querySelector('#description').dispatchEvent(new Event('input',{bubbles:true}))")
                    page.evaluate('document.querySelector(`[aria-label="Move media 1.1 down"]`).focus();'
                        'document.querySelector(`[aria-label="Move media 1.1 down"]`).click()')
                    if page.evaluate("document.activeElement?.getAttribute('aria-label')") != "Move media 1.1 down":
                        raise RuntimeError("Media reorder lost keyboard focus")
                    moved = page.evaluate("[...document.querySelectorAll('#media-list li .media-meta strong')].map(e=>e.textContent).join(',')")
                    if moved != "Image · 1.2,Image · 1.1,Video · 1.3":
                        raise RuntimeError(f"Media order did not change: {moved}")
                    page.evaluate('document.querySelector(`[aria-label="Include media 1.2"]`).focus();'
                        'document.querySelector(`[aria-label="Include media 1.2"]`).click()')
                    if page.evaluate("document.activeElement?.getAttribute('aria-label')") != "Include media 1.2":
                        raise RuntimeError("Media toggle lost keyboard focus")
                    if page.evaluate("document.querySelector('#media-count').textContent") != "2 selected":
                        raise RuntimeError("Deselecting media after reorder failed")
                    page.evaluate('document.querySelector(`[aria-label="Use poster frame from video 1.3"]`).focus();'
                        'document.querySelector(`[aria-label="Use poster frame from video 1.3"]`).click()')
                    if page.evaluate("document.activeElement?.getAttribute('aria-label')") != "Use poster frame from video 1.3":
                        raise RuntimeError("Video poster choice lost keyboard focus")
                    if not page.evaluate('document.querySelector(`[aria-label="Use poster frame from video 1.3"]`).checked'):
                        raise RuntimeError("Video frame choice failed")
                    time.sleep(.5)
                    page.command("Page.reload")
                    wait_for(lambda: page.evaluate("document.querySelector('#title')?.value") == "Edited title")
                    expected = {
                        "writing": "Edited text", "description": "Edited description",
                        "media_count": "2 selected", "media_order": "Image · 1.1,Video · 1.3,Image · 1.2",
                    }
                    observed = {
                        "writing": page.evaluate("document.querySelector('#writing').value"),
                        "description": page.evaluate("document.querySelector('#description').value"),
                        "media_count": page.evaluate("document.querySelector('#media-count').textContent"),
                        "media_order": page.evaluate("[...document.querySelectorAll('#media-list li .media-meta strong')].map(e=>e.textContent).join(',')"),
                    }
                    if observed != expected or not page.evaluate(
                        'document.querySelector(`[aria-label="Use poster frame from video 1.3"]`).checked'):
                        raise RuntimeError(f"Media draft changed after reload: {observed}")
                    single_url = "https://x.com/fixture/status/124"
                    page.command("Page.navigate", {"url": f"chrome-extension://{extension_id}/editor.html?" +
                        urllib.parse.urlencode({"source": single_url})})
                    wait_for(lambda: page.evaluate("document.querySelector('#add-current')?.hidden === false"))
                    page.evaluate("document.querySelector('#new-capture').click()")
                    wait_for(lambda: page.evaluate("document.querySelector('#primary').value") == single_url)
                    wait_for(lambda: page.evaluate("document.querySelector('#single-media-toggle').hidden === false"))
                    if not page.evaluate("document.querySelector('#media-list').hidden"):
                        raise RuntimeError("Single image still has a redundant media list")
                    page.evaluate("document.querySelector('#single-media-toggle').click()")
                    if page.evaluate("document.querySelector('#single-media-toggle').getAttribute('aria-pressed')") != "false":
                        raise RuntimeError("Single image toggle did not change selection")
                    page.evaluate("document.querySelector('#new-capture').click()")
                    wait_for(lambda: page.evaluate("document.querySelector('#composition-fields').hidden === false"),
                        seconds=5)
                    if page.evaluate("document.querySelector('#single-media-toggle').getAttribute('aria-pressed')") != "true":
                        raise RuntimeError("New capture did not restore the social source's default media selection")
                    page.command("Page.navigate", {"url": f"chrome-extension://{extension_id}/editor.html?" +
                        urllib.parse.urlencode({"source": source_url})})
                    wait_for(lambda: page.evaluate("document.querySelector('#primary')?.value") == source_url)
                    wait_for(lambda: page.evaluate("document.querySelectorAll('#media-list li').length") == 3)
                    if page.evaluate("document.querySelector('#composition-fields').hidden"):
                        raise RuntimeError("Untouched draft did not yield to a newly opened social page")
                    print(json.dumps({"fixture_only": True, "title_text_description": True,
                        "media_reorder_then_deselect": True, "video_frame": True,
                        "draft_after_reload": True, "single_image_toggle": True, "live_write": False}))
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
