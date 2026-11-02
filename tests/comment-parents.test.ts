import { expect, test } from "bun:test";
import { composePlan, planHash } from "../packages/core/compose.ts";
import { blockPlanSchema, compositionPolicySchema, resolvedPostSchema, type ResolvedPost } from "../packages/core/types.ts";
import { HackerNewsProvider } from "../packages/core/providers/hackernews.ts";
import { LobstersProvider } from "../packages/core/providers/lobsters.ts";
import { parseSource } from "../packages/core/url.ts";
import { requiredPlanCapabilities } from "../src/plan-capabilities.ts";
import { requiredCompositionCapabilities, requireRetainedCompositionPolicy } from "../packages/core/composition-capabilities.ts";
import { ArenaBlockClient } from "../src/client.ts";

const hn = (id: number) => `https://news.ycombinator.com/item?id=${id}`;
function fixtures(data: Record<string, unknown>) {
  const calls: string[] = [];
  return { calls, fetcher: async (url: string, init?: RequestInit) => {
    calls.push(url); init?.signal?.throwIfAborted();
    return url in data ? Response.json(data[url]) : new Response(null, { status: 404 });
  } };
}
function item(id: number, parent: number) { return { id, parent, type: "comment", by: `user${id}`, text: `Comment ${id}<p>---<p>Literal body`, time: 1704067200 }; }
async function hnPost(overrides: Record<string, unknown> = {}) {
  const data = { "https://hacker-news.firebaseio.com/v0/item/4.json": item(4, 3), "https://hacker-news.firebaseio.com/v0/item/3.json": item(3, 2),
    "https://hacker-news.firebaseio.com/v0/item/2.json": item(2, 1), "https://hacker-news.firebaseio.com/v0/item/1.json": { id: 1, type: "story", title: "Story", text: "Submission must not be a comment" }, ...overrides };
  const api = fixtures(data);
  return { post: await new HackerNewsProvider(api.fetcher).resolve(parseSource(hn(4))), ...api };
}

test("depth zero preserves selected behavior; flat ancestors are oldest first, separated and independently credited", async () => {
  const { post } = await hnPost();
  const original = { ...post }; delete original.parentContext;
  expect(composePlan([post]).block).toEqual(composePlan([original]).block);
  const plan = blockPlanSchema.parse(composePlan([post], { parentDepth: 1, parentStyle: "flat", quoteDepth: 0, quote: "omit" }));
  expect(plan.block.markdown).toBe("`user3`\nComment 3\n\n\\---\n\nLiteral body\n\n---\n\n`user4`\nComment 4\n\n\\---\n\nLiteral body");
  expect(plan.sources).toEqual([post]); expect(plan.block.canonicalSource).toBe(hn(4));
  expect(plan.block.title).toBe("Comment by user4 on “Story”");
  expect(plan.block.markdown).not.toContain("Submission must");
  expect(post.parentContext?.parents.map(x => x.id)).toEqual(["3", "2"]);
  expect(post.parentContext?.stopped).toBe("submission");
});

test("nested parents use the exact Twitter quote renderer, including dates, links, nesting and source escaping", async () => {
  const { post } = await hnPost();
  const nodes = post.parentContext!.parents;
  const asPost = (index: number): ResolvedPost => ({ provider: post.provider, id: nodes[index]!.id, canonicalUrl: nodes[index]!.canonicalUrl,
    author: nodes[index]!.author!, text: nodes[index]!.text!, postedAt: nodes[index]!.postedAt, media: [], ...(index + 1 < nodes.length ? { quote: asPost(index + 1) } : {}) });
  const quoted = { ...post, quote: asPost(0) }; delete quoted.parentContext;
  for (const quoteAuthorLink of [undefined, "source", "plain"] as const) {
    expect(composePlan([post], { parentDepth: 2, parentStyle: "quote", quoteDates: "source", quoteAuthorLink }).block.markdown)
      .toBe(composePlan([quoted], { quoteDepth: 2, quoteDates: "source", quoteAuthorLink }).block.markdown);
  }
  expect(composePlan([post], { parentDepth: 0, parentStyle: "quote" }).block.markdown).not.toContain("user3");
});

