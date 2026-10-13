import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createContext, runInContext } from "node:vm";
import { atprotoPostFromView, BLUESKY, DELVE } from "../packages/core/providers/atproto-post.ts";
import { SocialResolver } from "../packages/core/providers/index.ts";
import { assignMediaRefs } from "../packages/core/providers/provider.ts";
import { composePlan } from "../src/compose.ts";
import { publicationFields } from "../src/capture.ts";
import { commentMarkdown } from "../src/providers/comments.ts";
import { captureRenderRecipe } from "../packages/core/render-recipe.ts";
import type { ResolvedPost } from "../src/types.ts";
import { arenaMediaPost } from "../packages/core/providers/arena-media.ts";
import linuxaudio from "./fixtures/reddit-body-images.json";
import mosaicIncident from "./fixtures/mosaic-xh-dimensions.json";

const bundle = await Bun.file(new URL("../ios/Sources/CaptureRuntime/Resources/capture-core.js", import.meta.url)).text();
const post: ResolvedPost = { provider: "x", id: "123", canonicalUrl: "https://x.com/person/status/123", author: { handle: "person" }, text: "A paragraph.\n\n日本語 — café 👋", media: [] };
function runtime(extra: Record<string, unknown> = {}) {
  const context = createContext({
    nativeSHA256: (value: string) => createHash("sha256").update(value).digest("hex"),
    setTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay).unref(), clearTimeout,
    nativeHTTP: () => {}, nativeCancelHTTP: () => {}, nativeResolveComplete: () => {}, ...extra,
  });
  runInContext(bundle, context);
  return context;
}

test.each([BLUESKY, DELVE])("$provider facet acquisition and labeled/expanded links match the native bundle", async app => {
  const did = "did:plc:abcdefghijklmnopqrstuvwx", text = "👋 café 界 github.com/example/p... and Research notes";
  const first = text.indexOf("github.com"), second = text.indexOf("Research notes"), length = (value: string) => new TextEncoder().encode(value).length;
  const raw = { thread: { post: { uri: `at://${did}/${app.namespace}.feed.post/a`, cid: "cid-a", replyCount: 0,
    author: { did, handle: "explicit.author.test" }, record: { $type: `${app.namespace}.feed.post`, text, createdAt: "2026-10-12T00:00:00Z", facets: [
      { index: { byteStart: length(text.slice(0, first)), byteEnd: length(text.slice(0, first + "github.com/example/p...".length)) },
        features: [{ $type: `${app.namespace}.richtext.facet#link`, uri: "https://github.com/example/project" }] },
      { index: { byteStart: length(text.slice(0, second)), byteEnd: length(text) },
        features: [{ $type: `${app.namespace}.richtext.facet#link`, uri: "https://example.com/research" }] },
    ] } } } };
  const ref = `${app.origin}/profile/${did}/post/a`, policy = { threadExpansion: "off" as const, media: "all" as const };
  const original = globalThis.fetch;
  let expected: ReturnType<typeof composePlan>;
  globalThis.fetch = (async (_input: URL | RequestInfo) => Response.json(raw)) as typeof fetch;
  try {
    const resolved = await new SocialResolver().resolveComposition([ref], [], policy);
    expected = composePlan(resolved.posts, resolved.policy);
  } finally { globalThis.fetch = original; }
  let complete!: (value: string, error: string | null) => void;
  const requests: string[] = [];
  const context = runtime({ nativeHTTP: (id: number, request: string) => {
    const input = JSON.parse(request); requests.push(input.url);
    expect(String(input.method).toUpperCase()).toBe("GET");
    expect(new URL(input.url).pathname).toBe(`/xrpc/${app.namespace}.feed.getPostThread`);
    queueMicrotask(() => context.captureHTTPComplete(id, JSON.stringify({ status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(raw), url: input.url })));
  }, nativeResolveComplete: (_: string, value: string, error: string | null) => complete(value, error) });
  const response = await new Promise<string>((done, fail) => {
    complete = (value, error) => error ? fail(new Error(error)) : done(value);
    context.captureResolve("facet-parity", JSON.stringify([ref]), JSON.stringify(policy));
  });
  const result = JSON.parse(response);
  expect(result.plan).toEqual(expected!);
  expect(result.plan.block.markdown).toContain("[https://github.com/example/project](<https://github.com/example/project>)");
  expect(result.plan.block.markdown).toContain("[Research notes](<https://example.com/research>)");
  expect(result.plan.sources[0].text).toBe(text);
  expect(result.plan.sources[0].atproto.record).toEqual(raw.thread.post.record);
  expect(result.fields).toEqual(publicationFields(expected!));
  expect(requests).toHaveLength(1);
  expect(JSON.parse(context.captureCompose(JSON.stringify(result.plan.sources), JSON.stringify(policy))).plan).toEqual(expected!);
});

