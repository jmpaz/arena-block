#!/usr/bin/env python3
"""Receive the built editor in an empty Chrome profile using retained public plans.

The actual editor HTML/CSS/JS are loaded unchanged. Browser APIs are fixtures,
HTTP(S) is blocked, and no extension is installed or permission requested.
"""
import argparse
import base64
import hashlib
import json
import subprocess
import tempfile
from pathlib import Path

from receive_chromium import CDP, get_json, wait_for

KEY = "arena-block-editor-draft-v1"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--browser", required=True)
    parser.add_argument("--extension", type=Path, required=True)
    parser.add_argument("--cases", type=Path, required=True, help="JSON array of {id, plan} public source fixtures")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    extension = args.extension.resolve()
    manifest_bytes = (extension / "manifest.json").read_bytes()
    cases = json.loads(args.cases.read_text())
    results = []
    with tempfile.TemporaryDirectory(prefix="arena-text-preview-chrome-") as temp:
        profile = Path(temp) / "profile"
        with (args.output / "chrome-stderr.log").open("wb") as log:
            process = subprocess.Popen([args.browser, "--headless=new", "--disable-gpu", "--no-first-run",
                "--no-default-browser-check", "--disable-background-networking", f"--user-data-dir={profile}",
                "--remote-debugging-port=0", "--remote-allow-origins=*", "about:blank"],
                stdout=subprocess.DEVNULL, stderr=log)
        try:
            active = profile / "DevToolsActivePort"
            wait_for(lambda: active.exists() or process.poll() is not None)
            if not active.exists():
                raise RuntimeError(f"Isolated Chrome exited: {process.returncode}")
            base = f"http://127.0.0.1:{int(active.read_text().splitlines()[0])}"
            target = get_json(base + "/json/new?about:blank", "PUT")
            page = CDP(target["webSocketDebuggerUrl"])
            try:
                page.command("Page.enable")
                page.command("Network.enable")
                page.command("Network.setBlockedURLs", {"urls": ["http://*", "https://*"]})
                page.command("Emulation.setDeviceMetricsOverride", {"width": 380, "height": 520,
                    "deviceScaleFactor": 1, "mobile": False})
                fixture = """
                (() => {
                  const calls = globalThis.fixtureCalls = [];
                  const blocked = name => async (...args) => { calls.push(name); throw Error('Blocked fixture action: '+name); };
                  globalThis.fixtureDraft = () => JSON.parse(localStorage.getItem('arena-block-editor-draft-v1'));
                  globalThis.browser = {
                    permissions: {contains: async () => false, request: blocked('permission request'),
                      onAdded:{addListener(){}},onRemoved:{addListener(){}}},
                    storage: {local: {
                      async get(key) {return {[key]:JSON.parse(localStorage.getItem(key) ?? 'null')};},
                      async set(values) {for (const [key,value] of Object.entries(values)) localStorage.setItem(key,JSON.stringify(value));},
                      async remove(key) {localStorage.removeItem(key);}},onChanged:{addListener(){}}},
                    runtime: {getManifest: () => (MANIFEST), getURL: path => new URL(path,location.href).href,
                      sendMessage: blocked('runtime message'),sendNativeMessage: blocked('native message')},
                    tabs:{query:async()=>[]},identity:{getRedirectURL:()=>'',launchWebAuthFlow:blocked('OAuth')}
                  };
                  globalThis.fetch = async input => {
                    if (String(input) === new URL('oauth-client.json',location.href).href) return Response.json({clientId:''});
                    calls.push('fetch '+String(input)); throw Error('No live fetch in text receiving');
                  };
                })();
                """.replace("MANIFEST", json.dumps(json.loads(manifest_bytes)))
                page.command("Page.addScriptToEvaluateOnNewDocument", {"source": fixture})
                page.command("Page.navigate", {"url": (extension / "editor.html").as_uri()})
                try:
                    wait_for(lambda: page.evaluate("typeof fixtureDraft === 'function' && !!document.querySelector('#quote-author-link')"))
                except RuntimeError as error:
                    state = page.evaluate("({url:location.href,body:document.body?.innerText,fixture:typeof fixtureDraft})")
                    raise RuntimeError(f"Editor fixture did not start: {state}") from error

                def draft():
                    return page.evaluate("fixtureDraft()")

                def load(value):
                    page.evaluate("localStorage.setItem(" + json.dumps(KEY) + "," + json.dumps(json.dumps(value)) + ")")
                    page.command("Page.reload")
                    wait_for(lambda: page.evaluate("document.querySelector('#block-preview')?.hidden === false"))

                def choose(value):
                    page.evaluate("document.querySelector('#quote-author-link').value=" + json.dumps(value) +
                        ";document.querySelector('#quote-author-link').dispatchEvent(new Event('change',{bubbles:true}))")
                    wait_for(lambda: (draft().get("quoteAuthorLink") or "") == value)

                def screenshot(name, end=False):
                    page.evaluate("{const viewport=document.querySelector('.viewport');viewport.scrollTop+=document.querySelector('#block-preview').getBoundingClientRect().top-viewport.getBoundingClientRect().top-12;const text=document.querySelector('#block-text-preview');text.scrollTop=" + ("text.scrollHeight" if end else "0") + "}")
                    shot = page.command("Page.captureScreenshot", {"format": "png", "captureBeyondViewport": False})
                    (args.output / name).write_bytes(base64.b64decode(shot["data"]))

                for case in cases:
                    plan = case["plan"]
                    value = {"primary": plan["block"]["canonicalSource"], "extras": "", "redditCaptures": [], "substackCaptures": [],
                        "media": "all", "thread": "off", "quote": "block", "depth": "full", "dates": "auto", "separator": "auto",
                        "plan": plan, "manualContentEdit": False, "manualFields": {}, "selectedChannels": []}
                    value["resolvedInput"] = json.dumps([value[k] for k in
                        ["primary", "extras", "media", "thread", "quote", "depth", "dates", "separator", "redditCaptures", "substackCaptures"]], separators=(",", ":"), ensure_ascii=False)
                    load(value)
                    assert draft()["plan"] == plan, "Legacy default changed the frozen plan"
                    assert "quoteAuthorLink" not in draft(), "Unset became an explicit setting"
                    original_text = page.evaluate("document.querySelector('#block-text-preview').innerText")
                    assert "](<" not in original_text
                    assert page.evaluate("document.querySelector('#block-text-preview blockquote') !== null")
                    representations = {}
                    for mode in ["source", "plain"]:
                        choose(mode)
                        current = draft()
                        assert current["plan"]["policy"]["quoteAuthorLink"] == mode
                        assert current["plan"]["sources"] == plan["sources"]
                        assert current["plan"]["block"]["selectedMedia"] == plan["block"]["selectedMedia"]
                        credits = page.evaluate("[...document.querySelectorAll('#block-text-preview a')].filter(a=>a.textContent.startsWith('@')).map(a=>a.href)")
                        assert bool(credits) == (mode == "source")
                        page.command("Page.reload")
                        wait_for(lambda: page.evaluate("document.querySelector('#quote-author-link')?.value") == mode)
                        wait_for(lambda: page.evaluate("document.querySelector('#block-preview')?.hidden === false"))
                        assert draft()["plan"] == current["plan"], "Reload changed the plan"
                        representations[mode] = page.evaluate("({text:document.querySelector('#block-text-preview').innerText,links:[...document.querySelectorAll('#block-text-preview a')].map(a=>({label:a.textContent,href:a.href})),nestedQuotes:document.querySelectorAll('#block-text-preview blockquote blockquote').length})")
                        screenshot(case["id"] + "-" + mode + ".png")
                        screenshot(case["id"] + "-" + mode + "-end.png", end=True)
                    assert representations["source"]["text"] == representations["plain"]["text"]
                    choose("")
                    assert draft()["plan"] == plan, "Returning to unset changed the legacy identity"
                    assert "quoteAuthorLink" not in draft()
                    if case["id"] == "348712218":
                        assert page.evaluate("!!document.querySelector('#block-text-preview blockquote blockquote')")
                        links = page.evaluate("[...document.querySelectorAll('#block-text-preview a')].map(a=>a.href)")
                        assert any("lucy-ives.com" in link for link in links)
                        assert any("colly.com" in link for link in links)
                    page.evaluate("document.querySelector('#writing').value='**Manual writing** with [authored link](https://example.org/mine)';document.querySelector('#writing').dispatchEvent(new Event('input',{bubbles:true}))")
                    choose("source")
                    assert draft()["plan"]["block"]["markdown"].startswith("**Manual writing**")
                    assert page.evaluate("document.querySelector('#block-text-preview strong')?.textContent") == "Manual writing"
                    assert page.evaluate("document.querySelector('#block-text-preview a')?.href") == "https://example.org/mine"
                    page.command("Emulation.setEmulatedMedia", {"features": [{"name": "prefers-color-scheme", "value": "dark"}]})
                    screenshot(case["id"] + "-edited-dark.png")
                    page.command("Emulation.setEmulatedMedia", {"features": []})
                    # A retained unfinished save stays immutable, even if an event
                    # is dispatched programmatically to the disabled control.
                    frozen = draft()
                    frozen["pending"] = {"saveId": "fixture-held-save", "planHash": frozen["plan"]["hash"],
                        "destinations": [], "phase": "unknown", "method": "native"}
                    load(frozen)
                    assert page.evaluate("document.querySelector('#quote-author-link').disabled")
                    page.evaluate("document.querySelector('#quote-author-link').value='plain';document.querySelector('#quote-author-link').dispatchEvent(new Event('change',{bubbles:true}))")
                    assert draft()["plan"] == frozen["plan"]
                    assert draft()["pending"] == frozen["pending"]
                    assert page.evaluate("document.querySelector('#quote-author-link').value") == "source"
                    # No pending status or source operation can reach a real helper.
                    calls = page.evaluate("fixtureCalls")
                    assert all(call in ["native message"] for call in calls), calls
                    frozen.pop("pending")
                    load(frozen)
                    page.evaluate("document.querySelector('#primary').value='unfinished';document.querySelector('#primary').dispatchEvent(new Event('input',{bubbles:true}))")
                    assert page.evaluate("document.querySelector('#block-preview').hidden")
                    assert page.evaluate("document.querySelector('#block-text-preview').textContent") == ""
                    page.evaluate("document.querySelector('#new-capture').click()")
                    assert page.evaluate("document.querySelector('#quote-author-link').value") == ""
                    assert page.evaluate("document.querySelector('#block-preview').hidden")
                    results.append({"id": case["id"], "legacy_identity": True, "source_plain_unset": True,
                        "reload_retention": True, "manual_edit_retained": True, "pending_save_immutable": True,
                        "stale_preview_cleared": True, "new_capture_unset": True, "representations": representations})
                load(value)
                hostile = '<img src="https://tracking.invalid/pixel" onerror="globalThis.fixtureAttack=true">\n\n[unsafe](javascript:alert%281%29) [obfuscated](java&#x73;cript:alert%281%29)\n\n**Safe text** &lt;script&gt;bad&lt;/script&gt;'
                page.evaluate("document.querySelector('#writing').value=" + json.dumps(hostile) + ";document.querySelector('#writing').dispatchEvent(new Event('input',{bubbles:true}))")
                assert page.evaluate("document.querySelector('#block-text-preview').querySelectorAll('img,script,svg,iframe,a').length") == 0
                assert page.evaluate("globalThis.fixtureAttack === undefined")
                assert page.evaluate("document.querySelector('#block-text-preview strong').textContent") == "Safe text"
                assert page.evaluate("fixtureCalls") == []
                report = {"cases": results, "built_editor": True, "browser_api_fixture": True,
                    "manifestSHA256": hashlib.sha256(manifest_bytes).hexdigest(), "manifestUnchanged": (extension / "manifest.json").read_bytes() == manifest_bytes,
                    "httpBlocked": True, "hostileMarkdownInert": True, "extensionInstalled": False, "permissionRequests": 0, "publication": False}
                (args.output / "receiving.json").write_text(json.dumps(report, indent=2) + "\n")
                print(json.dumps(report))
            finally:
                page.close()
        finally:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=3)


if __name__ == "__main__":
    main()
