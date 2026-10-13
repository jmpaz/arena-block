#!/usr/bin/env python3
"""Exercise fictional media edits in a temporary Firefox extension and profile."""
import argparse
import json
import subprocess
import tempfile
import time
import urllib.parse
import zipfile
from pathlib import Path

from receive_firefox import BiDi, free_port


SOURCE = "https://x.com/fixture/status/123"
SINGLE = "https://x.com/fixture/status/124"
FETCH_FIXTURE = r"""
(() => {
  const original = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith('https://api.are.na/')) throw new Error('Fixture blocks Are.na requests');
    if (!url.startsWith('https://api.fxtwitter.com/')) return original(input, init);
    if (url.endsWith('/fixture/status/124')) return Response.json({tweet:{id:'124',
      author:{screen_name:'fixture'},text:'Single image fixture',
      created_at:'2026-10-11T00:00:00Z',media:{all:[
        {type:'photo',url:'https://cdn.example.test/only.jpg',original_info:{width:800,height:600}}
      ]}}});
    if (!url.endsWith('/fixture/status/123')) throw new Error('Unexpected fixture read: '+url);
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


def wait_for_state(bidi, context, expression, seconds=10):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        value = bidi.evaluate(context, expression)
        if value:
            return value
        time.sleep(.1)
    raise RuntimeError(f"Firefox media fixture timed out: {expression}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--browser", required=True)
    parser.add_argument("--extension", type=Path, required=True)
    args = parser.parse_args()
    port = free_port()
    with tempfile.TemporaryDirectory(prefix="arena-block-firefox-media-") as temp:
        root = Path(temp)
        archive = root / "arena-block-media-test.xpi"
        editor_path = "editor.html?" + urllib.parse.urlencode({"source": SOURCE})
        bootstrap = "\nconst testBrowser = globalThis.browser ?? globalThis.chrome;\n" \
            + "testBrowser.runtime.onInstalled.addListener(async () => {\n" \
            + "  await testBrowser.storage.local.set({'arena-block-editor-draft-v1':" \
            + json.dumps({"primary": SOURCE, "media": "all", "thread": "off"}) + "});\n" \
            + f"  await testBrowser.tabs.create({{url:testBrowser.runtime.getURL({json.dumps(editor_path)})}});\n" \
            + "});\n"
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as output:
            for source in args.extension.resolve().rglob("*"):
                if not source.is_file():
                    continue
                name = source.relative_to(args.extension.resolve())
                if source.name == "manifest.json":
                    manifest = json.loads(source.read_text())
                    manifest["host_permissions"] = ["https://api.fxtwitter.com/*"]
                    output.writestr(str(name), json.dumps(manifest))
                elif source.name == "background.js":
                    output.writestr(str(name), source.read_text() + bootstrap)
                elif source.name == "editor.js":
                    output.writestr(str(name), FETCH_FIXTURE + "\n" + source.read_text())
                else:
                    output.write(source, name)
        profile = root / "profile"
        profile.mkdir()
        (profile / "user.js").write_text('user_pref("toolkit.telemetry.enabled", false);\n'
            'user_pref("datareporting.healthreport.uploadEnabled", false);\n'
            'user_pref("app.normandy.enabled", false);\n')
        log = profile / "remote.log"
        with log.open("wb") as stderr:
            process = subprocess.Popen([args.browser, "--headless", "--no-remote", "--profile", str(profile),
                "--remote-debugging-port", str(port), "-remote-allow-system-access", "about:blank"],
                stdout=subprocess.DEVNULL, stderr=stderr)
            try:
                deadline = time.monotonic() + 15
                while time.monotonic() < deadline and process.poll() is None:
                    if "WebDriver BiDi listening" in log.read_text(errors="replace"):
                        break
                    time.sleep(.15)
                else:
                    raise RuntimeError("Temporary Firefox BiDi agent did not start")
                bidi = BiDi(f"ws://127.0.0.1:{port}/session", origin=None)
                try:
                    bidi.command("session.new", {"capabilities": {"alwaysMatch": {"webSocketUrl": True}}})
                    bidi.command("webExtension.install", {"extensionData": {
                        "type": "archivePath", "path": str(archive)}})
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
                        raise RuntimeError("Temporary Firefox media editor did not open")
                    context = page["context"]
                    wait_for_state(bidi, context, f"document.querySelector('#primary')?.value==={json.dumps(SOURCE)}")
                    bidi.evaluate(context, "document.querySelector('#resolve').click()")
                    wait_for_state(bidi, context, "document.querySelectorAll('#media-list li').length===3")
                    if bidi.evaluate(context, "document.querySelector('#composition').open"):
                        raise RuntimeError("Media editing was not disclosed by default")
                    bidi.evaluate(context, "document.querySelector('#composition > summary').click()")
                    if not bidi.evaluate(context, "document.querySelector('#composition').open && "
                        "document.querySelector('#media-list').getClientRects().length>0"):
                        raise RuntimeError("Firefox media editing could not be disclosed")
                    bidi.evaluate(context, "document.querySelector('#title').value='Edited title';"
                        "document.querySelector('#title').dispatchEvent(new Event('input',{bubbles:true}));"
                        "document.querySelector('#writing').value='Edited text';"
                        "document.querySelector('#writing').dispatchEvent(new Event('input',{bubbles:true}));"
                        "document.querySelector('#description').value='Edited description';"
                        "document.querySelector('#description').dispatchEvent(new Event('input',{bubbles:true}))")
                    bidi.evaluate(context, 'document.querySelector(`[aria-label="Move media 1.1 down"]`).click()')
                    moved = bidi.evaluate(context,
                        "[...document.querySelectorAll('#media-list li .media-meta strong')].map(e=>e.textContent).join(',')")
                    if moved != "Image · 1.2,Image · 1.1,Video · 1.3":
                        raise RuntimeError(f"Firefox media order did not change: {moved}")
                    bidi.evaluate(context, 'document.querySelector(`[aria-label="Include media 1.2"]`).click()')
                    if bidi.evaluate(context, "document.querySelector('#media-count').textContent") != "2 selected":
                        raise RuntimeError("Firefox media deselection failed")
                    bidi.evaluate(context, 'document.querySelector(`[aria-label="Use poster frame from video 1.3"]`).click()')
                    if not bidi.evaluate(context,
                        'document.querySelector(`[aria-label="Use poster frame from video 1.3"]`).checked'):
                        raise RuntimeError("Firefox video poster choice failed")
                    time.sleep(.5)
                    bidi.command("browsingContext.reload", {"context": context, "wait": "complete"})
                    wait_for_state(bidi, context, "document.querySelector('#title')?.value==='Edited title'")
                    observed = json.loads(bidi.evaluate(context, "JSON.stringify({"
                        "writing:document.querySelector('#writing').value,"
                        "description:document.querySelector('#description').value,"
                        "media_count:document.querySelector('#media-count').textContent,"
                        "media_order:[...document.querySelectorAll('#media-list li .media-meta strong')]"
                        ".map(e=>e.textContent).join(',')})"))
                    expected = {"writing": "Edited text", "description": "Edited description",
                        "media_count": "2 selected", "media_order": "Image · 1.1,Video · 1.3,Image · 1.2"}
                    if observed != expected or not bidi.evaluate(context,
                        'document.querySelector(`[aria-label="Use poster frame from video 1.3"]`).checked'):
                        raise RuntimeError(f"Firefox media draft changed after reload: {observed}")
                    if not bidi.evaluate(context, "document.querySelector('#save').getBoundingClientRect().bottom<=innerHeight"):
                        raise RuntimeError("Save footer is clipped while Firefox media editor is open")
                    bidi.command("browsingContext.navigate", {"context": context,
                        "url": page["url"].split("?", 1)[0] + "?" + urllib.parse.urlencode({"source": SINGLE}),
                        "wait": "complete"})
                    wait_for_state(bidi, context, "document.querySelector('#add-current')?.hidden===false")
                    bidi.evaluate(context, "document.querySelector('#new-capture').click()")
                    wait_for_state(bidi, context, f"document.querySelector('#primary').value==={json.dumps(SINGLE)}")
                    wait_for_state(bidi, context, "document.querySelector('#single-media-toggle').hidden===false")
                    if not bidi.evaluate(context, "document.querySelector('#media-list').hidden"):
                        raise RuntimeError("Firefox single image still has a redundant media list")
                    bidi.evaluate(context, "document.querySelector('#composition > summary').click();"
                        "document.querySelector('#single-media-toggle').click()")
                    if bidi.evaluate(context,
                        "document.querySelector('#single-media-toggle').getAttribute('aria-pressed')") != "false":
                        raise RuntimeError("Firefox single-image toggle did not change selection")
                    bidi.command("browsingContext.navigate", {"context": context,
                        "url": page["url"], "wait": "complete"})
                    wait_for_state(bidi, context, f"document.querySelector('#primary')?.value==={json.dumps(SOURCE)}")
                    wait_for_state(bidi, context, "document.querySelectorAll('#media-list li').length===3")
                    if bidi.evaluate(context, "document.querySelector('#composition-fields').hidden"):
                        raise RuntimeError("Firefox untouched draft did not yield to a new social page")
                    print(json.dumps({"fixture_only": True, "title_text_description": True,
                        "media_reorder_then_deselect": True, "video_frame": True,
                        "draft_after_reload": True, "single_image_toggle": True,
                        "footer_visible": True, "live_write": False}))
                finally:
                    bidi.close()
            finally:
                process.terminate()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()


if __name__ == "__main__":
    main()
