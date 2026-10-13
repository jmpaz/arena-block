import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { sha256Hex } from "../extension/src/sha256-node.ts";
import { resolveCapture, revisePlan } from "../extension/src/core.ts";
import { ResolutionGuard } from "../extension/src/resolution-guard.ts";
import { publicationFields, publicationPayload } from "../packages/core/capture.ts";
import { atprotoMarkdown } from "../packages/core/providers/atproto-post.ts";
import type { ResolvedPost } from "../packages/core/types.ts";

test("browser SHA-256 matches the shared core digest for unicode and block boundaries", () => {
  for (const value of ["", "abc", "🦊", "x".repeat(55), "x".repeat(56), "x".repeat(1000)]) {
    expect(sha256Hex(value)).toBe(createHash("sha256").update(value).digest("hex"));
  }
});

test("a late source result cannot overwrite edits or a newer resolution", async () => {
  const guard = new ResolutionGuard();
  let settle!: (value: string) => void;
  const old = new Promise<string>(resolve => { settle = resolve; });
  const ticket = guard.begin();
  let draft = "edited text";
  guard.changed();
  settle("stale source text");
  const result = await old;
  if (guard.current(ticket)) draft = result;
  expect(draft).toBe("edited text");
  const superseded = guard.begin();
  const current = guard.begin();
  expect(guard.current(superseded)).toBe(false);
  expect(guard.current(current)).toBe(true);
});

test("ordinary web capture and edits retain a valid shared plan identity", async () => {
  const original = await resolveCapture({ primary: ["https://example.com/a"], extras: [], policy: {} });
  expect(original.block.kind).toBe("url");
  const revised = revisePlan(original, { title: "Chosen title", description: "Chosen description" });
  expect(revised.block.canonicalSource).toBe(original.block.canonicalSource);
  expect(revised.block.title).toBe("Chosen title");
  expect(revised.block.description).toBe("Chosen description");
  expect(revised.hash).not.toBe(original.hash);
});

test("browser resolver keeps explicit x.com posts and media from an extra post", async () => {
  const requests: string[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(String(input));
    expect(init?.credentials).toBe("omit");
    const id = String(input).split("/").at(-1);
    return Response.json({ code: 200, tweet: { id, author: { screen_name: "author" },
      text: `Text ${id}`, ...(id === "3" ? { media: { photos: [{ url: "https://example.test/image.jpg" }] } } : {}) } });
  }) as typeof fetch;
  const plan = await resolveCapture({ primary: ["https://x.com/author/status/1", "https://x.com/author/status/2"],
    extras: ["https://x.com/author/status/3"], policy: { threadExpansion: "off", media: "all" } }, undefined, fetcher);
  expect(requests).toHaveLength(3);
  expect(plan.sources.map(source => source.id)).toEqual(["1", "2", "3"]);
  expect(plan.sources.map(source => source.selection?.role)).toEqual(["primary", "primary", "extra"]);
  expect(plan.block.markdown).toContain("Text 1");
  expect(plan.block.markdown).toContain("Text 2");
  expect(plan.block.markdown).not.toContain("Text 3");
  expect(plan.block.selectedMedia).toHaveLength(1);
});

test("browser resolver retains the reviewed four-post public x.com sequence and cover", async () => {
  const fixture = await Bun.file(new URL("./fixtures/multi-post-squares.json", import.meta.url)).json() as
    { posts: Array<{ id: string; url: string }> };
  const posts = new Map(fixture.posts.map(post => [post.id, post]));
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.credentials).toBe("omit");
    const id = String(input).split("/").at(-1)!;
    const post = posts.get(id);
    if (!post) throw new Error(`Unexpected status ${id}`);
    return Response.json({ tweet: post });
  }) as typeof fetch;
  const plan = await resolveCapture({ primary: fixture.posts.map(post => post.url), extras: [],
    policy: { threadExpansion: "off", media: "all" } }, undefined, fetcher);
  expect(plan.sources.map(source => source.id)).toEqual(fixture.posts.map(post => post.id));
  expect(plan.block.selectedMedia).toEqual(["1.1"]);
  expect(plan.block.markdown).toContain("11 squares");
});

test("browser resolver expands the reviewed ATProto author thread without losing coverage", async () => {
  const fixture = await Bun.file(new URL("./fixtures/bluesky-op-thread.json", import.meta.url)).json() as
    { source: string; thread: unknown; authorFeed: unknown };
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.credentials).toBe("omit");
    const url = new URL(String(input));
    expect(url.origin).toBe("https://public.api.bsky.app");
    if (url.pathname.endsWith("getPostThread")) return Response.json(fixture.thread);
    if (url.pathname.endsWith("getAuthorFeed")) return Response.json(fixture.authorFeed);
    throw new Error(`Unexpected ATProto request ${url.pathname}`);
  }) as typeof fetch;
  const plan = await resolveCapture({ primary: [fixture.source], extras: [],
    policy: { threadExpansion: "on", media: "all" } }, undefined, fetcher);
  expect(plan.sources.map(source => source.id)).toEqual([
    "3mxjzbrinf22d", "3mxjzmgx6sc2d", "3mxk2eqkcks2d", "3mxk2iwcjec2a",
  ]);
  expect(plan.sources.map(source => source.selection?.origin)).toEqual([
    "explicit", "expanded", "expanded", "expanded",
  ]);
  expect(plan.sources[0]?.threadCoverage?.scope).toBe("author-chain");
});

