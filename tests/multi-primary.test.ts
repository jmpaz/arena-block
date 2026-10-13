import { describe, expect, test } from "bun:test";
import { composePlan } from "../src/compose.ts";
import { publicationFields } from "../src/capture.ts";
import { BlueskyProvider, linearAuthorThread } from "../src/providers/bluesky.ts";
import { SocialResolver } from "../src/providers/index.ts";
import { XProvider } from "../src/providers/x.ts";
import { parseSource, type ParsedSource } from "../src/url.ts";
import type { ResolvedPost } from "../src/types.ts";

const xIds = ["99999999999999999003", "99999999999999999004", "99999999999999999005"];
const firstThreadId = "99999999999999999002";
const xRefs = [
  `https://x.com/example_writer/status/${xIds[0]}`,
  `https://x.com/example_writer/status/${xIds[0]}?s=20`,
  `https://x.com/example_writer/status/${xIds[1]}?s=20`,
  `https://x.com/example_writer/status/${xIds[2]}?s=20`,
];

function fictionalPost(source: ParsedSource): ResolvedPost {
  return { provider: source.provider, id: source.id, canonicalUrl: source.canonicalUrl,
    author: { handle: source.provider === "instagram" ? "otherauthor" : "example_writer" },
    postedAt: "2026-10-06T16:30:00Z", text: `Fixture text ${source.id}`,
    media: source.id === firstThreadId || source.id === "999" || source.provider === "instagram" ? [
      { ref: "0.0", kind: source.provider === "instagram" ? "video" : "image", url: `https://example.test/${source.id}`, alt: "" },
    ] : [] };
}