test("native image layout fallback matches the shared core and retains every incident image", () => {
  const sources: ResolvedPost[] = Array.from({ length: 19 }, (_, index) => ({ ...post, id: String(index + 1),
    media: mosaicIncident.images.filter(item => item.ref.split(".")[0] === String(index + 1)).map(item => ({ ...item, kind: "image", url: `https://example.test/${item.ref}.jpg`, alt: "" })) }));
  const policy = { media: "all" as const, mediaOnlyPosts: Array.from({ length: 18 }, (_, index) => index + 2) };
  const plan = composePlan(sources, policy), context = runtime();
  const native = JSON.parse(context.captureCompose(JSON.stringify(sources), JSON.stringify(policy)));
  expect(native.plan).toEqual(plan);
  const recipe = JSON.parse(context.captureRenderRecipe(JSON.stringify(plan), "{}"));
  expect(recipe).toEqual(captureRenderRecipe(plan));
  expect(recipe.tiles.map((tile: { ref: string }) => tile.ref)).toEqual(mosaicIncident.images.map(item => item.ref));
  expect(recipe.width).toBe(4096); expect(recipe.height).toBe(3500);
  expect(Math.min(...recipe.tiles.map((tile: { rect: { width: number; height: number } }) => Math.min(tile.rect.width, tile.rect.height)))).toBe(314);
});

test("bundled native core uses an observed video frame without a video tile", () => {
  const source: ResolvedPost = { ...post, media: [{ ref: "1.1", kind: "video", url: "https://cdn.example/full.mp4",
    posterUrl: "https://cdn.example/frame.jpg", durationSeconds: 1800, width: 640, height: 360, alt: "" }] };
  const plan = composePlan([source]);
  const context = runtime();
  const native = JSON.parse(context.captureCompose(JSON.stringify([source]), "{}"));
  expect(native.plan).toEqual(plan);
  expect(native.plan.block.kind).toBe("link");
  expect(native.plan.block.frameMedia).toEqual([{ ref: "1.1", url: "https://cdn.example/frame.jpg" }]);
  const recipe = JSON.parse(context.captureRenderRecipe(JSON.stringify(plan), "{}"));
  expect(recipe).toEqual(captureRenderRecipe(plan));
  expect(recipe.tiles[0]).toMatchObject({ ref: "1.1", kind: "image", url: "https://cdn.example/frame.jpg" });
});

