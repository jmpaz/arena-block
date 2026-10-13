import { describe, expect, test } from "bun:test";
import { BlueskyProvider } from "../src/providers/bluesky.ts";
import { SocialResolver } from "../src/providers/index.ts";
import { composePlan } from "../src/compose.ts";
import { parseSource } from "../src/url.ts";

const did = "did:plc:author";
const uri = (id: string) => `at://${did}/app.bsky.feed.post/${id}`;
const source = parseSource("https://bsky.app/profile/author.test/post/a");
if (source.provider !== "bluesky") throw new Error("Invalid test source");

function post(id: string, parent?: string) {
  return { uri: uri(id), cid: `cid-${id}`, author: { did, handle: "author.test" }, replyCount: 0,
    record: { text: `Text ${id}`, createdAt: "2026-10-11T00:00:00Z", ...(parent ? { reply: {
      parent: { uri: uri(parent), cid: `cid-${parent}` }, root: { uri: uri("a"), cid: "cid-a" },
    } } : {}) } };
}
const a = post("a"), b = post("b", "a"), c = post("c", "b");
const item = (post: Record<string, any>, index: number, count = 3) => ({ post, opThreadPostIndex: index, opThreadPostCount: count });
const ambiguous = { thread: { post: { ...a, replyCount: 27 }, replies: [{ post: b }, { post: post("sibling", "a") }] } };

function provider(pages: unknown[], tree: unknown = ambiguous, onRead?: (url: URL, init?: RequestInit) => void, retainConversationCoverage = false) {
  const requests: URL[] = [];
  let page = 0;
  const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input)); requests.push(url); onRead?.(url, init);
    expect(url.origin).toBe("https://public.api.bsky.app");
    expect(init?.credentials).toBe("omit"); expect(init?.redirect).toBe("error");
    return Response.json(url.pathname.endsWith("getAuthorFeed") ? pages[page++] : tree);
  }) as typeof fetch;
  return { client: new BlueskyProvider("https://public.api.bsky.app", fetcher, { retainConversationCoverage }), requests };
}

