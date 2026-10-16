import { expect, test } from "bun:test";
import { createDocument } from "@mixmark-io/domino";
import { CAPTURE_ORIGINS, captureAccessScope, permissionManifest, type PermissionRequest } from "../extension/permission-policy.ts";
import { CaptureAccess, renderCaptureAccess, type AccessState } from "../extension/src/capture-access.ts";
import { requiredOrigins } from "../extension/src/core.ts";

const manifest = permissionManifest("named-sources", true, ["https://mastodon.social", "https://fosstodon.org"]);
const html = await Bun.file(new URL("../extension/src/editor.html", import.meta.url)).text();
function fixture() {
  const document = createDocument(html);
  const button = document.getElementById("allow-capture-access") as unknown as HTMLButtonElement;
  const status = document.getElementById("capture-access-status") as unknown as HTMLElement;
  const origins = document.getElementById("capture-access-origins") as unknown as HTMLElement;
  const unavailable = document.getElementById("capture-access-unavailable") as unknown as HTMLElement;
  const requests: PermissionRequest[] = [];
  const granted = new Set<string>();
  const states: AccessState[] = [];
  let selected: string[] = [];
  const api = {
    contains: async (value: PermissionRequest) => [...(value.permissions ?? []), ...(value.origins ?? [])].every(name => granted.has(name)),
    request: (value: PermissionRequest) => { requests.push(structuredClone(value)); return Promise.resolve(false); },
  };
  const access = new CaptureAccess(api, manifest, () => selected, state => {
    states.push(state); renderCaptureAccess(state, button, status, origins, unavailable);
  });
  button.addEventListener("click", () => { void access.requestFromClick(); });
  return { access, api, requests, granted, states, button, status, origins, unavailable,
    select: (value: string[]) => { selected = value; } };
}

test("common named-source manifest has five APIs and no unrestricted host declaration", () => {
  expect(manifest.permissions).toEqual(["activeTab", "storage", "identity"]);
  expect(manifest.optional_permissions).toEqual(["nativeMessaging", "scripting"]);
  expect(manifest.optional_host_permissions).toEqual([...CAPTURE_ORIGINS, "https://fosstodon.org/*", "https://mastodon.social/*"]);
  expect(permissionManifest("legacy", true, []).optional_host_permissions).toEqual(["https://*/*"]);
  for (const origin of ["https://*.example.com", "http://mastodon.social", "https://user@mastodon.social", "https://mastodon.social/", "https://mastodon.social:444", "https://mastodon.social?x=1"])
    expect(() => permissionManifest("named-sources", true, [origin])).toThrow();
});

test("Mastodon scope includes only selected declared instances and keeps unknown instances out of the request", () => {
  expect(captureAccessScope(manifest).request.origins).toEqual([...CAPTURE_ORIGINS]);
  const scope = captureAccessScope(manifest, ["https://fosstodon.org", "https://new.example", "http://mastodon.social"]);
  expect(scope.request.origins).toEqual([...CAPTURE_ORIGINS, "https://fosstodon.org/*"]);
  expect(scope.unavailableOrigins).toEqual(["https://new.example/*", "http://mastodon.social/*"]);
  expect(permissionManifest("named-sources", false, []).optional_permissions).toEqual(["nativeMessaging"]);
});

test("provider preflight origins remain within the named manifest", () => {
  for (const ref of ["https://x.com/test/status/1234567890", "https://bsky.app/profile/a.test/post/3abc", "https://www.reddit.com/r/test/comments/abc123/title/", "https://news.ycombinator.com/item?id=1", "https://lobste.rs/s/abc123/title#c_abc123", "https://soundcloud.com/test/track", "https://www.lesswrong.com/posts/abcdefghijk/title"])
    for (const origin of requiredOrigins([ref])) expect(manifest.optional_host_permissions).toContain(origin);
});

test("opening setup reads grants and never prompts; an already enabled click does not request again", async () => {
  const f = fixture();
  await f.access.refresh();
  expect(f.access.state?.phase).toBe("missing");
  expect(f.requests).toEqual([]);
  for (const item of ["nativeMessaging", "scripting", ...CAPTURE_ORIGINS]) f.granted.add(item);
  await f.access.refresh();
  expect(f.button.disabled).toBe(true);
  expect(f.status.textContent).toBe("Capture access is enabled.");
  await f.access.requestFromClick();
  expect(f.requests).toEqual([]);
});

test("one direct gesture requests both APIs and exact sites before any asynchronous read", async () => {
  const f = fixture(); f.select(["https://mastodon.social"]);
  let finish: (value: boolean) => void = () => {};
  f.api.request = value => { f.requests.push(structuredClone(value)); return new Promise(resolve => { finish = resolve; }); };
  const running = f.access.requestFromClick();
  expect(f.requests).toEqual([{ permissions: ["nativeMessaging", "scripting"], origins: [...CAPTURE_ORIGINS, "https://mastodon.social/*"] }]);
  await f.access.requestFromClick();
  expect(f.requests).toHaveLength(1);
  expect(f.button.disabled).toBe(true);
  for (const item of ["nativeMessaging", "scripting", ...CAPTURE_ORIGINS, "https://mastodon.social/*"]) f.granted.add(item);
  finish(true); await running;
  expect(f.access.state?.phase).toBe("enabled");
  expect(f.requests).toHaveLength(1);
});

test("decline preserves partial grants and never automatically retries", async () => {
  const f = fixture(); f.granted.add("nativeMessaging");
  await f.access.requestFromClick();
  expect(f.access.state?.phase).toBe("partial");
  expect(f.access.state?.granted).toEqual(["nativeMessaging"]);
  expect(f.requests).toHaveLength(1);
  await f.access.refresh();
  expect(f.requests).toHaveLength(1);
  expect(f.button.disabled).toBe(false);
  const g = fixture(); await g.access.requestFromClick();
  expect(g.access.state?.phase).toBe("declined");
  expect(g.status.textContent).toContain("not granted");
});

test("a true request result cannot claim success without readback; failures stay unknown", async () => {
  const f = fixture(); f.api.request = async value => { f.requests.push(value); return true; };
  await f.access.requestFromClick();
  expect(f.access.state?.phase).toBe("missing");
  f.api.contains = async () => { throw new Error("permission read unavailable"); };
  f.api.request = () => { throw new Error("no gesture"); };
  await f.access.requestFromClick();
  expect(f.access.state?.phase).toBe("unknown");
  expect(f.access.state?.unknown.length).toBe(15);
  expect(f.status.textContent).toContain("Could not verify");
});

test("changed instance selection refreshes scope without a request and reports undeclared instances", async () => {
  const f = fixture();
  for (const item of ["nativeMessaging", "scripting", ...CAPTURE_ORIGINS]) f.granted.add(item);
  await f.access.refresh();
  f.select(["https://fosstodon.org"]); await f.access.refresh();
  expect(f.access.state?.phase).toBe("partial");
  expect(f.origins.textContent).toContain("https://fosstodon.org/*");
  expect(f.origins.textContent).not.toContain("https://mastodon.social/*");
  f.select(["https://new.example"]); await f.access.refresh();
  expect(f.unavailable.hidden).toBe(false);
  expect(f.unavailable.textContent).toContain("local helper");
  expect(f.requests).toEqual([]);
});

test("editor permission requests are confined to the explicit setup controller", async () => {
  const editor = await Bun.file(new URL("../extension/src/editor.ts", import.meta.url)).text();
  expect(editor).not.toContain("browser.permissions.request(");
  expect(editor).toContain('$("allow-capture-access").addEventListener("click", () => { void captureAccess.requestFromClick(); });');
});
