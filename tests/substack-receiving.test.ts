import { expect, test } from "bun:test";
import { createDocument } from "@mixmark-io/domino";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createContext, runInContext, runInNewContext } from "node:vm";
import { createHash } from "node:crypto";
import { readSubstackPage } from "../packages/core/substack-page.ts";
import { normalizeSubstackCapture, requireRetainedSubstackCaptures } from "../packages/core/substack-record.ts";
import { SubstackProvider } from "../packages/core/providers/substack.ts";
import { XProvider } from "../packages/core/providers/x.ts";
import { SocialResolver } from "../packages/core/providers/index.ts";
import { parseSource } from "../packages/core/url.ts";
import { composePlan } from "../packages/core/compose.ts";
import { createService } from "../src/service.ts";
import { resolveWithNative } from "../extension/src/native-reddit.ts";
import { readActiveSubstackTab, type SubstackTabAPI } from "../extension/src/substack-tab.ts";
import { requiredOrigins, resolveCapture, revisePlan } from "../extension/src/core.ts";
import { shouldReplaceAutomaticDraft } from "../extension/src/draft-retention.ts";

const source = "https://substack.com/@norvidstudies/note/c-360829302";
const outer = await Bun.file(new URL("./fixtures/substack-note-public.html", import.meta.url)).text();
const quote = await Bun.file(new URL("./fixtures/substack-quote-public.html", import.meta.url)).text();
const requests: Array<{ url: string; init?: RequestInit }> = [];
const fetcher = (async (url: RequestInfo | URL, init?: RequestInit) => {
  requests.push({ url: String(url), init });
  if (String(url).includes("c-360829302")) return new Response(outer, { headers: { "content-type": "text/html" } });
  if (String(url).includes("c-359890078")) return new Response(quote, { headers: { "content-type": "text/html" } });
  throw new Error("Unexpected acquisition");
}) as unknown as typeof fetch;
async function capture() {
  return normalizeSubstackCapture(await readSubstackPage(source, { document: createDocument(outer), url: source, parseHTML: createDocument, fetcher, method: "public-html" }));
}
test("ordinary public Note URLs acquire full standalone quotes without credentials or preview promotion", async () => {
  requests.length = 0;
  const posts = await new SocialResolver({ substack: new SubstackProvider([], fetcher) }).resolve([source]);
  const post = posts[0]!;
  expect(post.substackCapture?.method).toBe("public-html");
  expect(post.substackCapture?.note.body.html.length).toBe(492);
  expect(post.substackCapture?.note.quote?.previewHtml?.length).toBe(347);
  expect(post.substackCapture?.note.quote?.expanded?.body.html.length).toBe(3881);
  expect(post.quote?.author.handle).toBe("lamblog");
  expect(post.quote?.text).toContain("destructive policies that foreclose human potential.");
  expect(post.quote?.text).toContain("https://www.youtube.com/watch?v=1u5qMZvd6ps");
  expect(post.quote?.media).toEqual([]);
  expect(post.postedAt).toBe("2026-10-14T14:34:41.000Z");
  expect(post.quoteCoverage).toMatchObject({ actualDepth: 1, stopped: "end", truncated: false });
  expect(requests).toHaveLength(2);
  expect(requests.every(call => call.init?.credentials === "omit" && call.init.redirect === "manual")).toBe(true);
});
test("quote policy bounds requests and exposes a progressive expansion boundary", async () => {
  requests.length = 0;
  const post = await new SubstackProvider([], fetcher).resolve(parseSource(source), undefined, { quoteDepth: 0 });
  expect(requests).toHaveLength(1); expect(post.quote).toBeUndefined();
  expect(post.quoteCoverage).toMatchObject({ actualDepth: 0, stopped: "depth_limit", mayExpand: true });
  expect(post.substackCapture?.note.quote?.previewHtml).toContain("…");
});
test("bare Note aliases follow only bounded credentialless redirects to the same public Note identity", async () => {
  const fetcher = (async (request: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.credentials).toBe("omit"); expect(init?.redirect).toBe("manual");
    return String(request) === "https://substack.com/note/c-360829302" ? new Response(null, { status: 302, headers: { location: source } }) : new Response(outer, { headers: { "content-type": "text/html" } });
  }) as unknown as typeof fetch;
  const post = await new SubstackProvider([], fetcher).resolve(parseSource("https://substack.com/note/c-360829302"), undefined, { quoteDepth: 0 });
  expect(post.canonicalUrl).toBe(source);
  for (const destination of ["https://other.com/note/c-360829302", "https://substack.com/note/c-999", "https://user:secret@substack.com/note/c-360829302", "https://substack.com/note/c-360829302"]) {
    const loop = (async () => new Response(null, { status: 302, headers: { location: destination } })) as unknown as typeof fetch;
    await expect(new SubstackProvider([], loop).resolve(parseSource("https://substack.com/note/c-360829302"))).rejects.toThrow();
  }
});
test("retained shallow snapshots hydrate descendants without altering original body, preview or observation", async () => {
  const shallow = await new SubstackProvider([], fetcher).resolve(parseSource(source), undefined, { quoteDepth: 0 });
  const original = structuredClone(shallow.substackCapture!);
  requests.length = 0;
  const expanded = await new SubstackProvider([original], fetcher).resolve(parseSource(source), undefined, { quoteDepth: "full" });
  expect(requests).toHaveLength(1);
  expect(expanded.substackCapture?.note.body).toEqual(original.note.body);
  expect(expanded.substackCapture?.observedAt).toBe(original.observedAt);
  expect(expanded.substackCapture?.note.quote?.previewHtml).toBe(original.note.quote?.previewHtml);
  expect(expanded.substackCapture?.note.quote?.expanded?.acquisition?.method).toBe("public-html");
  expect(expanded.quoteCoverage).toMatchObject({ actualDepth: 1, stopped: "end", mayExpand: false });
  requireRetainedSubstackCaptures({ sources: [expanded] }, [original]);
  const tampered = structuredClone(expanded); tampered.substackCapture!.note.body.html = "Changed";
  expect(() => requireRetainedSubstackCaptures({ sources: [tampered] }, [original])).toThrow("did not retain");
});
test("own sibling media is projected while quote-preview players cannot become root attachments", async () => {
  const doc = createDocument(outer), root = doc.querySelector('[class*="feedPermalinkUnit-"]')!;
  const picture = doc.createElement("img"); picture.setAttribute("src", "https://substackcdn.com/image/fetch/w_340/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Ffixture.jpg");
  root.appendChild(picture);
  const preview = root.querySelector('[class*="elevatedTheme-"]')!, iframe = doc.createElement("iframe"); iframe.setAttribute("src", "https://www.youtube-nocookie.com/embed/QUOTED_ONLY"); preview.appendChild(iframe);
  const value = normalizeSubstackCapture(await readSubstackPage(source, { document: doc, url: source, parseHTML: createDocument, fetcher }));
  expect(value.note.media).toEqual([{ kind: "image", url: "https://substack-post-media.s3.amazonaws.com/public/images/fixture.jpg", alt: "" }]);
  expect(value.note.links).toEqual([]);
  const plan = await resolveCapture({ primary: [source], extras: [], substackCaptures: [value], policy: { media: "all" } });
  expect(plan.block.selectedMedia).toEqual(["1.1"]);
  expect(plan.sources[0]!.media[0]!.sourceRole).toBe("original");
});
test("offset-free source timestamps remain labels without inferred UTC", async () => {
  const html = outer.replace("2026-10-14T14:34:41+00:00", "2026-10-14T14:34:41");
  const value = normalizeSubstackCapture(await readSubstackPage(source, { document: createDocument(html), url: source, parseHTML: createDocument, fetcher }));
  expect(value.note.postedAt).toBeUndefined(); expect(value.note.publishedLabel).toContain("Oct 14");
});
test("extracting a body image preserves authored caption prose inside its link wrapper", async () => {
  const doc = createDocument(outer), body = doc.querySelector('[class*="feedCommentBody-"] .ProseMirror')!;
  body.innerHTML = '<p><a href="https://substackcdn.com/original.jpg">Authored image caption<img src="https://substackcdn.com/preview.jpg"></a></p>';
  const metadata = doc.querySelector('script[type="application/ld+json"]')!;
  const structured = JSON.parse(metadata.textContent!); structured.text = "Authored image caption"; metadata.textContent = JSON.stringify(structured);
  const value = normalizeSubstackCapture(await readSubstackPage(source, { document: doc, url: source, parseHTML: createDocument, fetcher }));
  expect(value.note.body.html).toContain("Authored image caption");
  expect(value.note.body.html).not.toContain("<img");
  expect(value.note.media?.[0]?.url).toBe("https://substackcdn.com/original.jpg");
});
test("public refusal, challenge, wrong identity, collapsed body, bytes and cancellation fail closed", async () => {
  for (const response of [new Response(null, { status: 403 }), new Response(null, { status: 429 }),
    new Response("<html>Sign in</html>", { headers: { "content-type": "text/html" } }),
    new Response(outer.replaceAll("c-360829302", "c-999"), { headers: { "content-type": "text/html" } }),
    new Response(outer.replace("most video/audio", "Truncated video/audio"), { headers: { "content-type": "text/html" } }),
    new Response("x", { headers: { "content-type": "text/html", "content-length": "2097153" } })]) {
    let calls = 0; const denied = (async () => { calls++; return response; }) as unknown as typeof fetch;
    await expect(new SubstackProvider([], denied).resolve(parseSource(source))).rejects.toThrow();
    expect(calls).toBe(1);
  }
  const controller = new AbortController(); controller.abort();
  await expect(new SubstackProvider([], fetcher).resolve(parseSource(source), controller.signal)).rejects.toThrow();
});
test("quote availability remains explicit and does not make an embedded excerpt complete", async () => {
  const deniedQuote = (async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
  const value = normalizeSubstackCapture(await readSubstackPage(source, { document: createDocument(outer), url: source, parseHTML: createDocument, fetcher: deniedQuote }));
  expect(value.note.quote?.status).toBe("unavailable"); expect(value.note.quote?.expanded).toBeUndefined();
  const post = await new SubstackProvider([value]).resolve(parseSource(source));
  expect(post.quoteCoverage?.stopped).toBe("unavailable"); expect(composePlan([post]).block.markdown).toContain("Quoted post unavailable");
});
test("the serialized browser/Safari function works without imported closures and exports only projected fields", async () => {
  const context = { document: createDocument(outer), location: new URL(source), URL, Date, AbortController, Uint8Array, TextDecoder, setTimeout, clearTimeout,
    DOMParser: class { parseFromString(html: string) { return createDocument(html); } }, fetch: fetcher };
  const value = normalizeSubstackCapture(await runInNewContext(`(${readSubstackPage.toString()})(${JSON.stringify(source)})`, context));
  expect(value.method).toBe("browser-dom"); expect(value.note.quote?.expanded?.author.handle).toBe("lamblog");
  expect(JSON.stringify(value)).not.toContain("trackingParameters"); expect(JSON.stringify(value)).not.toContain("_preloads");
});
test("activeTab acquisition never requests a grant and binds the exact returned source", async () => {
  const value = await capture(); const calls: string[] = [];
  const browser: SubstackTabAPI = { permissions: { contains: async () => false }, tabs: { query: async () => [{ id: 4, url: source }] },
    scripting: { executeScript: async input => { calls.push(input.world); return [{ result: value }]; } } };
  await expect(readActiveSubstackTab(browser)).rejects.toThrow("No permission was requested"); expect(calls).toEqual([]);
  browser.permissions.contains = async () => true;
  expect(await readActiveSubstackTab(browser, source)).toEqual(value); expect(calls).toEqual(["ISOLATED"]);
  await expect(readActiveSubstackTab(browser, "https://substack.com/note/c-9")).rejects.toThrow("does not match");
});
test("receiver resolve/plan, browser edit and native-helper paths retain the exact bounded record", async () => {
  const value = await capture(); const dir = await mkdtemp(join(tmpdir(), "arena-substack-receiver-"));
  const service = createService({ host: "localhost", port: 8790, publicBaseUrl: "https://receiver.invalid", stateDirectory: dir, mediaDirectory: dir, accessToken: "fixture", arenaToken: "never-used" });
  try {
    const input = { refs: [source], substackCaptures: [value], policy: { media: "none" as const } };
    for (const path of ["/v1/resolve", "/v1/plans"]) {
      const response = await service.handler(new Request(`http://localhost${path}`, { method: "POST", headers: { authorization: "Bearer fixture", "content-type": "application/json" }, body: JSON.stringify(input) }));
      expect(response.status).toBe(200); const result = await response.json(); expect((result.posts ?? result.sources)[0].substackCapture).toEqual(value);
    }
    const version = await service.handler(new Request("http://localhost/v1/version", { headers: { authorization: "Bearer fixture" } }));
    expect((await version.json()).planCapabilities).toContain("substack-browser-records-v1");
    const browserPlan = await resolveCapture({ primary: [source], extras: [], policy: { media: "none" }, substackCaptures: [value] }, undefined, (async () => { throw new Error("No reads expected"); }) as unknown as typeof fetch);
    const edited = revisePlan(browserPlan, { markdown: "Authored edit", title: "Authored title" });
    requireRetainedSubstackCaptures(edited, [value]); expect(edited.block.markdown).toBe("Authored edit");
    const actions: string[] = []; let supported = false, returned = browserPlan;
    const native = async (action: string) => { actions.push(action); return action === "ping" ? { planCapabilities: supported ? ["substack-browser-records-v1"] : [] } : returned; };
    await expect(resolveWithNative({ ...input, extraRefs: [], refresh: false }, native)).rejects.toThrow("Update the local helper and receiver to read this source."); expect(actions).toEqual(["ping"]);
    supported = true; returned = structuredClone(browserPlan); delete returned.sources[0]!.substackCapture;
    await expect(resolveWithNative({ ...input, extraRefs: [], refresh: false }, native)).rejects.toThrow("did not retain");
    returned = browserPlan; expect(await resolveWithNative({ ...input, extraRefs: [], refresh: false }, native)).toEqual(browserPlan);
  } finally { service.close(); await rm(dir, { recursive: true, force: true }); }
});
test("retained Note drafts survive automatic source changes and need no new origins", async () => {
  const value = await capture();
  expect(shouldReplaceAutomaticDraft({ primary: source, substackCaptures: [value] }, "https://substack.com/note/c-9", false)).toBe(false);
  expect(requiredOrigins([source], [], [value])).toEqual([]);
  expect(requiredOrigins([source])).toEqual([]);
});
test("reply expansion requires a verified public reply contract before producing a Note", async () => {
  const refused = (async () => new Response(null, { status: 403 })) as unknown as typeof fetch;
  await expect(new SocialResolver({ substack: new SubstackProvider([], refused) }).resolveComposition([source], [], { threadExpansion: "on" })).rejects.toThrow("HTTP 403");
});
test("X thread expansion allows an explicit Substack media-only extra and ordered mixed primaries", async () => {
  const value = await capture(); value.note.media = [{ kind: "image", url: "https://substack-post-media.s3.amazonaws.com/public/images/extra.jpg", alt: "" }];
  const x = new XProvider(); const xURL = "https://x.com/example/status/123";
  const xPost = { provider: "x" as const, id: "123", canonicalUrl: xURL, author: { handle: "example" }, text: "X thread text", media: [] };
  x.discoverLinear = async () => ({ posts: [xPost], seedId: "123" });
  x.resolve = async () => xPost;
  const resolver = new SocialResolver({ x, substack: new SubstackProvider([value], fetcher) });
  const extra = await resolver.resolveComposition([xURL], [source], { threadExpansion: "on" });
  expect(extra.posts[1]?.selection?.role).toBe("extra");
  const plan = composePlan(extra.posts, extra.policy);
  expect(plan.block.markdown).not.toContain("most video/audio"); expect(plan.block.selectedMedia).toContain("2.1");
  const explicit = await resolver.resolveComposition([xURL, source], [], { threadExpansion: "on" });
  expect(explicit.posts.map(post => post.provider)).toEqual(["x", "substack"]);
});
test("provider bootstrap and record validation do not require TextEncoder", async () => {
  const child = Bun.spawn([process.execPath, "-e", 'globalThis.TextEncoder=undefined; globalThis.structuredClone=undefined; const {SubstackProvider}=await import("./packages/core/providers/substack.ts"); new SubstackProvider();'], { cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" });
  expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
});
test("regenerated JavaScriptCore bundle acquires ordinary URLs without browser-only globals", async () => {
  let finish!: (value: string, error: string | null) => void;
  const paths: string[] = [];
  const context = createContext({
    nativeSHA256: (value: string) => createHash("sha256").update(value).digest("hex"),
    setTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay).unref(), clearTimeout,
    nativeCancelHTTP: () => {}, nativeResolveComplete: (_: string, result: string, error: string | null) => finish(result, error),
    nativeHTTP: (id: number, request: string) => {
      const input = JSON.parse(request); paths.push(input.url);
      expect(input.headers.authorization).toBeUndefined();
      const html = input.url.includes("c-360829302") ? outer : quote;
      queueMicrotask(() => context.captureHTTPComplete(id, JSON.stringify({ status: 200, headers: { "content-type": "text/html" }, body: html, url: input.url })));
    },
  });
  runInContext(await Bun.file(new URL("../ios/Sources/CaptureRuntime/Resources/capture-core.js", import.meta.url)).text(), context);
  const result = await new Promise<string>((resolve, reject) => { finish = (value, error) => error ? reject(new Error(error)) : resolve(value); context.captureResolve("substack-public", JSON.stringify([source]), '{"media":"none","quoteDepth":"full"}'); });
  const plan = JSON.parse(result).plan;
  expect(plan.sources[0].substackCapture.note.body.html.length).toBe(492);
  expect(plan.sources[0].substackCapture.note.quote.expanded.body.html.length).toBe(3881);
  expect(plan.sources[0].quote.author.handle).toBe("lamblog"); expect(paths).toHaveLength(2);
});
test("generated Safari preprocessing returns the bounded Note instead of a generic URL", async () => {
  const script = await Bun.file(new URL("../ios/ShareExtension/RedditPreprocessor.js", import.meta.url)).text();
  const result = await new Promise<Record<string, string>>(done => {
    const context: any = { document: createDocument(outer), location: new URL(source), URL, Date, AbortController, TextDecoder, Uint8Array, setTimeout, clearTimeout,
      DOMParser: class { parseFromString(html: string) { return createDocument(html); } }, fetch: fetcher };
    runInNewContext(script, context); context.ExtensionPreprocessingJS.run({ completionFunction: done });
  });
  expect(result.substackError).toBeUndefined();
  expect(normalizeSubstackCapture(JSON.parse(result.substackCapture!)).note.quote?.expanded?.author.handle).toBe("lamblog");
});
