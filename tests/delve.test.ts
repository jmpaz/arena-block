import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DelveProvider } from "../src/providers/delve.ts";
import { SocialResolver } from "../src/providers/index.ts";
import { parseSource } from "../src/url.ts";
import { captureSource, publicationFields } from "../src/capture.ts";
import { composePlan } from "../src/compose.ts";
import { blockPlanSchema, planInputSchema } from "../src/types.ts";
import { atprotoPostFromView, atprotoMarkdown, BLUESKY, DELVE } from "../packages/core/providers/atproto-post.ts";
import { createService } from "../src/service.ts";

const did = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
const uri = (id: string, author = did) => `at://${author}/town.delve.feed.post/${id}`;
const web = (id: string, author = did) => `https://delve.town/profile/${author}/post/${id}`;
function post(id: string, parent?: string) {
  return { uri: uri(id), cid: `cid-${id}`, author: { did, handle: "author.delve.town", displayName: "Author" }, replyCount: 0,
    record: { $type: "town.delve.feed.post", text: `Text ${id}`, createdAt: "2026-10-11T00:00:00Z", ...(parent ? { reply: {
      root: { uri: uri("a"), cid: "cid-a" }, parent: { uri: uri(parent), cid: `cid-${parent}` },
    } } : {}) } };
}
function client(read: (url: URL) => unknown) {
  const reads: URL[] = [];
  const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input)); reads.push(url);
    expect(url.origin).toBe("https://api.delve.town");
    expect(init?.credentials).toBe("omit"); expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeDefined();
    if (init?.signal?.aborted) throw init.signal.reason;
    return Response.json(url.pathname.endsWith("resolveHandle") ? { did } : read(url));
  }) as typeof fetch;
  return { provider: new DelveProvider(undefined, fetcher), reads };
}