test("missing, deleted, malformed and cyclic ancestors retain the selected item with truthful boundaries; cancellation still aborts", async () => {
  const prefix = "https://hacker-news.firebaseio.com/v0/item/";
  const deleted = await hnPost({ [`${prefix}3.json`]: { id: 3, type: "comment", deleted: true, parent: 2 } });
  expect(deleted.post.parentContext?.parents.map(x => x.status)).toEqual(["deleted", "available"]);
  expect(composePlan([deleted.post], { parentDepth: "full" }).block.markdown).toContain("Parent comment deleted");
  for (const [value, stopped] of [[null, "unavailable"], [{ ...item(3, 4) }, "cycle"], [{ ...item(9, 2) }, "invalid_reference"]] as const) {
    const { post } = await hnPost({ [`${prefix}3.json`]: value });
    expect(post.parentContext?.stopped).toBe(stopped);
    expect(composePlan([post], { parentDepth: "full" }).block.markdown).toContain(stopped.replaceAll("_", " "));
  }
  const api = fixtures({ [`${prefix}4.json`]: item(4, 3) });
  await expect(new HackerNewsProvider(api.fetcher).resolve(parseSource(hn(4)), AbortSignal.abort())).rejects.toThrow();
});

test("HN traversal is bounded, keeps eight nearest comments, and never follows kids", async () => {
  const data: Record<string, unknown> = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`https://hacker-news.firebaseio.com/v0/item/${12-i}.json`, { ...item(12-i, 11-i), kids: [999] }]));
  data["https://hacker-news.firebaseio.com/v0/item/1.json"] = { id: 1, type: "story", title: "Root" };
  const api = fixtures(data), post = await new HackerNewsProvider(api.fetcher).resolve(parseSource(hn(12)));
  expect(post.parentContext?.parents).toHaveLength(8); expect(post.parentContext?.stopped).toBe("depth_limit");
  expect(post.parentContext?.submission?.id).toBe("1"); expect(api.calls).not.toContain("https://hacker-news.firebaseio.com/v0/item/999.json");
  expect(composePlan([post], { parentDepth: "full" }).block.markdown).toContain("depth limit");
});

const lobster = (id: string, parent: string | null) => ({ short_id: id, parent_comment: parent, created_at: "2024-01-01T00:00:00Z", is_deleted: false, is_moderated: false,
  commenting_user: id, comment_plain: `Original **${id}**`, url: `https://lobste.rs/s/story/a_story#c_${id}` });
test("Lobsters follows only parent_comment from the same story, retaining original Markdown and stopping at submission", async () => {
  const selected = lobster("three", "two");
  const api = fixtures({ "https://lobste.rs/c/three.json": selected, "https://lobste.rs/s/story.json": { short_id: "story", title: "Story", comments: [lobster("sibling", null), lobster("one", null), lobster("two", "one")] } });
  const post = await new LobstersProvider(api.fetcher).resolve(parseSource("https://lobste.rs/c/three"));
  expect(api.calls).toHaveLength(2); expect(post.parentContext?.parents.map(x => x.id)).toEqual(["two", "one"]);
  expect(post.parentContext?.stopped).toBe("submission");
  const plan = composePlan([post], { parentDepth: "full" });
  expect(plan.block.markdown).toBe("`one`\nOriginal **one**\n\n---\n\n`two`\nOriginal **two**\n\n---\n\n`three`\nOriginal **three**");
  expect(plan.block.canonicalSource).toBe("https://lobste.rs/c/three");
});

test("Lobsters stops at missing/cross-story pointers, labels deleted comments, and detects cycles", async () => {
  for (const [parent, stopped] of [[{ ...lobster("two", null), url: "https://lobste.rs/s/other/x#c_two" }, "invalid_reference"], [lobster("two", "three"), "cycle"], [undefined, "unavailable"]] as const) {
    const api = fixtures({ "https://lobste.rs/c/three.json": lobster("three", "two"), "https://lobste.rs/s/story.json": { short_id: "story", title: "Story", comments: parent ? [parent] : [] } });
    const post = await new LobstersProvider(api.fetcher).resolve(parseSource("https://lobste.rs/c/three"));
    expect(post.parentContext?.stopped).toBe(stopped);
  }
});