describe("ordered primary source selection", () => {
  test("four supplied example writer links mean three unique posts, with no invented first-post image", async () => {
    const reads: string[] = [];
    const resolver = new SocialResolver({ x: { resolve: async source => { reads.push(source.id); return fictionalPost(source); } } });
    const resolved = await resolver.resolveComposition(xRefs);
    const plan = composePlan(resolved.posts, resolved.policy);
    expect(reads).toEqual(xIds);
    expect(plan.sources.map(source => source.id)).toEqual(xIds);
    expect(plan.sources.map(source => source.selection?.declaredIndex)).toEqual([1, 3, 4]);
    expect(plan.block.selectedMedia).toEqual([]);
    expect(plan.block.kind).toBe("text");
    for (const id of xIds) {
      expect(plan.block.markdown).toContain(`Fixture text ${id}`);
      expect(plan.sources.find(source => source.id === id)?.canonicalUrl).toBe(`https://x.com/example_writer/status/${id}`);
    }
    expect(plan.block.markdown).not.toContain("[source](");
    expect(plan.block.markdown.match(/Fixture text/g)).toHaveLength(3);
  });

  test("fictional four-post sequence keeps the image, authored mentions and permalinks", async () => {
    const fixture = await Bun.file(new URL("./fixtures/multi-post-squares.json", import.meta.url)).json() as {
      posts: Array<{ id: string; replying_to_status?: string; text: string }>;
    };
    const byId = new Map(fixture.posts.map(post => [post.id, post]));
    expect(fixture.posts.map(post => post.replying_to_status ?? null)).toEqual([null, fixture.posts[0]!.id, fixture.posts[1]!.id, fixture.posts[2]!.id]);
    const provider = new XProvider("https://api.fxtwitter.com", async input => {
      const id = String(input).split("/").at(-1)!;
      return Response.json({ code: 200, tweet: byId.get(id) });
    });
    const resolver = new SocialResolver({ x: provider });
    const first = `https://x.com/example_writer/status/${fixture.posts[0]!.id}`;
    const resolved = await resolver.resolveComposition([first, ...xRefs]);
    const plan = composePlan(resolved.posts, resolved.policy);
    expect(plan.sources.map(post => post.id)).toEqual(fixture.posts.map(post => post.id));
    expect(plan.block.selectedMedia).toEqual(["1.1"]);
    expect(plan.sources.map(post => post.replyAddressPrefix)).toEqual([undefined, "@reader_a @reader_b @reader_c @reader_d @reader_e ", "@reader_a @reader_b @reader_c @reader_d @reader_e ", "@reader_a @reader_b @reader_c @reader_d @reader_e "]);
    expect(plan.block.markdown.match(/\d\/n/g)).toHaveLength(4);
    for (const [index, post] of fixture.posts.entries()) {
      if (!index) expect(plan.block.markdown).toContain(post.text);
      else expect(plan.block.markdown).toContain(post.text.replace(/^(@[\w.-]+\s+)+/, ""));
      expect(plan.sources.find(source => source.id === post.id)?.canonicalUrl).toBe(`https://x.com/example_writer/status/${post.id}`);
      expect(plan.sources[index]?.text).toBe(post.text);
      expect(plan.sources[index]?.replyTo?.id).toBe(post.replying_to_status ?? undefined);
    }
    expect(plan.block.markdown).not.toContain("@reader_a @reader_b @reader_c @reader_d @reader_e");
    expect(plan.block.markdown).toContain("Thanks to @reader_a, @reader_b");
    expect(plan.block.markdown).not.toContain("[source](");
    expect(plan.block.markdown).not.toContain("`@example_writer`");
    expect(publicationFields(plan).description).toContain("A short paper explains the example.");
  });

  test("x.com reply mentions stay visible when display facets are absent or inconsistent", async () => {
    const fixture = await Bun.file(new URL("./fixtures/multi-post-squares.json", import.meta.url)).json() as { posts: Array<Record<string, any>> };
    const source = parseSource(`https://x.com/example_writer/status/${fixture.posts[1]!.id}`);
    for (const change of ["absent", "wrong_facet", "wrong_prefix", "visible_range"]) {
      const tweet = structuredClone(fixture.posts[1]!);
      if (change === "absent") delete tweet.raw_text;
      if (change === "wrong_facet") tweet.raw_text.facets[0].type = "url";
      if (change === "wrong_prefix") tweet.text = "@different " + tweet.text;
      if (change === "visible_range") tweet.raw_text.display_text_range[0] = 0;
      const provider = new XProvider("https://api.fxtwitter.com", async () => Response.json({ code: 200, tweet }));
      const resolved = await provider.resolve(source);
      expect(resolved.replyTo?.id).toBe(fixture.posts[0]!.id);
      expect(resolved.replyAddressPrefix).toBeUndefined();
    }
  });

  test("x.com and Instagram are both primary; extra contributes only media", async () => {
    const resolver = new SocialResolver({ x: { resolve: async source => fictionalPost(source) }, instagram: { resolve: async source => fictionalPost(source) } });
    const instagram = "https://www.instagram.com/p/Caption123/";
    const resolved = await resolver.resolveComposition([`https://x.com/example_writer/status/${firstThreadId}`, instagram], ["https://x.com/another/status/999"]);
    const plan = composePlan(resolved.posts, resolved.policy);
    expect(plan.sources.map(source => source.selection?.role)).toEqual(["primary", "primary", "extra"]);
    expect(plan.policy.mediaOnlyPosts).toEqual([3]);
    expect(plan.block.selectedMedia).toEqual(["1.1", "2.1", "3.1"]);
    expect(plan.block.kind).toBe("video");
    expect(plan.block.markdown).toContain("Fixture text Caption123");
    expect(plan.block.markdown).not.toMatch(/(?:^|\n)Fixture text 999(?:\n|$)/);
    expect(plan.block.markdown).toContain("`@otherauthor`\nFixture text Caption123");
    expect(plan.sources[1]?.canonicalUrl).toBe(instagram);
  });

  test("a repeated primary cannot re-enter as media-only and stale legacy indexes are cleared", async () => {
    const resolver = new SocialResolver({ x: { resolve: async source => fictionalPost(source) } });
    const primary = `https://x.com/example_writer/status/${firstThreadId}`;
    const resolved = await resolver.resolveComposition([primary], [`${primary}?s=20`]);
    expect(resolved.posts).toHaveLength(1);
    expect(resolved.posts[0]?.selection?.role).toBe("primary");
    expect(resolved.policy.mediaOnlyPosts).toEqual([]);
    const legacy = await resolver.resolveComposition([primary, `${primary}?s=20`], [], { mediaOnlyPosts: [2] });
    expect(legacy.policy.mediaOnlyPosts).toEqual([]);
    expect(composePlan(legacy.posts, legacy.policy).block.selectedMedia).toEqual(["1.1"]);
  });

  test("provider-normalized Bluesky aliases deduplicate after resolution", async () => {
    const resolver = new SocialResolver({ bluesky: { resolve: async source => ({
      ...fictionalPost(source), provider: "bluesky", canonicalUrl: "https://bsky.app/profile/author.test/post/abc",
    }) } });
    const resolved = await resolver.resolveComposition([
      "https://bsky.app/profile/author.test/post/abc",
      "https://bsky.app/profile/did:plc:alias/post/abc",
    ]);
    expect(resolved.posts).toHaveLength(1);
    expect(resolved.posts[0]?.selection?.declaredIndex).toBe(1);
  });
});

const did = "did:plc:fixture";
const uri = (id: string) => `at://${did}/app.bsky.feed.post/${id}`;
function view(id: string, parent?: string) {
  return { uri: uri(id), cid: `cid-${id}`, author: { did, handle: "author.test" }, replyCount: id === "c" ? 0 : 1,
    record: { text: `Text ${id}`, createdAt: "2026-10-06T12:00:00Z",
      ...(parent ? { reply: { root: { uri: uri("a"), cid: "cid-a" }, parent: { uri: uri(parent), cid: `cid-${parent}` } } } : {}) } };
}
const chain = { post: view("a"), replies: [{ post: view("b", "a"), replies: [{ post: view("c", "b"), replies: [] }] }] };
const seedThread = { thread: { post: view("b", "a"), parent: { post: view("a") }, replies: [{ post: view("c", "b"), replies: [] }] } };
const rootThread = { thread: chain };
const source = parseSource("https://bsky.app/profile/author.test/post/b") as Extract<ParsedSource, { provider: "bluesky" }>;