test("bundled native Reddit resolver retains the exact body image and recomposes All without another read", async () => {
  const calls: string[] = [];
  let finish!: (value: string) => void;
  let fail!: (error: Error) => void;
  const done = new Promise<string>((resolve, reject) => { finish = resolve; fail = reject; });
  const context = runtime({
    nativeHTTP: (id: number, request: string) => {
      const url = JSON.parse(request).url; calls.push(url);
      expect(url).toBe(linuxaudio.provenance.jsonURL);
      queueMicrotask(() => context.captureHTTPComplete(id, JSON.stringify({ status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify([{ data: { children: [{ data: linuxaudio.post }] } }]), url })));
    },
    nativeResolveComplete: (_: string, value: string, error: string) => error ? fail(new Error(error)) : finish(value),
  });
  context.captureResolve("reddit-body", JSON.stringify([`https://www.reddit.com${linuxaudio.post.permalink}`]), "{}");
  const automatic = JSON.parse(await done);
  expect(automatic.plan.block.selectedMedia).toEqual(["1.1"]);
  expect(automatic.plan.sources[0].text).toBe(linuxaudio.post.selftext);
  expect(automatic.plan.sources[0].media[1]).toMatchObject({ ref: "1.2", id: "fixtureimageb", sourcePlacement: "body", width: 1666, height: 937 });
  for (const policy of [{ media: "all" }, { media: "selected", selectedMedia: ["1.2"] }, { media: "all", mediaOrder: ["1.2", "1.1"] }]) {
    const native = JSON.parse(context.captureCompose(JSON.stringify(automatic.plan.sources), JSON.stringify(policy)));
    expect(native.plan).toEqual(composePlan(automatic.plan.sources, policy as Parameters<typeof composePlan>[1]));
    expect(JSON.parse(context.captureRenderRecipe(JSON.stringify(native.plan), "{}"))).toEqual(captureRenderRecipe(native.plan));
  }
  expect(calls).toHaveLength(1);
});

test("bundled native Bluesky discovery expands a verified linear chain and honors off", async () => {
  const did = "did:plc:nativefixture";
  const uri = (id: string) => `at://${did}/app.bsky.feed.post/${id}`;
  const view = (id: string, parent?: string) => ({ uri: uri(id), cid: `cid-${id}`, author: { did, handle: "author.test" }, replyCount: id === "c" ? 0 : 1,
    record: { text: `Text ${id}`, ...(parent ? { reply: { parent: { uri: uri(parent), cid: `cid-${parent}` } } } : {}) } });
  const seed = { thread: { post: view("b", "a"), parent: { post: view("a") } } };
  const root = { thread: { post: view("a"), replies: [{ post: view("b", "a"), replies: [{ post: view("c", "b"), replies: [] }] }] } };
  const calls: string[] = [];
  let complete!: (value: string, error: string | null) => void;
  const context = runtime({ nativeHTTP: (id: number, request: string) => {
    const url = JSON.parse(request).url as string; calls.push(url);
    const payload = calls.length === 1 ? seed : calls.length === 2 ? root : seed;
    queueMicrotask(() => context.captureHTTPComplete(id, JSON.stringify({ status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(payload), url })));
  }, nativeResolveComplete: (_: string, value: string, error: string | null) => complete(value, error) });
  const resolve = (policy: object) => new Promise<{ plan: ReturnType<typeof composePlan> }>((done, fail) => {
    complete = (value, error) => error ? fail(new Error(error)) : done(JSON.parse(value));
    context.captureResolve("bsky-native", JSON.stringify(["https://bsky.app/profile/author.test/post/b"]), JSON.stringify(policy));
  });
  const expanded = await resolve({});
  expect(expanded.plan.sources.map(source => source.id)).toEqual(["a", "b", "c"]);
  expect(expanded.plan.sources.map(source => source.selection?.origin)).toEqual(["expanded", "explicit", "expanded"]);
  expect(calls).toHaveLength(2);
  const onlySeed = await resolve({ threadExpansion: "off" });
  expect(onlySeed.plan.sources.map(source => source.id)).toEqual(["b"]);
  expect(calls).toHaveLength(3);
});