test("schema bounds and identity reject unrelated or repeated context and invalid policy", async () => {
  const { post } = await hnPost();
  expect(resolvedPostSchema.parse(post)).toEqual(post);
  for (const parentDepth of [-1, 9, "unbounded"]) expect(() => compositionPolicySchema.parse({ parentDepth })).toThrow();
  expect(() => compositionPolicySchema.parse({ parentStyle: "sequence" })).toThrow();
  expect(() => resolvedPostSchema.parse({ ...post, parentContext: { ...post.parentContext, parents: [post.parentContext!.parents[0], post.parentContext!.parents[0]] } })).toThrow();
  expect(() => resolvedPostSchema.parse({ ...post, provider: "x" })).toThrow();
});

test("old receivers and stripped options fail before source read or publication; matching plans retain their hash", async () => {
  const { post } = await hnPost(), policy = { parentDepth: 2, parentStyle: "flat" } as const;
  const plan = composePlan([post], policy), paths: string[] = [];
  expect(requiredPlanCapabilities(plan)).toContain("comment-parent-context-v1"); expect(requiredCompositionCapabilities({ policy })).toEqual(["video-representation-v2", "comment-parent-context-v1"]);
  requireRetainedCompositionPolicy({ policy }, plan);
  expect(() => requireRetainedCompositionPolicy({ policy }, composePlan([post]))).toThrow("retain parent");
  const { hash, ...content } = plan; expect(planHash(content)).toBe(hash);
  const client = new ArenaBlockClient("https://receiver.invalid", "fixture", (async (input) => { paths.push(String(input)); return Response.json({ version: "0.1.0", revision: null, sourceId: "old", platform: "test", schemaVersion: 1, packagePath: null, planCapabilities: [] }); }) as typeof fetch);
  await expect(client.plan([hn(4)], policy)).rejects.toThrow("No source read or save");
  await expect(client.publish(plan, ["unused"])).rejects.toThrow("No save was submitted");
  expect(paths.every(path => path.endsWith("/v1/version"))).toBe(true);
});

test("old comment snapshots cannot silently omit requested context, and flat multi-source captures avoid duplicate headers", async () => {
  const { post } = await hnPost();
  const legacy = { ...post }; delete legacy.parentContext;
  expect(() => composePlan([legacy], { parentDepth: 1 })).toThrow("no parent evidence");
  expect(composePlan([legacy], { parentDepth: 0 }).block.markdown).toBe(composePlan([post]).block.markdown);
  const other = { ...post, id: "5", canonicalUrl: hn(5), author: { handle: "other" }, text: "Other selected comment" };
  const combined = composePlan([post, other], { parentDepth: 1 });
  expect(combined.block.markdown).toContain("`other`\nOther selected comment");
  expect(combined.block.markdown).not.toContain("`@other`");
});

test("poll submissions remain story metadata, and moderated ancestors are unavailable rather than falsely deleted", async () => {
  const { post } = await hnPost({ "https://hacker-news.firebaseio.com/v0/item/1.json": { id: 1, type: "poll", title: "A poll", text: "Poll body" } });
  expect(post.parentContext?.stopped).toBe("submission"); expect(post.storyTitle).toBe("A poll");
  expect(composePlan([post], { parentDepth: "full" }).block.markdown).not.toContain("Poll body");
  const api = fixtures({ "https://lobste.rs/c/three.json": lobster("three", "two"), "https://lobste.rs/s/story.json": { short_id: "story", title: "Story", comments: [{ ...lobster("two", null), is_moderated: true }] } });
  const moderated = await new LobstersProvider(api.fetcher).resolve(parseSource("https://lobste.rs/c/three"));
  expect(moderated.parentContext?.parents[0]?.status).toBe("unavailable");
  expect(composePlan([moderated], { parentDepth: 1 }).block.markdown).toContain("Parent comment unavailable");
});
