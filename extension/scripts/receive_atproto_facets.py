#!/usr/bin/env python3
"""Receive ATProto facet composition in disposable Chrome and Firefox profiles."""
import argparse
import copy
import json
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.parse
import zipfile
from pathlib import Path

from receive_chromium import CDP, get_json, wait_for
from receive_firefox import BiDi, free_port


ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "tests/fixtures/atproto-facets"
SOURCE = "https://bsky.app/profile/did:plc:pu2ln7ey5emgy37ovouqnncg/post/3mxk2eqkcks2d"
LABEL_SOURCE = "https://bsky.app/profile/did:plc:fixture/post/3facetlabel"
DELVE_SOURCE = "https://delve.town/profile/did:plc:2vb3emjr2ttkwc2dj534fdqj/post/3mxjqkycz7c2e"
TARGET = "https://reference.example/ref_001"
DELVE_TARGET = "https://reference.example/ref_002"
# The editor sets quote depth and dates explicitly. Source-only composition
# leaves those fields absent, so equivalent selections can have different hashes.
EXPANDED_HASH = "af37d552ea4cfcbf4308c8fd011d64a5ee7419e7a8f76a03fa6441ee5ae13fe7"
KEY = "arena-block-editor-draft-v1"


def fixture_script():
    packet = json.loads((FIXTURES / "bluesky-url-packets.json").read_text())[0]
    delve_packet = json.loads((FIXTURES / "delve-url-quote-card-packets.json").read_text())[0]
    synthetic = copy.deepcopy(json.loads(packet["body"]))
    post = synthetic["thread"]["post"]
    post["uri"] = "at://did:plc:fixture/app.bsky.feed.post/3facetlabel"
    post["cid"] = "fixture-cid"
    post["author"] = {"did": "did:plc:fixture", "handle": "fixture.test"}
    post["record"] = {
        "$type": "app.bsky.feed.post", "text": "Read the background",
        "createdAt": "2026-10-11T00:00:00Z",
        "facets": [{"index": {"byteStart": 5, "byteEnd": 19}, "features": [
            {"$type": "app.bsky.richtext.facet#link", "uri": TARGET}]}],
    }
    post.pop("embed", None)
    return """
(() => {
  const packet = PACKET;
  const delvePacket = DELVE_PACKET;
  const synthetic = SYNTHETIC;
  const original = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith('https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?')) {
      if (init?.credentials !== 'omit') throw new Error('Bluesky request included credentials');
      const uri = new URL(url).searchParams.get('uri');
      const body = uri?.endsWith('/3facetlabel') ? synthetic :
        url === packet.url ? JSON.parse(packet.body) : null;
      if (!body) throw new Error('Unexpected ATProto fixture read: ' + url);
      return Response.json(body);
    }
    if (url.startsWith('https://api.delve.town/xrpc/town.delve.feed.getPostThread?')) {
      if (init?.credentials !== 'omit') throw new Error('Delve request included credentials');
      if (url !== delvePacket.url) throw new Error('Unexpected Delve fixture read: ' + url);
      return Response.json(JSON.parse(delvePacket.body));
    }
    if (/^https?:/.test(url)) throw new Error('Fixture blocks external requests: ' + url);
    return original(input, init);
  };
})();
""".replace("DELVE_PACKET", json.dumps(delve_packet)).replace("PACKET", json.dumps(packet)).replace("SYNTHETIC", json.dumps(synthetic))


def legacy_draft():
    plan = json.loads((FIXTURES / "bluesky-url-legacy-plan.json").read_text())
    fields = [SOURCE, "", "all", "off", "block", "2", "auto", "auto"]
    return {"primary": SOURCE, "extras": "", "media": "all", "thread": "off",
        "quote": "block", "depth": "2", "dates": "auto", "separator": "auto",
        "plan": plan, "resolvedInput": json.dumps(fields, separators=(",", ":")),
        "manualContentEdit": False, "manualFields": {}}