test("bundled native resolve accepts media-only extras without adding their prose", async () => {
  let complete!: (value: string, error: string | null) => void;
  const context = runtime({ nativeHTTP: (id: number, request: string) => {
    const url = JSON.parse(request).url as string;
    const sourceID = url.split("/").at(-1)!;
    const tweet = { id: sourceID, text: sourceID === "100" ? "Primary writing" : "Extra writing",
      author: { screen_name: "author" },
      ...(sourceID === "200" ? { media: { photos: [{ type: "photo", url: "https://example.test/extra.jpg" }] } } : {}) };
    queueMicrotask(() => context.captureHTTPComplete(id, JSON.stringify({ status: 200, headers: {}, body: JSON.stringify({ code: 200, tweet }), url })));
  }, nativeResolveComplete: (_: string, value: string, error: string | null) => complete(value, error) });
  const result = new Promise<{ plan: ReturnType<typeof composePlan> }>((done, fail) => {
    complete = (value, error) => error ? fail(new Error(error)) : done(JSON.parse(value));
  });
  context.captureResolve("with-extra", JSON.stringify(["https://x.com/author/status/100"]), "{}", "false",
    JSON.stringify(["https://x.com/author/status/200"]));
  const { plan } = await result;
  expect(plan.sources.map(source => source.selection?.role)).toEqual(["primary", "extra"]);
  expect(plan.policy.mediaOnlyPosts).toEqual([2]);
  expect(plan.block.selectedMedia).toEqual(["2.1"]);
  expect(plan.block.markdown).toContain("Primary writing");
  expect(plan.block.markdown).not.toContain("Extra writing");
});

test("bundled core preserves plans and hashes without browser or Bun globals", () => {
  const context = runtime();
  const wide = (index: number) => ({ ref: `1.${index}`, kind: "video" as const, url: `https://example.com/${index}.mp4`, alt: "", width: 1920, height: 1080 });
  const probes = Object.fromEntries([1, 2, 3].map((index) => [`1.${index}`, { width: 1920, height: 1080, duration: 4, fps: 30, audio: true }]));
  for (const item of [post, { ...post, quote: { ...post, id: "122", text: "Quoted." } }, { ...post, media: [{ ref: "1.1", kind: "image" as const, url: "https://example.com/a.jpg", alt: "", width: 640, height: 480 }] }, { ...post, media: [wide(1), wide(2), wide(3)] }]) {
    const plan = composePlan([item], { media: "all" });
    expect(JSON.parse(context.captureCompose(JSON.stringify([item]), JSON.stringify({ media: "all" })))).toEqual({ plan, fields: publicationFields(plan) });
    expect(JSON.parse(context.captureRenderRecipe(JSON.stringify(plan), JSON.stringify(probes)))).toEqual(captureRenderRecipe(plan, probes));
  }
  expect(JSON.parse(context.captureSource("https://twitter.com/person/status/123?s=20"))).toEqual({ kind: "social", url: post.canonicalUrl });
  expect(() => context.captureSource("https://user:pass@x.com/person/status/123")).toThrow();
});

test("bundled native composer keeps a self-reply introduction before its attributed quote", () => {
  const root: ResolvedPost = { ...post, id: "2108271344286892133", author: { handle: "AndrewCurran_" }, text: "Open letter.",
    quote: { ...post, id: "2108262814003687745", author: { handle: "balesni" }, text: "We wrote this letter." } };
  const reply: ResolvedPost = { ...post, id: "2108277692819017822", author: { handle: "AndrewCurran_" },
    replyTo: { id: root.id, authorHandle: "AndrewCurran_" }, text: "Jasmine Wang:",
    quote: { ...post, id: "2108263312291180680", author: { handle: "j_asminewang" }, text: "OpenAI fired me last week." } };
  const native = JSON.parse(runtime().captureCompose(JSON.stringify([root, reply]), "{}"));
  expect(native.plan).toEqual(composePlan([root, reply]));
  expect(native.plan.block.markdown).toContain("Jasmine Wang:\n\n> `@j_asminewang`\n> OpenAI fired me last week.");
  expect(native.plan.block.markdown).not.toContain("`@AndrewCurran_`");
});

