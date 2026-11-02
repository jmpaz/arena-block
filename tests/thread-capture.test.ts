import { describe, expect, test } from "bun:test";
import { captureThread, renderThreadHtml, renderThreadMarkdown, threadTextSegments } from "../src/thread-capture.ts";
const x = (id = "1") => `https://x.com/person/status/${id}`;
const bsky = "https://bsky.app/profile/person.test/post/root";
const post = (id: string, text = id, extras: Record<string, unknown> = {}) => ({ uri: `at://did:plc:person/app.bsky.feed.post/${id}`, author: { handle: "person.test", displayName: "Person" }, record: { text, createdAt: "2025-07-21T09:53:00Z" }, ...extras });
const node = (id: string, replies: unknown[] = [], extras: Record<string, unknown> = {}) => ({ $type: "app.bsky.feed.defs#threadViewPost", post: post(id), replies, ...extras });
const mock = (payload: unknown, calls?: { url: string; init?: RequestInit }[]) => (async (input: RequestInfo | URL, init?: RequestInit) => { calls?.push({ url: String(input), init }); return Response.json(payload); }) as unknown as typeof fetch;
describe("draft thread capture", () => {
  test("preserves Unicode, facets, links, multiline formatting and invalid boundaries", () => {
    const text = "🐈 café\nlink @person #tag", start = new TextEncoder().encode("🐈 café\n").length;
    const facets = [ { index: { byteStart: 1, byteEnd: 3 }, features: [{ $type: "facet#link", uri: "https://bad.test" }] }, { index: { byteStart: start, byteEnd: start + 4 }, features: [{ $type: "facet#link", uri: "https://example.test/?x=1&y=2" }] }, { index: { byteStart: start + 5, byteEnd: start + 12 }, features: [{ $type: "facet#mention", did: "did:plc:person" }] }, { index: { byteStart: start + 13, byteEnd: start + 17 }, features: [{ $type: "facet#tag", tag: "tag" }] } ];
    const result = threadTextSegments(text, facets); expect(result.map(s => s.text).join("")).toBe(text);
    expect(result.filter(s => s.url).map(s => s.url)).toEqual(["https://example.test/?x=1&y=2", "https://bsky.app/profile/did:plc:person", "https://bsky.app/hashtag/tag"]);
    expect(threadTextSegments("evil", [{ index: { byteStart: 0, byteEnd: 4 }, features: [{ $type: "facet#link", uri: "javascript:alert(1)" }] }])).toEqual([{ text: "evil" }]);
  });
  test("x.com follows ancestor pointers, captures nested quotes, deduplicates explicit manifest, preserves originals", async () => {
    const calls: string[] = [];
    const fetcher = (async (input: RequestInfo | URL) => { const url = String(input); calls.push(url); const id = url.split("/").at(-1); return Response.json({ tweet: { id, author: { screen_name: "person", name: "Person" }, created_at: "Sun Oct 04 15:21:02 +0000 2026", text: `post ${id}\n\nparagraph`, ...(id === "1" ? { replying_to_status: "2", replying_to: "person", quote: { id: "3", author: { screen_name: "quote" }, text: "quoted" } } : {}) } }); }) as unknown as typeof fetch;
    const result = await captureThread(x(), { fetch: fetcher, xManifest: [x(), x("2")] });
    expect(result.posts.map(p => p.id)).toEqual(["1", "3", "2"]); expect(calls).toHaveLength(3); expect(result.originals).toHaveLength(3);
    expect(result.edges).toContainEqual({ from: "1", to: "3", kind: "quote" }); expect(result.edges).toContainEqual({ from: "1", to: "2", kind: "ancestor" });
    expect(result.coverage.complete).toBe(false); expect(renderThreadMarkdown(result)).toContain("downward replies"); expect(result.posts[0]?.text).toContain("\n\n");
  });
  test("Bluesky includes alternating authors, replies, ancestors, quote, deleted and blocked placeholders", async () => {
    const quote = { $type: "app.bsky.embed.record#view", record: { $type: "app.bsky.embed.record#viewRecord", uri: "at://did:plc:other/app.bsky.feed.post/q", author: { handle: "quoted.test" }, value: { text: "quote", createdAt: "2022-01-01" } } };
    const root = node("root", [node("reply", [], { post: post("reply", "reply", { author: { handle: "other.test" } }) }), { $type: "app.bsky.feed.defs#notFoundPost", uri: "at://did:plc:person/app.bsky.feed.post/gone" }, { $type: "app.bsky.feed.defs#blockedPost", uri: "at://did:plc:person/app.bsky.feed.post/blocked" }], { post: post("root", "root", { embed: quote }), parent: node("parent") });
    const calls: { url: string; init?: RequestInit }[] = [];
    const result = await captureThread(bsky, { fetch: mock({ thread: root }, calls) });
    expect(result.posts.map(p => p.status).sort()).toEqual(["available", "available", "available", "available", "blocked", "deleted"]);
    expect(result.posts.find(p => p.text === "quote")?.author.handle).toBe("quoted.test"); expect(result.posts.find(p => p.text === "reply")?.author.handle).toBe("other.test");
    expect(calls[0]?.init?.redirect).toBe("error"); expect(calls[0]?.init?.credentials).toBe("omit"); expect(calls[0]?.url).toContain("getPostThread");
  });
  test("depth, count and duplicates are explicit; cannot claim complete capture", async () => {
    const root = node("root", [node("a", [node("b")]), node("a")], { post: post("root", "root", { replyCount: 7 }) });
    const result = await captureThread(bsky, { fetch: mock({ thread: root }), depth: 1 }); expect(result.posts).toHaveLength(2);
    expect(result.coverage.limits.join(" ")).toContain("Reply depth 1"); expect(result.coverage.limits.join(" ")).toContain("Reply count exceeds");
    const capped = await captureThread(bsky, { fetch: mock({ thread: root }), maxPosts: 1 }); expect(capped.posts).toHaveLength(1); expect(capped.coverage.limits.join(" ")).toContain("Post cap 1");
  });
  test("unavailable x.com errors stay in coverage and placeholders", async () => {
    const result = await captureThread(x(), { fetch: (async () => new Response("blocked", { status: 403 })) as unknown as typeof fetch });
    expect(result.posts[0]?.status).toBe("unavailable"); expect(result.coverage.errors[0]).toContain("HTTP 403");
  });
  test("no browser or redirect fallback on denied login redirect", async () => {
    let calls = 0;
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => { calls++; expect(init?.redirect).toBe("error"); expect(init?.credentials).toBe("omit"); throw new TypeError("redirect prohibited to https://x.com/i/flow/login"); }) as unknown as typeof fetch;
    const result = await captureThread(x(), { fetch: fetcher }); expect(calls).toBe(1); expect(result.coverage.errors[0]).toContain("redirect prohibited"); expect(result.coverage.availablePosts).toBe(0);
    const redirected = new Response("{}", { status: 200 }); Object.defineProperty(redirected, "redirected", { value: true });
    const other = await captureThread(bsky, { fetch: (async () => redirected) as unknown as typeof fetch }); expect(other.coverage.errors[0]).toContain("redirect");
  });
  test("rejects feed/login sources and invalid manifests before networking", async () => {
    let calls = 0; const fetcher = (async () => { calls++; return Response.json({}); }) as unknown as typeof fetch;
    for (const url of ["https://x.com/home", "https://x.com/i/flow/login", "http://x.com/person/status/1", "https://user:secret@x.com/person/status/1"]) await expect(captureThread(url, { fetch: fetcher })).rejects.toThrow();
    await expect(captureThread(x(), { fetch: fetcher, xManifest: [bsky] })).rejects.toThrow(); expect(calls).toBe(0);
  });
  test("cancellation propagates rather than becoming a captured error", async () => {
    const controller = new AbortController(); controller.abort(); let calls = 0;
    await expect(captureThread(x(), { signal: controller.signal, fetch: (async () => { calls++; return Response.json({}); }) as unknown as typeof fetch })).rejects.toThrow(); expect(calls).toBe(0);
    const after = new AbortController(); await expect(captureThread(bsky, { signal: after.signal, fetch: (async () => { after.abort(); return Response.json({ thread: node("root") }); }) as unknown as typeof fetch })).rejects.toThrow();
  });
  test("renderers sanitize source text, retain meaningful reviewed description, and label missing review", async () => {
    const url = "https://cdn.test/image.jpg";
    const result = await captureThread(x(), { fetch: mock({ tweet: { id: "1", author: { screen_name: "person", name: "<script>alert(1)</script>" }, text: "# title\n<script>alert(1)</script>\n[click](javascript:alert(1))", media: { all: [{ type: "photo", url, alt: "<img onerror=evil>" }, { type: "photo", url: "https://cdn.test/missing.jpg" }] } } }), descriptions: { [url]: { text: "A diagram showing three connected rectangles.", basis: "pixels", evidence: "evidence/reviewed.png" } } });
    const rendered = renderThreadHtml(result); expect(rendered).not.toContain("<script>"); expect(rendered).toContain("&lt;script&gt;"); expect(rendered).toContain("Content-Security-Policy"); expect(rendered).toContain("A diagram showing three connected rectangles"); expect(rendered).toContain("Image review pending");
    const markdown = renderThreadMarkdown(result); expect(markdown).not.toContain("<script>"); expect(markdown).toContain("# title"); expect(markdown).toContain("reviewed pixels"); expect(result.coverage.mediaWithoutDescriptions).toBe(1);
  });
  test("standalone x.com quote hydration recovers a third author missing from the embedded record", async () => {
    const tweets: Record<string, unknown> = {
      "1": { id: "1", author: { screen_name: "vie" }, text: "vie", quote: { id: "2", author: { screen_name: "q" }, text: "shallow" } },
      "2": { id: "2", author: { screen_name: "q" }, text: "complete quote", quote: { id: "3", author: { screen_name: "rhys" }, text: "third author" } },
      "3": { id: "3", author: { screen_name: "rhys" }, text: "third author" },
    };
    const result = await captureThread(x(), { fetch: (async (url: RequestInfo | URL) => Response.json({ tweet: tweets[String(url).split("/").at(-1)!] })) as unknown as typeof fetch });
    expect(result.posts.map(p => p.author.handle)).toEqual(["vie", "q", "rhys"]); expect(result.posts[1]?.text).toBe("complete quote");
    const markdown = renderThreadMarkdown(result); expect(markdown).toContain("> > **rhys"); expect(markdown.indexOf("third author")).toBeLessThan(markdown.indexOf("complete quote"));
    expect(renderThreadHtml(result)).toContain("<blockquote><section>");
  });
  test("prioritizes selected author branch and follows bounded frontier reads", async () => {
    const calls: string[] = [];
    const root = node("root", [node("noise", [], { post: post("noise", "noise", { author: { handle: "unrelated.test" } }) }), node("selected", [], { post: post("selected", "selected", { author: { handle: "mandy.test" }, replyCount: 1 }) })]);
    const expanded = node("selected", [node("continuation")], { post: post("selected", "selected", { author: { handle: "mandy.test" }, replyCount: 1 }) });
    const fetcher = (async (input: RequestInfo | URL) => { const uri = new URL(String(input)).searchParams.get("uri")!; calls.push(uri); return Response.json({ thread: uri.endsWith("/selected") ? expanded : root }); }) as unknown as typeof fetch;
    const result = await captureThread(bsky, { fetch: fetcher, depth: 1, selectedAuthors: ["person.test", "mandy.test"] });
    expect(result.posts.map(p => p.text)).toEqual(["root", "selected", "continuation", "noise"]); expect(calls).toHaveLength(2); expect(result.coverage.complete).toBe(false);
    const capped = await captureThread(bsky, { fetch: fetcher, depth: 1, selectedAuthors: ["mandy.test"], maxRequests: 1 }); expect(capped.coverage.limits.join(" ")).toContain("continuation frontier remains");
    const priority = await captureThread(bsky, { fetch: fetcher, depth: 1, selectedAuthors: ["mandy.test"], maxPosts: 2 }); expect(priority.posts.map(p => p.text)).toEqual(["root", "selected"]);
  });
  test("preserves emphasis and source line breaks while neutralizing Markdown unsafe links", async () => {
    const result = await captureThread(x(), { fetch: mock({ tweet: { id: "1", author: { screen_name: "person" }, text: "*emphasis* and **strong**\n\n[okay](https://example.test/?x=1&y=2)\n[bad](javascript:alert(1))\n[reference]: javascript:alert(2)" } }) });
    const markdown = renderThreadMarkdown(result); expect(markdown).toContain("*emphasis* and **strong**\n\n"); expect(markdown).toContain("https://example.test/?x=1&y=2"); expect(markdown).not.toContain("[bad](javascript:"); expect(markdown).not.toContain("[reference]: javascript:");
    const html = renderThreadHtml(result); expect(html).toContain("<em>emphasis</em>"); expect(html).toContain("<strong>strong</strong>"); expect(html).not.toContain('href="javascript:');
  });

  test("nested multiline quotes keep every physical line quoted and retain external embeds", async () => {
    const result = await captureThread(x(), { fetch: mock({ tweet: { id: "1", author: { screen_name: "person" }, text: "outer", quote: { id: "2", author: { screen_name: "quoted" }, text: "first\n\nhttps://example.test/last" } } }), maxRequests: 1 });
    const markdown = renderThreadMarkdown(result); expect(markdown).toContain("> first\n> \n> https://example.test/last");
    const external = await captureThread(bsky, { blueskyScope: "chain", fetch: mock({ thread: node("root", [], { post: post("root", "(linked)", { embed: { $type: "app.bsky.embed.external#view", external: { uri: "https://transformer-circuits.pub/2025/attribution-graphs/biology.html", title: "Biology", description: "description" } } }) }) }) });
    expect(renderThreadMarkdown(external)).toContain("transformer-circuits.pub/2025/attribution-graphs/biology.html"); expect(renderThreadHtml(external)).toContain("Embedded link:");
    expect(() => renderThreadHtml(external, { inlineImages: { evil: "data:image/svg+xml;base64,ZXZpbA==" } })).toThrow();
    const inline = renderThreadHtml(external, { inlineImages: {} }); expect(inline).toContain("img-src data:"); expect(inline).not.toContain("img-src https:");
  });

});