test("extension core receives public Bluesky and Delve facets without changing source provenance", async () => {
  const cases = [
    { name: "bluesky-url", source: "https://bsky.app/profile/did:plc:pu2ln7ey5emgy37ovouqnncg/post/3mxk2eqkcks2d",
      target: "https://reference.example/ref_001",
      hash: "222f808681002f3da7117ff97958128b3bfeb296fd7a8c680f65fc41fb15c032" },
    { name: "delve-url-quote-card", source: "https://delve.town/profile/did:plc:2vb3emjr2ttkwc2dj534fdqj/post/3mxjqkycz7c2e",
      target: "https://reference.example/ref_002",
      hash: "197d51ca5ab8fa21fbcc716a8eabaeadcd9ffbf83fdd523ff17aaf80b4e1c37d" },
  ] as const;
  for (const item of cases) {
    const packets = await Bun.file(new URL(`./fixtures/atproto-facets/${item.name}-packets.json`, import.meta.url)).json() as
      Array<{ url: string; status: number; headers: Record<string, string>; body: string }>;
    const packet = packets[0]!;
    const raw = JSON.parse(packet.body).thread.post as { uri: string; cid: string; author: { did: string };
      record: { text: string; facets: unknown[] } };
    let reads = 0;
    const fetcher = (async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(packet.url);
      reads++;
      return new Response(packet.body, { status: packet.status, headers: packet.headers });
    }) as typeof fetch;
    const plan = await resolveCapture({ primary: [item.source], extras: [],
      policy: { threadExpansion: "off", media: "all" } }, undefined, fetcher);
    expect(reads).toBe(1);
    expect(plan.hash).toBe(item.hash);
    expect(plan.block.markdown).toContain(`[https://${new URL(item.target).host}`);
    expect(plan.block.markdown).toContain(`](<${item.target}>)`);
    expect(plan.sources[0]?.text).toBe(raw.record.text);
    expect(plan.sources[0]?.facets).toEqual(raw.record.facets as ResolvedPost["facets"]);
    expect(plan.sources[0]?.atproto?.record).toEqual(raw.record);
    expect(plan.sources[0]?.atproto?.uri).toBe(raw.uri);
    expect(plan.sources[0]?.atproto?.cid).toBe(raw.cid);
    expect(plan.sources[0]?.atproto?.authorDid).toBe(raw.author.did);
    const payload = publicationPayload(plan, "", undefined, [17]);
    expect(payload.value).toBe(`arena-block text ${plan.hash}`);
    expect(publicationFields(plan).content).toBe(plan.block.markdown);
    expect(payload.original_source_url).toBe(plan.block.canonicalSource);
    expect(payload.metadata).toEqual({ arena_block_plan: plan.hash, arena_block_version: plan.schemaVersion });
    const edited = revisePlan(plan, { title: "Chosen title" });
    expect(edited.hash).not.toBe(plan.hash);
    expect(edited.sources).toEqual(plan.sources);
    expect(edited.block.markdown).toBe(plan.block.markdown);
  }
});

test("meaningful ATProto labels stay clickable and an old cached plan needs source refresh", async () => {
  const target = "https://reference.example/ref_001";
  const post: ResolvedPost = { provider: "bluesky", id: "fictional", canonicalUrl: "https://bsky.app/profile/fictional/post/fictional",
    author: { name: "Fictional", handle: "fictional.test" }, text: "Read the background", media: [],
    facets: [{ index: { byteStart: 5, byteEnd: 19 },
      features: [{ $type: "app.bsky.richtext.facet#link", uri: target }] }] };
  expect(atprotoMarkdown(post)).toBe(`Read [the background](<${target}>)`);
  const legacy = await Bun.file(new URL("./fixtures/atproto-facets/bluesky-url-legacy-plan.json", import.meta.url)).json() as
    { hash: string; block: { markdown: string }; sources: Array<{ text: string; facets?: unknown }> };
  const packet = (await Bun.file(new URL("./fixtures/atproto-facets/bluesky-url-packets.json", import.meta.url)).json() as
    Array<{ url: string; body: string }>)[0]!;
  const fresh = await resolveCapture({ primary: ["https://bsky.app/profile/did:plc:pu2ln7ey5emgy37ovouqnncg/post/3mxk2eqkcks2d"],
    extras: [], policy: { threadExpansion: "off", media: "all" } }, undefined,
  (async (input: RequestInfo | URL) => {
    expect(String(input)).toBe(packet.url);
    return new Response(packet.body, { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch);
  expect(legacy.block.markdown).toContain("Epic_Sy...");
  expect(legacy.sources[0]?.facets).toBeUndefined();
  expect(fresh.sources[0]?.text).toBe(legacy.sources[0]?.text);
  expect(fresh.block.markdown).toContain(target);
  expect(fresh.hash).not.toBe(legacy.hash);
  expect(legacy.block.markdown).toContain("Epic_Sy...");
});