test("bundled provider resolves through native transport and retains HTML Markdown", async () => {
  let finish!: (value: string) => void;
  let fail!: (error: Error) => void;
  const result = new Promise<string>((resolve, reject) => { finish = resolve; fail = reject; });
  const html = "<p>Hello <em>world</em>.</p><p><a href='https://example.com'>Read more</a></p>";
  const context = runtime({
    nativeHTTP: (id: number, request: string) => {
      const url = JSON.parse(request).url;
      expect(url).toMatch(/^https:\/\/hacker-news\.firebaseio\.com\/v0\/item\/(123|124)\.json$/);
      queueMicrotask(() => context.captureHTTPComplete(id, JSON.stringify({ status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(url.endsWith("123.json") ? { id: 123, parent: 124, type: "comment", by: "person", text: html, time: 1700000000 } : { id: 124, type: "story", title: "A story" }), url })));
    },
    nativeResolveComplete: (_: string, value: string, error: string) => error ? fail(new Error(error)) : finish(value),
  });
  context.captureResolve("job", JSON.stringify(["https://news.ycombinator.com/item?id=123"]), "{}");
  const parsed = JSON.parse(await result);
  expect(parsed.plan.sources[0].text).toBe(commentMarkdown(html));
});

test("native cancellation cancels HTTP and rejects resolution", async () => {
  let id = 0;
  let complete!: (error: string) => void;
  const result = new Promise<string>(resolve => { complete = resolve; });
  const canceled: number[] = [];
  const context = runtime({ nativeHTTP: (request: number) => { id = request; }, nativeCancelHTTP: (request: number) => canceled.push(request), nativeResolveComplete: (_: string, _result: string, error: string) => complete(error) });
  context.captureResolve("job", JSON.stringify([post.canonicalUrl]), "{}");
  context.captureCancel("job");
  expect(await result).toContain("aborted");
  expect(canceled).toEqual([id]);
});

test("native quote depth expands a cached prefix and subsequently recomposes without HTTP requests", async () => {
  const calls: string[] = [];
  let complete!: (value: string) => void;
  const resolved = new Promise<string>(resolve => { complete = resolve; });
  const context = runtime({ nativeHTTP: (id: number, request: string) => {
    const url = JSON.parse(request).url, sourceID = url.split("/").at(-1)!; calls.push(sourceID);
    const number = Number(sourceID);
    const tweet = { id: sourceID, text: `Exact ${sourceID}`, author: { screen_name: `author${sourceID}` },
      ...(number === 97 ? {} : { quote: { id: String(number - 1), author: { screen_name: `author${number - 1}` }, text: "Embedded" } }) };
    queueMicrotask(() => context.captureHTTPComplete(id, JSON.stringify({ status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ tweet }), url })));
  }, nativeResolveComplete: (_: string, value: string, error: string) => { expect(error).toBeNull(); complete(value); } });
  context.captureResolve("nested", JSON.stringify(["https://x.com/author100/status/100"]), "{}");
  const initial = JSON.parse(await resolved);
  expect(calls).toEqual(["100", "99", "98"]);
  expect(initial.plan.block.markdown).toContain("> > `@author98`");
  expect(initial.plan.block.markdown).not.toContain("Exact 97");
  const expanded = new Promise<string>(resolve => { complete = resolve; });
  context.captureResolve("expand", JSON.stringify(["https://x.com/author100/status/100"]), JSON.stringify({ quoteDepth: "full" }));
  const full = JSON.parse(await expanded);
  expect(calls).toEqual(["100", "99", "98", "97"]);
  expect(full.plan).toEqual(composePlan(full.plan.sources, { quoteDepth: "full" }));
  expect(full.plan.block.markdown).toContain("> > > `@author97`");
  expect(full.plan.hash).not.toBe(initial.plan.hash);
  const recomposed = JSON.parse(context.captureCompose(JSON.stringify(full.plan.sources), "{}"));
  expect(recomposed.plan.block.markdown).not.toContain("Exact 97"); expect(calls).toHaveLength(4);
  const refreshed = new Promise<string>(resolve => { complete = resolve; });
  context.captureResolve("refresh", JSON.stringify(["https://x.com/author100/status/100"]), "{}", "true");
  expect(JSON.parse(await refreshed).plan.block.quoteCoverage[0].mayExpand).toBe(true);
  expect(calls).toEqual(["100", "99", "98", "97", "100", "99", "98"]);
});