def run_checks(evaluate, reload_page, navigate, source_page):
    wait_for(lambda: evaluate("document.querySelector('#primary')?.value") == SOURCE)
    # A restored old draft keeps its old preview until the user refreshes it.
    evaluate("document.querySelector('#source-details > summary').click()")
    wait_for(lambda: "Epic_Sy..." in (evaluate("document.querySelector('#writing')?.value") or ""))
    old = json.loads(evaluate(f"(globalThis.browser ?? globalThis.chrome).storage.local.get('{KEY}').then(x=>JSON.stringify(x['{KEY}'].plan))"))
    if old["sources"][0].get("facets") or TARGET in old["block"]["markdown"]:
        raise RuntimeError("Legacy draft was unexpectedly modified before refresh")
    evaluate("document.querySelector('#resolve').click()")
    wait_for(lambda: TARGET in (evaluate("document.querySelector('#writing')?.value") or ""))
    wait_for(lambda: TARGET in (evaluate(f"(globalThis.browser ?? globalThis.chrome).storage.local.get('{KEY}').then(x=>x['{KEY}'].plan?.block.markdown)") or ""))
    fresh = json.loads(evaluate(f"(globalThis.browser ?? globalThis.chrome).storage.local.get('{KEY}').then(x=>JSON.stringify(x['{KEY}'].plan))"))
    if fresh["hash"] != EXPANDED_HASH or fresh["sources"][0]["text"] != old["sources"][0]["text"]:
        raise RuntimeError(f"Refreshed plan hash or raw source text diverged: hash={fresh['hash']} old_text={old['sources'][0]['text']!r} fresh_text={fresh['sources'][0]['text']!r}")
    if not fresh["sources"][0].get("facets") or not fresh["sources"][0].get("atproto"):
        raise RuntimeError("ATProto source provenance was lost")
    if fresh["block"]["markdown"].count(TARGET) != 1:
        raise RuntimeError("Full target was not composed exactly once")
    evaluate("document.querySelector('#composition > summary').click()")
    evaluate("document.querySelector('#title').value='Facet title edit';"
        "document.querySelector('#title').dispatchEvent(new Event('input',{bubbles:true}));"
        "document.querySelector('#description').value='Facet description edit';"
        "document.querySelector('#description').dispatchEvent(new Event('input',{bubbles:true}))")
    wait_for(lambda: evaluate(f"(globalThis.browser ?? globalThis.chrome).storage.local.get('{KEY}').then(x=>x['{KEY}'].plan?.block.title)") == "Facet title edit")
    edited = json.loads(evaluate(f"(globalThis.browser ?? globalThis.chrome).storage.local.get('{KEY}').then(x=>JSON.stringify(x['{KEY}'].plan))"))
    if edited["hash"] == fresh["hash"] or edited["sources"] != fresh["sources"] or edited["block"]["markdown"] != fresh["block"]["markdown"]:
        raise RuntimeError("Title/description edit changed source provenance or facet Markdown")
    reload_page()
    wait_for(lambda: evaluate("document.querySelector('#title')?.value") == "Facet title edit")
    if TARGET not in evaluate("document.querySelector('#writing').value"):
        raise RuntimeError("Expanded Markdown did not survive editor restart")
    navigate(source_page(LABEL_SOURCE))
    wait_for(lambda: evaluate("document.querySelector('#add-current')?.hidden===false"))
    evaluate("document.querySelector('#new-capture').click()")
    wait_for(lambda: evaluate("document.querySelector('#primary')?.value") == LABEL_SOURCE)
    wait_for(lambda: "[the background]" in (evaluate("document.querySelector('#writing')?.value") or ""))
    label = evaluate("document.querySelector('#writing').value")
    if label != f"Read [the background](<{TARGET}>)":
        raise RuntimeError(f"Meaningful label did not render as a link: {label}")
    label_plan = json.loads(evaluate(f"(globalThis.browser ?? globalThis.chrome).storage.local.get('{KEY}').then(x=>JSON.stringify(x['{KEY}'].plan))"))
    if label_plan["sources"][0]["text"] != "Read the background" or not label_plan["sources"][0].get("atproto"):
        raise RuntimeError("Synthetic label source provenance was lost")
    navigate(source_page(DELVE_SOURCE))
    wait_for(lambda: evaluate("document.querySelector('#primary')?.value") == DELVE_SOURCE or
        evaluate("document.querySelector('#add-current')?.hidden===false"))
    if evaluate("document.querySelector('#primary')?.value") != DELVE_SOURCE:
        evaluate("document.querySelector('#new-capture').click()")
    wait_for(lambda: evaluate("document.querySelector('#primary')?.value") == DELVE_SOURCE)
    evaluate("document.querySelector('#thread-policy').value='off';"
        "document.querySelector('#thread-policy').dispatchEvent(new Event('input',{bubbles:true}))")
    wait_for(lambda: evaluate("document.querySelector('#resolve').disabled") is False)
    evaluate("document.querySelector('#resolve').click()")
    try:
        wait_for(lambda: DELVE_TARGET in (evaluate("document.querySelector('#writing')?.value") or ""))
    except RuntimeError as error:
        state = evaluate("JSON.stringify({primary:document.querySelector('#primary').value,"
            "status:document.querySelector('#status').textContent,"
            "writing:document.querySelector('#writing').value,"
            "resolve:document.querySelector('#resolve').textContent})")
        raise RuntimeError(f"Delve browser fixture did not resolve: {state}") from error
    wait_for(lambda: DELVE_TARGET in (evaluate(f"(globalThis.browser ?? globalThis.chrome).storage.local.get('{KEY}').then(x=>x['{KEY}'].plan?.block.markdown)") or ""))
    delve = json.loads(evaluate(f"(globalThis.browser ?? globalThis.chrome).storage.local.get('{KEY}').then(x=>JSON.stringify(x['{KEY}'].plan))"))
    raw_record = json.loads(json.loads((FIXTURES / "delve-url-quote-card-packets.json").read_text())[0]["body"])["thread"]["post"]["record"]
    if delve["sources"][0]["text"] != raw_record["text"] or delve["sources"][0]["atproto"]["record"] != raw_record:
        raise RuntimeError("Delve raw record changed during browser capture")
    if not delve["sources"][0].get("facets") or not delve["sources"][0].get("atproto"):
        raise RuntimeError("Delve facet source provenance was lost")
    if DELVE_TARGET not in delve["block"]["markdown"]:
        raise RuntimeError("Delve full URL did not render")
    return {"fixture_only": True, "cached_refresh": True, "full_url": True,
        "meaningful_label": True, "delve_quote_card": True, "provenance": True, "edit_and_reload": True,
        "live_write": False}