describe("provider-identified Bluesky OP thread", () => {
  test("author-thread fixture response resolves all four OP positions despite reply-count gaps and the later sibling", async () => {
    const fixture = await Bun.file(new URL("./fixtures/bluesky-op-thread.json", import.meta.url)).json();
    const ref = fixture.source;
    const parsed = parseSource(ref);
    if (parsed.provider !== "bluesky") throw new Error("Invalid source");
    const { client, requests } = provider([fixture.authorFeed], fixture.thread);
    const resolved = await new SocialResolver({ bluesky: client }).resolveComposition([ref], [], { media: "all", threadExpansion: "on" });
    expect(resolved.posts.map(p => p.id)).toEqual(["3mxjzbrinf22d", "3mxjzmgx6sc2d", "3mxk2eqkcks2d", "3mxk2iwcjec2a"]);
    expect(resolved.posts.map(p => p.selection?.origin)).toEqual(["explicit", "expanded", "expanded", "expanded"]);
    expect(resolved.posts[1]?.selection?.parentUri).toBe(fixture.thread.thread.post.uri);
    expect(requests.map(u => u.pathname)).toEqual(["/xrpc/app.bsky.feed.getPostThread", "/xrpc/app.bsky.feed.getAuthorFeed"]);
    const plan = composePlan(resolved.posts, resolved.policy);
    expect(plan.sources[0]).not.toHaveProperty("threadCoverage");
    const discovery = await provider([fixture.authorFeed], fixture.thread).client.discoverLinear(parsed);
    expect(discovery).toHaveProperty("coverage");
    if (!("coverage" in discovery)) throw new Error("Missing recovery evidence");
    expect(discovery.coverage).toMatchObject({ scope: "author-chain", basis: "appview-op-thread", reportedPosts: 4 });
    expect(discovery.coverage?.replyGaps).toContainEqual({ uri: fixture.thread.thread.post.uri, reported: 27, returned: 26, unavailable: 0 });
    for (const [index, p] of resolved.posts.entries()) {
      expect(plan.sources[index]!.text).toBe(p.text);
      if (!p.facets?.length) expect(plan.block.markdown).toContain(p.text);
    }
    expect(Bun.markdown.html(plan.block.markdown)).toContain('href="https://reference.example/ref_001">https://reference.example/ref_001</a>');
    expect(plan.sources.map(p => p.canonicalUrl)).toEqual(resolved.posts.map(p => p.canonicalUrl));
    expect(plan.sources[0]?.media).toEqual(resolved.posts[0]?.media);
    expect(plan.sources[0]?.quote).toEqual(resolved.posts[0]?.quote);
  });

  test("fetches missing OP positions across opaque cursors, retaining reverse feed order only as evidence", async () => {
    const { client, requests } = provider([
      { feed: [item(c, 3), item(b, 2)], cursor: "opaque&cursor=not-a-date" }, { feed: [item(a, 1)] },
    ]);
    const result = await client.discoverLinear(source);
    expect(result.posts.map(p => p.id)).toEqual(["a", "b", "c"]);
    expect(requests[2]?.searchParams.get("cursor")).toBe("opaque&cursor=not-a-date");
    expect(requests[1]?.searchParams.get("filter")).toBe("posts_with_replies");
  });

  test("depth-truncated author continuations require and receive every reported OP position", async () => {
    const tree = { thread: { post: { ...a, replyCount: 1 }, replies: [{ post: { ...b, replyCount: 1 } }] } };
    const { client } = provider([{ feed: [item(a, 1), item(b, 2), item(c, 3)] }], tree);
    expect((await client.discoverLinear(source)).posts.map(p => p.id)).toEqual(["a", "b", "c"]);
  });

  test("native capture retains observed conversation gaps without changing the CLI source contract", async () => {
    const tree = { thread: { post: { ...a, replyCount: 1 }, replies: [{ post: { ...b, replyCount: 1 } }] } };
    const { client, requests } = provider([], tree, undefined, true);
    const result = await client.discoverLinear(source);
    expect(result.posts.map(p => p.id)).toEqual(["a", "b"]);
    expect(result.posts[0]?.threadCoverage?.replyGaps).toContainEqual({ uri: uri("b"), reported: 1, returned: 0, unavailable: 0 });
    expect(requests).toHaveLength(1);
    const fixture = await Bun.file(new URL("./fixtures/bluesky-op-thread.json", import.meta.url)).json();
    const parsed = parseSource(fixture.source);
    if (parsed.provider !== "bluesky") throw new Error("Invalid source");
    const recovered = await provider([fixture.authorFeed], fixture.thread, undefined, true).client.discoverLinear(parsed);
    expect(recovered.posts).toHaveLength(4);
    expect(recovered.posts[0]?.threadCoverage?.replyGaps).toContainEqual({ uri: fixture.thread.thread.post.uri, reported: 27, returned: 26, unavailable: 0 });
  });

  test("a missing reported position cannot become a partial successful thread", async () => {
    const { client } = provider([{ feed: [item(a, 1), item(c, 3)] }]);
    await expect(client.discoverLinear(source)).rejects.toThrow("verify every author-thread post");
  });

  test("a real fork without provider OP evidence is still rejected", async () => {
    const { client } = provider([{ feed: [{ post: a }, { post: b }, { post: post("sibling", "a") }] }],
      { thread: { post: { ...a, replyCount: 2 }, replies: [{ post: b }, { post: post("sibling", "a") }] } });
    await expect(client.discoverLinear(source)).rejects.toThrow("verify every author-thread post");
  });

  test.each(["parent-cid", "root-cid", "root-view-cid", "count", "extra-position", "two-continuations"])("rejects contradictory %s evidence", async change => {
    const feed = [item(structuredClone(a), 1), item(structuredClone(b), 2), item(structuredClone(c), 3)];
    if (change === "parent-cid") feed[1]!.post.record.reply.parent.cid = "changed";
    if (change === "root-cid") feed[1]!.post.record.reply.root.cid = "changed";
    if (change === "root-view-cid") feed[0]!.post.cid = "changed";
    if (change === "count") feed[1]!.opThreadPostCount = 2;
    if (change === "extra-position") feed.push(item(post("d", "c"), 4, 4));
    if (change === "two-continuations") feed.push(item(post("other", "a"), 2));
    const { client } = provider([{ feed }]);
    await expect(client.discoverLinear(source)).rejects.toThrow();
  });

  test("metadata cannot silently replace an explicitly selected sibling with the OP chain", async () => {
    const sibling = post("sibling", "a");
    const selected = parseSource("https://bsky.app/profile/author.test/post/sibling");
    if (selected.provider !== "bluesky") throw new Error("Invalid source");
    const actualFetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("getAuthorFeed")) return Response.json({ feed: [item(a, 1), item(b, 2), item(c, 3)] });
      return Response.json(url.searchParams.get("uri") === uri("a") ? ambiguous : { thread: { post: sibling, parent: ambiguous.thread } });
    }) as typeof fetch;
    await expect(new BlueskyProvider("https://public.api.bsky.app", actualFetcher).discoverLinear(selected)).rejects.toThrow("retain the selected post");
  });

  test("aborting during evidence acquisition produces no partial result", async () => {
    const abort = new AbortController();
    const { client } = provider([{ feed: [item(a, 1), item(b, 2), item(c, 3)] }], ambiguous, url => {
      if (url.pathname.endsWith("getAuthorFeed")) abort.abort(new Error("interrupted capture"));
    });
    await expect(client.discoverLinear(source, abort.signal)).rejects.toThrow("interrupted capture");
  });

  test("a post changing across paginated evidence is rejected", async () => {
    const changed = { ...a, cid: "changed" };
    const { client } = provider([{ feed: [item(a, 1)], cursor: "next" },
      { feed: [item(changed, 1), item(b, 2), item(c, 3)] }]);
    await expect(client.discoverLinear(source)).rejects.toThrow("changed between reads");
  });

  test("repeated cursors and the total public-read cap fail without partial success", async () => {
    const repeated = provider([{ feed: [item(a, 1)], cursor: "same" }, { feed: [], cursor: "same" }]);
    await expect(repeated.client.discoverLinear(source)).rejects.toThrow("repeated its cursor");
    const capped = provider(Array.from({ length: 20 }, (_, i) => ({ feed: [], cursor: `cursor-${i}` })));
    await expect(capped.client.discoverLinear(source)).rejects.toThrow("bounded read limit");
    expect(capped.requests).toHaveLength(20);
  });

  test("over-limit metadata does not trim a larger thread to twenty posts", async () => {
    const { client } = provider([{ feed: [item(a, 1, 21)] }]);
    await expect(client.discoverLinear(source)).rejects.toThrow("exceeds 20 posts");
  });
});