test("replacing a native source job cancels and suppresses its late callback", async () => {
  let firstID = 0;
  const canceled: number[] = [], results: Array<{ id: string; value: string; error: string }> = [];
  let complete!: () => void;
  const done = new Promise<void>(resolve => { complete = resolve; });
  const context = runtime({ nativeHTTP: (id: number, request: string) => {
    const url = JSON.parse(request).url;
    if (url.endsWith("/100")) { firstID = id; return; }
    queueMicrotask(() => context.captureHTTPComplete(id, JSON.stringify({ status: 200, headers: {}, body: JSON.stringify({ tweet: { id: "200", author: { screen_name: "new" }, text: "Current" } }), url })));
  }, nativeCancelHTTP: (id: number) => canceled.push(id), nativeResolveComplete: (id: string, value: string, error: string) => { results.push({ id, value, error }); complete(); } });
  context.captureResolve("same", JSON.stringify(["https://x.com/old/status/100"]), "{}");
  context.captureResolve("same", JSON.stringify(["https://x.com/new/status/200"]), "{}");
  await done;
  context.captureHTTPComplete(firstID, JSON.stringify({ status: 200, headers: {}, body: JSON.stringify({ tweet: { id: "100", author: { screen_name: "old" }, text: "Stale" } }), url: "https://api.fxtwitter.com/old/status/100" }));
  await Promise.resolve();
  expect(canceled).toContain(firstID); expect(results).toHaveLength(1);
  expect(results[0]!.error).toBeNull(); expect(JSON.parse(results[0]!.value).plan.sources[0].id).toBe("200");
});

test("native edits update identity and shared verifier rejects lost content", () => {
  const context = runtime();
  const original = composePlan([post]);
  const edited = JSON.parse(context.captureEdit(JSON.stringify(original), JSON.stringify({ title: "My title", description: "My note" })));
  expect(edited.plan.hash).not.toBe(original.hash);
  expect(edited.fields).toEqual({ title: "My title", content: post.text, description: "My note" });
  const block = { state: "available", type: "Text", title: "My title", content: { markdown: post.text }, description: { markdown: "My note" } };
  expect(() => context.captureVerify(JSON.stringify(edited.plan), JSON.stringify(block))).not.toThrow();
  expect(() => context.captureVerify(JSON.stringify(edited.plan), JSON.stringify({ ...block, description: null }))).toThrow("description does not match");
});

test("native text creation stages a neutral value before applying URL-leading content and description", () => {
  const context = runtime();
  const original = composePlan([{ ...post, text: "https://example.com/article writes about collecting field notes.", media: [] }]);
  const edited = JSON.parse(context.captureEdit(JSON.stringify(original), JSON.stringify({ description: "A retained note." })));
  const payload = JSON.parse(context.captureLocalPayload(JSON.stringify(edited.plan), "", "", "[7]"));
  expect(payload.value).toBe(`arena-block text ${edited.plan.hash}`);
  expect(payload.description).toBe(`arena-block description ${edited.plan.hash}`);
  expect(payload.original_source_url).toBe(edited.plan.block.canonicalSource);
  expect(edited.fields.content).toBe(original.block.markdown);
  expect(edited.fields.description).toBe("A retained note.");
});