describe("Delve protocol capture", () => {
  test("URL and AT-URI forms retain the Delve collection and normalize encoded DIDs", () => {
    for (const ref of [web("a"), `${web("a")}/?foo=bar#fragment`, web("a", encodeURIComponent(did)), uri("a")]) {
      expect(parseSource(ref)).toEqual({ provider: "delve", handle: did, id: "a", canonicalUrl: web("a") });
      expect(captureSource(ref)).toEqual({ kind: "social", url: web("a") });
      expect(planInputSchema.parse({ refs: [ref] }).refs).toEqual([ref]);
    }
    expect(parseSource(web("a", "author.delve.town")).provider).toBe("delve");
    expect(parseSource(`at://${did}/app.bsky.feed.post/a`).provider).toBe("bluesky");
    const webDid = "did:web:example.com%3A8443";
    expect(parseSource(`at://${webDid}/town.delve.feed.post/a`)).toMatchObject({ handle: webDid });
    expect(parseSource(web("a", encodeURIComponent(webDid)))).toMatchObject({ handle: webDid });
    for (const collection of ["town.delve", "app.bsky"]) {
      const selected = parseSource(`at://${webDid}/${collection}.feed.post/a`);
      expect(parseSource(selected.canonicalUrl)).toMatchObject({ handle: webDid });
    }
    const actual = post("a");
    const normalized = atprotoPostFromView({ ...actual, uri: uri("a", webDid), author: { ...actual.author, did: webDid } }, DELVE);
    expect(parseSource(normalized.canonicalUrl)).toMatchObject({ handle: webDid });
    expect(normalized.atproto?.uri).toBe(uri("a", webDid));
  });

  test.each(["https://delve.town/", "https://delve.town/profile/author.delve.town", "https://delve.town/profile/author.delve.town/post/a/more", "http://delve.town/profile/author.delve.town/post/a", "https://user:pass@delve.town/profile/author.delve.town/post/a", "https://delve.town:444/profile/author.delve.town/post/a", "https://delve.town/profile/did%3Aplc%3Ashort/post/a", `at://${did}/town.delve.feed.like/a`])("rejects unsupported Delve input %s", ref => {
    expect(() => parseSource(ref)).toThrow();
    expect(() => captureSource(ref)).toThrow();
  });

  test("resolves the handle before fetching the native collection and rejects a different source", async () => {
    const { provider, reads } = client(() => ({ thread: { post: post("a") } }));
    const resolved = await provider.resolve(parseSource(web("a", "author.delve.town")));
    expect(reads.map(url => url.pathname)).toEqual(["/xrpc/com.atproto.identity.resolveHandle", "/xrpc/town.delve.feed.getPostThread"]);
    expect(reads[1]!.searchParams.get("uri")).toBe(uri("a"));
    expect(reads[1]!.searchParams.get("depth")).toBe("0");
    expect(resolved.canonicalUrl).toBe(web("a"));
    expect(resolved.atproto).toMatchObject({ uri: uri("a"), cid: "cid-a", authorDid: did });
    await expect(client(() => ({ thread: { post: post("different") } })).provider.resolve(parseSource(web("a")))).rejects.toThrow("different post");
  });

  test("retained public quote/external fixture preserves text, facets, actual quoted identity and card fields", async () => {
    const fixture = await Bun.file(new URL("./fixtures/delve-quote-external.json", import.meta.url)).json();
    const { provider } = client(() => fixture);
    const selected = fixture.thread.post.uri;
    const result = await new SocialResolver({ delve: provider }).resolveComposition([selected], [], { threadExpansion: "off" });
    const plan = composePlan(result.posts, result.policy), first = plan.sources[0]!;
    expect(first.text).toBe(fixture.thread.post.record.text);
    expect(first.atproto?.record).toEqual(fixture.thread.post.record);
    expect(first.quote?.canonicalUrl).toBe("https://delve.town/profile/did:plc:vjswazbmm3hqvwmmxtw7q77u/post/3mxjoxgdedk27");
    expect(first.external?.title).toBe(fixture.thread.post.embed.media.external.title);
    expect(plan.block.title).toBe("Post by @writer-delve.example");
    expect(Bun.markdown.html(plan.block.markdown)).toContain('href="https://reference.example/ref_002">https://reference.example/ref_002</a>');
    expect(plan.block.markdown).toContain("`@quoted-writer.example`");
    expect(plan.block.kind).toBe("text");
    expect(blockPlanSchema.parse(plan)).toEqual(plan);
    expect(publicationFields(plan).content).toBe(plan.block.markdown);
    const omitted = composePlan(result.posts, { quote: "omit" });
    expect(omitted.block.markdown).not.toContain("`@quoted-writer.example`");
    expect(omitted.block.markdown).toContain(first.external!.title);
    const changed = structuredClone(fixture.thread.post);
    changed.record.embed.record.record.cid = "changed";
    expect(() => atprotoPostFromView(changed, DELVE)).toThrow("quote reference changed");
  });

  test("HTTP preview accepts Delve AT URIs and respects thread-off without sending any publication request", async () => {
    const fixture = await Bun.file(new URL("./fixtures/delve-quote-external.json", import.meta.url)).json();
    const requests: URL[] = [], original = globalThis.fetch;
    globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input)); requests.push(url);
      expect(init?.method ?? "GET").toBe("GET");
      expect(url.origin).toBe("https://api.delve.town");
      expect(url.searchParams.get("depth")).toBe("0");
      return Response.json(fixture);
    }) as typeof fetch;
    const directory = await mkdtemp(join(tmpdir(), "arena-delve-preview-"));
    let service: ReturnType<typeof createService> | undefined;
    try {
      service = createService({ host: "127.0.0.1", port: 8790, publicBaseUrl: "https://capture.invalid", stateDirectory: directory, mediaDirectory: directory, accessToken: "test-access", arenaToken: "unused-publication-token" });
      globalThis.fetch = original;
      const response = await service.handler(new Request("http://localhost/v1/capture/preview", { method: "POST", headers: { authorization: "Bearer test-access", "content-type": "application/json" }, body: JSON.stringify({ url: fixture.thread.post.uri, threadExpansion: "off", media: "none" }) }));
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.kind).toBe("social");
      expect(result.plan.sources).toHaveLength(1);
      expect(result.plan.policy.threadExpansion).toBe("off");
      expect(result.plan.sources[0].atproto.uri).toBe(fixture.thread.post.uri);
      expect(requests).toHaveLength(1);
    } finally {
      globalThis.fetch = original;
      service?.close(); await rm(directory, { recursive: true, force: true });
    }
  });

  test.each([DELVE, BLUESKY])("shared normalization handles UTF-8 rich text for $provider", app => {
    const source = { ...post("a"), uri: `at://${did}/${app.namespace}.feed.post/a`, record: {
      $type: `${app.namespace}.feed.post`, text: "👋 café 界 link", createdAt: "2026-10-11T00:00:00Z",
      facets: [{ index: { byteStart: 15, byteEnd: 19 }, features: [{ $type: `${app.namespace}.richtext.facet#link`, uri: "https://example.com/full" }] }],
    } };
    const resolved = atprotoPostFromView(source, app);
    expect(resolved.text).toBe("👋 café 界 link");
    expect(atprotoMarkdown(resolved)).toBe("👋 café 界 [link](<https://example.com/full>)");
    expect(resolved.provider).toBe(app.provider);
    resolved.facets![0]!.index.byteStart = 1;
    expect(() => atprotoMarkdown(resolved)).toThrow("facets");
  });

  test("mentions keep DID identity and hashtags keep source text and raw metadata", () => {
    const item = post("a");
    const record = { ...item.record, text: "@old #tag", facets: [
      { index: { byteStart: 0, byteEnd: 4 }, features: [{ $type: "town.delve.richtext.facet#mention", did }] },
      { index: { byteStart: 5, byteEnd: 9 }, features: [{ $type: "town.delve.richtext.facet#tag", tag: "tag" }] },
    ] };
    const resolved = atprotoPostFromView({ ...item, record }, DELVE);
    expect(atprotoMarkdown(resolved)).toBe(`[@old](<https://delve.town/profile/${did}>) #tag`);
    expect(resolved.facets).toEqual(record.facets);
    resolved.facets![0]!.features = [{ $type: "town.delve.richtext.facet#link", uri: uri("b") }];
    expect(atprotoMarkdown(resolved)).toBe(`[@old](<${web("b")}>) #tag`);
  });

  test("Delve long posts and paragraph breaks are retained without the Bluesky text limit", () => {
    const base = post("a"), text = "界".repeat(99_990) + "\n\nEnding";
    const normalized = atprotoPostFromView({ ...base, record: { ...base.record, text } }, DELVE);
    const plan = composePlan([normalized], { media: "none" });
    expect(plan.sources[0]!.text).toBe(text);
    expect(plan.block.markdown).toBe(text);
    expect(plan.block.title).toBe("Post by @author.delve.town");
  });

  test("image galleries and video playlists preserve order, alt text, geometry and poster metadata", () => {
    const base = post("a");
    const gallery = { $type: "town.delve.embed.gallery#view", items: [1, 2].map(index => ({ $type: "town.delve.embed.gallery#viewImage", fullsize: `https://example.com/${index}.jpg`, thumbnail: `https://example.com/${index}-thumb.jpg`, alt: `Alt ${index}`, aspectRatio: { width: 640, height: 480 } })) };
    const images = atprotoPostFromView({ ...base, embed: gallery }, DELVE);
    expect(images.media.map(item => item.url)).toEqual(["https://example.com/1.jpg", "https://example.com/2.jpg"]);
    expect(images.media[1]).toMatchObject({ alt: "Alt 2", width: 640, height: 480 });
    const video = atprotoPostFromView({ ...base, embed: { $type: "town.delve.embed.video#view", playlist: "https://example.com/video.m3u8", thumbnail: "https://example.com/poster.jpg", alt: "Video alt", aspectRatio: { width: 1920, height: 1080 } } }, DELVE);
    expect(video.media[0]).toMatchObject({ kind: "video", url: "https://example.com/video.m3u8", posterUrl: "https://example.com/poster.jpg", alt: "Video alt" });
    expect(blockPlanSchema.parse(composePlan([video])).sources[0]!.media[0]!.posterUrl).toBe("https://example.com/poster.jpg");
    gallery.items[0]!.$type = "town.delve.embed.gallery#viewVideo";
    expect(() => atprotoPostFromView({ ...base, embed: gallery }, DELVE)).toThrow("unsupported item");
  });

  test.each(["viewNotFound", "viewBlocked", "viewDetached", "generatorView"])("unavailable or non-post quote %s has a visible identity without an invented author", variant => {
    const base = post("a");
    const resolved = atprotoPostFromView({ ...base, embed: { $type: "town.delve.embed.record#view", record: { $type: `town.delve.embed.record#${variant}`, uri: uri("b") } } }, DELVE);
    expect(resolved.quote).toBeUndefined();
    expect(resolved.embeddedRecord?.uri).toBe(uri("b"));
    expect(composePlan([resolved]).block.markdown).toContain(uri("b"));
    expect(composePlan([resolved], { quote: "omit" }).block.markdown).not.toContain(uri("b"));
  });

  test("quote depth retains identified unavailable descendants only within the requested boundary", () => {
    const parent = atprotoPostFromView(post("a"), DELVE);
    const quoted = atprotoPostFromView({ ...post("b"), embed: { $type: "town.delve.embed.record#view", record: { $type: "town.delve.embed.record#viewNotFound", uri: uri("c") } } }, DELVE);
    parent.quote = quoted;
    expect(composePlan([parent], { quoteDepth: 1 }).block.markdown).not.toContain(uri("c"));
    expect(composePlan([parent], { quoteDepth: 2 }).block.markdown).toContain(uri("c"));
    expect(composePlan([parent], { quoteDepth: 0 }).block.markdown).not.toContain("Text b");
    expect(composePlan([parent], { quote: "omit" }).block.markdown).not.toContain(uri("c"));
    expect(parent.quote.embeddedRecord?.uri).toBe(uri("c"));
  });

  test("wrong collections, unsafe facet URLs and unknown embeds fail visibly", () => {
    const base = post("a");
    expect(() => atprotoPostFromView({ ...base, record: { ...base.record, $type: "app.bsky.feed.post" } }, DELVE)).toThrow("different record type");
    expect(() => atprotoPostFromView({ ...base, embed: { $type: "town.delve.embed.future#view" } }, DELVE)).toThrow("unsupported embed");
    const resolved = atprotoPostFromView({ ...base, record: { ...base.record, facets: [{ index: { byteStart: 0, byteEnd: 4 }, features: [{ $type: "town.delve.richtext.facet#link", uri: "javascript:alert(1)" }] }] } }, DELVE);
    expect(() => composePlan([resolved])).toThrow("unsafe destination");
  });

  test("checked author-chain expansion preserves selected origin, quote policy and media-only extras", async () => {
    const a = post("a"), b = post("b", "a"), c = post("c", "b");
    const tree = { post: { ...a, replyCount: 1 }, replies: [{ post: { ...b, replyCount: 1 }, replies: [{ post: c }] }] };
    const { provider, reads } = client(url => ({ thread: url.searchParams.get("uri") === uri("b") ? { post: b, parent: { post: a } } : tree }));
    const result = await new SocialResolver({ delve: provider }).resolveComposition([web("b")], [web("b")], { threadExpansion: "on", media: "all" });
    expect(result.posts.map(item => item.id)).toEqual(["a", "b", "c"]);
    expect(result.posts.map(item => item.selection?.origin)).toEqual(["expanded", "explicit", "expanded"]);
    expect(result.posts[2]!.selection?.parentUri).toBe(uri("b"));
    expect(reads.map(url => url.pathname)).toEqual(["/xrpc/town.delve.feed.getPostThread", "/xrpc/town.delve.feed.getPostThread"]);
    expect(result.policy.mediaOnlyPosts).toEqual([]);
    const off = await new SocialResolver({ delve: provider }).resolveComposition([web("b")], [], { threadExpansion: "off" });
    expect(off.posts.map(item => item.id)).toEqual(["b"]);
  });

  test("retained public Delve responses reconstruct the three-post author chain from a middle seed", async () => {
    const fixture = await Bun.file(new URL("./fixtures/delve-author-thread.json", import.meta.url)).json();
    const selectedUri = fixture.selected.thread.post.uri;
    const { provider } = client(url => url.searchParams.get("uri") === selectedUri ? fixture.selected : fixture.root);
    const result = await new SocialResolver({ delve: provider }).resolveComposition([selectedUri], [], { threadExpansion: "on" });
    expect(result.posts.map(item => item.id)).toEqual(["3mxe7fekwnk2u", "3mxe7nb7vfk2u", "3mxeads7s6k2m"]);
    expect(result.posts.map(item => item.selection?.origin)).toEqual(["expanded", "explicit", "expanded"]);
    expect(result.posts.every(item => item.atproto?.authorDid === "did:plc:2vb3emjr2ttkwc2dj534fdqj")).toBe(true);
    expect(result.posts[2]!.atproto?.reply?.root.uri).toBe(fixture.root.thread.post.uri);
  });

  test.each(["gap", "fork", "unavailable", "parent-cid", "root-cid"])("Delve %s evidence cannot trigger a Bluesky OP-feed fallback", async change => {
    const a = post("a"), b = post("b", "a");
    const tree: any = { thread: { post: { ...a, replyCount: 1 }, replies: [{ post: b }] } };
    if (change === "gap") tree.thread.post.replyCount = 2;
    if (change === "fork") { tree.thread.post.replyCount = 2; tree.thread.replies.push({ post: post("c", "a") }); }
    if (change === "unavailable") tree.thread.replies = [{ $type: "town.delve.feed.defs#notFoundPost", uri: uri("b"), notFound: true }];
    if (change === "parent-cid") b.record.reply!.parent.cid = "changed";
    if (change === "root-cid") b.record.reply!.root.cid = "changed";
    const { provider, reads } = client(() => tree), selected = parseSource(web("a"));
    if (selected.provider !== "delve") throw new Error("Invalid test source");
    await expect(provider.discoverLinear(selected)).rejects.toThrow(/Delve/);
    expect(reads.every(url => url.pathname === "/xrpc/town.delve.feed.getPostThread")).toBe(true);
  });

  test("aborted and oversized public reads return no plan", async () => {
    const aborted = new AbortController(); aborted.abort(new Error("stop capture"));
    await expect(client(() => ({})).provider.resolve(parseSource(web("a")), aborted.signal)).rejects.toThrow("stop capture");
    const provider = new DelveProvider(undefined, (async (_input: URL | RequestInfo) => new Response(" ".repeat(2 * 1024 * 1024 + 1))) as typeof fetch);
    await expect(provider.resolve(parseSource(web("a")))).rejects.toThrow("2 MiB");
  });
  test("automatic Delve author-chain composition retains authored mentions, dividers and images", async () => {
    const a = post("a"), b = post("b", "a");
    b.record.text = "@friend.delve.town literal continuation";
    const image = { $type: "town.delve.embed.images#view", images: [{ fullsize: "https://example.com/original.jpg", alt: "Source alt" }] };
    const { provider } = client(() => ({ thread: { post: { ...a, replyCount: 1, embed: image }, replies: [{ post: b }] } }));
    const resolved = await new SocialResolver({ delve: provider }).resolveComposition([web("a")], [], { threadExpansion: "auto" });
    const planned = composePlan(resolved.posts, resolved.policy);
    expect(planned.block.markdown).toContain(b.record.text);
    expect(planned.block.markdown).toContain("\n\n---\n\n");
    expect(planned.block.selectedMedia).toEqual(["1.1"]);
  });

});