describe("bounded Bluesky expansion", () => {
  test("reads the ancestor root, verifies reply edges and keeps the explicit seed identifiable", async () => {
    const requests: string[] = [];
    const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
      requests.push(String(input));
      expect(init?.credentials).toBe("omit");
      expect(init?.redirect).toBe("error");
      return Response.json(requests.length === 1 ? seedThread : rootThread);
    }) as typeof fetch;
    const resolver = new SocialResolver({ bluesky: new BlueskyProvider("https://public.api.bsky.app", fetcher) });
    const resolved = await resolver.resolveComposition([source.canonicalUrl]);
    expect(requests).toHaveLength(2);
    expect(resolved.posts.map(post => post.id)).toEqual(["a", "b", "c"]);
    expect(resolved.posts.map(post => post.selection?.origin)).toEqual(["expanded", "explicit", "expanded"]);
    expect(resolved.posts[1]?.selection?.parentUri).toBe(uri("a"));
    expect(composePlan(resolved.posts, resolved.policy).block.markdown).toContain("Text c");
  });

  test("appends an extra after the expanded chain and recalculates its media-only index", async () => {
    const fetcher = (async (input: URL | RequestInfo) => Response.json(
      String(input).includes(encodeURIComponent(uri("a"))) ? rootThread : seedThread,
    )) as typeof fetch;
    const resolver = new SocialResolver({ bluesky: new BlueskyProvider("https://public.api.bsky.app", fetcher),
      x: { resolve: async requested => fictionalPost(requested) } });
    const resolved = await resolver.resolveComposition([source.canonicalUrl], ["https://x.com/supplement/status/999"]);
    expect(resolved.posts.map(post => post.id)).toEqual(["a", "b", "c", "999"]);
    expect(resolved.policy.mediaOnlyPosts).toEqual([4]);
    const plan = composePlan(resolved.posts, resolved.policy);
    expect(plan.block.selectedMedia).toEqual(["4.1"]);
    expect(plan.block.markdown).not.toMatch(/(?:^|\n)Fixture text 999(?:\n|$)/);
  });

  test("requires explicit choice for a fork, unavailable node or incomplete reply coverage", () => {
    expect(() => linearAuthorThread({ thread: { post: view("a"), replies: [
      { post: view("b", "a") }, { post: { ...view("c", "a"), replyCount: 0 } },
    ] } }, source)).toThrow("forks");
    expect(() => linearAuthorThread({ thread: { post: view("b", "a"), parent: { $type: "app.bsky.feed.defs#notFoundPost" } } }, source)).toThrow("unavailable parent");
    expect(() => linearAuthorThread({ thread: { post: { ...view("a"), replyCount: 2 }, replies: [{ post: view("b", "a") }] } }, source)).toThrow("incomplete");
    expect(() => linearAuthorThread({ thread: { post: { ...view("a"), replyCount: undefined }, replies: [] } }, source)).toThrow("incomplete");
  });

  test("native conversation gaps remain scoped and known unavailable author posts still fail", () => {
    const options = { retainConversationCoverage: true };
    const observed = linearAuthorThread({ thread: { post: { ...view("a"), replyCount: 31 }, replies: [
      { post: { ...view("b", "a"), replyCount: 0 } },
      { $type: "app.bsky.feed.defs#notFoundPost", uri: "at://did:plc:other/app.bsky.feed.post/gone" },
    ] } }, source, undefined, options);
    expect(observed.posts.map(post => post.id)).toEqual(["a", "b"]);
    expect(observed.posts[0]?.threadCoverage?.replyGaps[0]).toEqual({ uri: uri("a"), reported: 31, returned: 1, unavailable: 1 });
    expect(composePlan(observed.posts, {}).sources[0]?.threadCoverage?.replyGaps).toHaveLength(1);
    expect(() => linearAuthorThread({ thread: { post: view("a"), replies: [
      { $type: "app.bsky.feed.defs#notFoundPost", uri: uri("gone") },
    ] } }, source, undefined, options)).toThrow("connected author post is unavailable");
    expect(linearAuthorThread({ thread: { post: { ...view("a"), replyCount: undefined }, replies: [] } }, source, uri("a"), options).posts).toHaveLength(1);
  });

  test("off retains only the selected post without discovery", async () => {
    const resolver = new SocialResolver({ bluesky: { resolve: async requested => ({ ...fictionalPost(requested), provider: "bluesky" }) } });
    const resolved = await resolver.resolveComposition([source.canonicalUrl], [], { threadExpansion: "off" });
    expect(resolved.posts.map(post => post.id)).toEqual(["b"]);
    expect(resolved.policy.threadExpansion).toBe("off");
  });
});