def chrome(args):
    with tempfile.TemporaryDirectory(prefix="arena-block-atproto-chrome-") as temp:
        root = Path(temp)
        extension = root / "extension"
        shutil.copytree(args.extension, extension)
        manifest = json.loads((extension / "manifest.json").read_text())
        manifest["host_permissions"] = ["https://public.api.bsky.app/*", "https://api.delve.town/*"]
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
            base = f"http://127.0.0.1:{int(active.read_text().splitlines()[0])}"
            browser = CDP(get_json(base + "/json/version")["webSocketDebuggerUrl"])
            try:
                extension_id = browser.command("Extensions.loadUnpacked", {"path": str(extension)})["id"]
                target = get_json(base + "/json/new?about:blank", "PUT")
                page = CDP(target["webSocketDebuggerUrl"])
                try:
                    page.command("Page.enable")
                    page.command("Page.addScriptToEvaluateOnNewDocument", {"source": fixture_script()})
                    url = lambda source: f"chrome-extension://{extension_id}/editor.html?" + urllib.parse.urlencode({"source": source})
                    page.command("Page.navigate", {"url": url(SOURCE)})
                    wait_for(lambda: page.evaluate("document.querySelector('#primary')?.value") == SOURCE)
                    page.evaluate(f"chrome.storage.local.set({{{json.dumps(KEY)}:{json.dumps(legacy_draft())}}})")
                    page.command("Page.reload")
                    result = run_checks(page.evaluate, lambda: page.command("Page.reload"),
                        lambda address: page.command("Page.navigate", {"url": address}), url)
                    print(json.dumps({"browser": "chrome", **result}))
                finally:
                    page.close()
            finally:
                browser.close()
        finally:
            process.terminate()
            try: process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill(); process.wait(timeout=3)


def firefox(args):
    port = free_port()
    with tempfile.TemporaryDirectory(prefix="arena-block-atproto-firefox-") as temp:
        root = Path(temp)
        archive = root / "arena-block-atproto-test.xpi"
        editor_path = "editor.html?" + urllib.parse.urlencode({"source": SOURCE})
        bootstrap = "\nconst testBrowser = globalThis.browser ?? globalThis.chrome;\n" \
            + "testBrowser.runtime.onInstalled.addListener(async () => {\n" \
            + "  await testBrowser.storage.local.set({" + json.dumps(KEY) + ":" + json.dumps(legacy_draft()) + "});\n" \
            + f"  await testBrowser.tabs.create({{url:testBrowser.runtime.getURL({json.dumps(editor_path)})}});\n" \
            + "});\n"
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as output:
            for source in args.extension.resolve().rglob("*"):
                if not source.is_file():
                    continue
                name = source.relative_to(args.extension.resolve())
                if source.name == "manifest.json":
                    manifest = json.loads(source.read_text())
                    manifest["host_permissions"] = ["https://public.api.bsky.app/*", "https://api.delve.town/*"]
                    output.writestr(str(name), json.dumps(manifest))
                elif source.name == "background.js":
                    output.writestr(str(name), source.read_text() + bootstrap)
                elif source.name == "editor.js":
                    output.writestr(str(name), fixture_script() + "\n" + source.read_text())
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
                    page = wait_for(editor_context)
                    context = page["context"]
                    url = lambda source: page["url"].split("?", 1)[0] + "?" + urllib.parse.urlencode({"source": source})
                    result = run_checks(lambda expression: bidi.evaluate(context, expression),
                        lambda: bidi.command("browsingContext.reload", {"context": context, "wait": "complete"}),
                        lambda address: bidi.command("browsingContext.navigate", {"context": context,
                            "url": address, "wait": "complete"}), url)
                    print(json.dumps({"browser": "firefox", **result}))
                finally:
                    bidi.close()
            finally:
                process.terminate()
                try: process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill(); process.wait(timeout=3)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--browser", required=True)
    parser.add_argument("--extension", type=Path, required=True)
    parser.add_argument("--family", choices=["chrome", "firefox"], required=True)
    options = parser.parse_args()
    {"chrome": chrome, "firefox": firefox}[options.family](options)