test("bundled core converts an on-device Are.na read and preserves explicit all-item order", () => {
  const context = runtime();
  const block = { id: 123, type: "Link", state: "available", title: "Reference", user: { slug: "curator" },
    image: { src: "https://images.are.na/preview.png", width: 640, height: 480, alt_text: "Source caption" } };
  const arena = JSON.parse(context.captureArenaMediaPost(JSON.stringify(block), "123"));
  expect(arena).toEqual(arenaMediaPost(block, 123));
  const posts = [{ ...post, media: [{ ref: "1.1", kind: "image", url: "https://example.com/first.jpg", width: 640, height: 480, alt: "" }] },
    { ...arena, media: arena.media.map((item: ResolvedPost["media"][number]) => ({ ...item, ref: "2.1" })) }];
  const policy = { mediaOnlyPosts: [2], mediaOrder: ["2.1", "1.1"] };
  const plan = composePlan(posts, policy);
  expect(JSON.parse(context.captureCompose(JSON.stringify(posts), JSON.stringify(policy))).plan).toEqual(plan);
  const nativeRecipe = JSON.parse(context.captureRenderRecipe(JSON.stringify(plan), "{}"));
  expect(nativeRecipe.tiles.map((tile: { ref: string }) => tile.ref)).toEqual(["2.1", "1.1"]);
});

test("shared video recipe preserves looping, geometry and explicit audio choices", () => {
  const media = [{ ref: "1.1", kind: "video" as const, url: "https://example.com/one.mp4", alt: "" }, { ref: "1.2", kind: "video" as const, url: "https://example.com/two.mp4", alt: "" }];
  const probes = { "1.1": { width: 1280, height: 720, duration: 2, fps: 24, audio: true }, "1.2": { width: 640, height: 480, duration: 8, fps: 30, audio: true } };
  const plan = composePlan([{ ...post, media }], { media: "all" });
  const recipe = captureRenderRecipe(plan, probes)!;
  expect(recipe.duration).toBe(8);
  expect(recipe.fps).toBe(30);
  expect(recipe.audio).toEqual(["1.2"]);
  expect(recipe.tiles.map(tile => tile.ref)).toEqual(["1.1", "1.2"]);
  const mixed = composePlan([{ ...post, media }], { media: "all", audio: "mix" });
  expect(captureRenderRecipe(mixed, probes)!.audio).toEqual(["1.1", "1.2"]);
  expect(JSON.parse(runtime().captureRenderRecipe(JSON.stringify(plan), JSON.stringify(probes)))).toEqual(recipe);
  const chosen = composePlan([{ ...post, media }], { media: "all", audio: "1.1" });
  expect(captureRenderRecipe(chosen, probes)!.audio).toEqual(["1.1"]);
  expect(JSON.parse(runtime().captureRenderRecipe(JSON.stringify(chosen), JSON.stringify(probes))).audio).toEqual(["1.1"]);
  expect(() => captureRenderRecipe(chosen, { ...probes, "1.1": { ...probes["1.1"], audio: false } })).toThrow("Video 1.1 has no audio");
  expect(() => composePlan([{ ...post, media }], { media: "selected", selectedMedia: ["1.2"], audio: "1.1" })).toThrow("Audio source 1.1 is not a selected video");
});


test("bundled native Delve retains public record, facets, quotes and card metadata through compose, edit and payload", async () => {
  const { DelveProvider } = await import("../packages/core/providers/delve.ts");
  const { SocialResolver } = await import("../packages/core/providers/index.ts");
  const fixture = await Bun.file(new URL("./fixtures/delve-quote-external.json", import.meta.url)).json();
  const provider = new DelveProvider(undefined, (async () => Response.json(fixture)) as unknown as typeof fetch);
  const resolved = await new SocialResolver({ delve: provider }).resolveComposition([fixture.thread.post.uri], [], { threadExpansion: "off" });
  const plan = composePlan(resolved.posts, resolved.policy), context = runtime();
  const native = JSON.parse(context.captureCompose(JSON.stringify(plan.sources), JSON.stringify(plan.policy)));
  expect(native.plan).toEqual(plan);
  const edited = JSON.parse(context.captureEdit(JSON.stringify(plan), JSON.stringify({ title: "My title", markdown: "My body" })));
  expect(edited.plan.sources).toEqual(plan.sources);
  expect(edited.plan.block.title).toBe("My title");
  expect(JSON.parse(context.captureFields(JSON.stringify(edited.plan))).content).toBe("My body");
  expect(JSON.parse(context.captureLocalPayload(JSON.stringify(edited.plan), "", "", "[]")).original_source_url).toBe(plan.block.canonicalSource);
  expect(JSON.parse(context.captureSource(fixture.thread.post.uri))).toEqual({ kind: "social", url: plan.sources[0]!.canonicalUrl });
});

test("bundled native Delve discovers the public middle-seed author chain and keeps supplementary media roles", async () => {
  const fixture = await Bun.file(new URL("./fixtures/delve-author-thread.json", import.meta.url)).json();
  const seed = fixture.selected.thread.post.uri;
  const requests: string[] = [];
  let complete!: (value: string, error: string | null) => void;
  const context = runtime({ nativeHTTP: (id: number, request: string) => {
    const url = JSON.parse(request).url as string; requests.push(url);
    const payload = new URL(url).searchParams.get("uri") === seed ? fixture.selected : fixture.root;
    queueMicrotask(() => context.captureHTTPComplete(id, JSON.stringify({ status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(payload), url })));
  }, nativeResolveComplete: (_: string, value: string, error: string | null) => complete(value, error) });
  const resolve = (policy: object) => new Promise<any>((done, fail) => {
    complete = (value, error) => error ? fail(new Error(error)) : done(JSON.parse(value));
    context.captureResolve("delve-native", JSON.stringify([seed]), JSON.stringify(policy));
  });
  const expanded = await resolve({});
  expect(expanded.plan.sources.map((post: ResolvedPost) => post.id)).toEqual(["3mxe7fekwnk2u", "3mxe7nb7vfk2u", "3mxeads7s6k2m"]);
  expect(expanded.plan.sources.map((post: ResolvedPost) => post.selection?.origin)).toEqual(["expanded", "explicit", "expanded"]);
  expect(expanded.plan.sources[2].atproto.reply.root.uri).toBe(fixture.root.thread.post.uri);
  const seedOnly = await resolve({ threadExpansion: "off" });
  expect(seedOnly.plan.sources).toHaveLength(1);
  expect(requests.every(url => new URL(url).origin === "https://api.delve.town")).toBe(true);
});

test("bundled Delve provider retains protocol metadata, Unicode facets and the thread-off contract", async () => {
  const fixture = await Bun.file(new URL("./fixtures/delve-quote-external.json", import.meta.url)).json();
  let finish!: (value: string) => void;
  let fail!: (error: Error) => void;
  const result = new Promise<string>((resolve, reject) => { finish = resolve; fail = reject; });
  const requests: URL[] = [];
  const context = runtime({
    nativeHTTP: (id: number, request: string) => {
      const url = new URL(JSON.parse(request).url); requests.push(url);
      expect(url.origin).toBe("https://api.delve.town");
      expect(url.pathname).toBe("/xrpc/town.delve.feed.getPostThread");
      expect(url.searchParams.get("depth")).toBe("0");
      expect(url.searchParams.get("parentHeight")).toBe("0");
      queueMicrotask(() => context.captureHTTPComplete(id, JSON.stringify({ status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(fixture), url: url.href })));
    },
    nativeResolveComplete: (_: string, value: string, error: string) => error ? fail(new Error(error)) : finish(value),
  });
  const uri = fixture.thread.post.uri;
  const normalized = assignMediaRefs({ ...atprotoPostFromView(fixture.thread.post, DELVE), selection: { role: "primary", origin: "explicit", declaredIndex: 1 } }, 0);
  const expected = composePlan([normalized], { threadExpansion: "off" });
  context.captureResolve("delve", JSON.stringify([uri]), JSON.stringify({ threadExpansion: "off" }));
  expect(JSON.parse(await result)).toEqual({ plan: expected, fields: publicationFields(expected) });
  expect(requests).toHaveLength(1);
  expect(JSON.parse(context.captureSource(uri))).toEqual({ kind: "social", url: normalized.canonicalUrl });
  expect(JSON.parse(context.captureCompose(JSON.stringify([normalized]), JSON.stringify({ threadExpansion: "off" })))).toEqual({ plan: expected, fields: publicationFields(expected) });
});
