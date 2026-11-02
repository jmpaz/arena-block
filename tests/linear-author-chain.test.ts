import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import receiving from "./fixtures/lesswrong-gwern-2013.json";
import { ForumMagnumProvider } from "../packages/core/providers/forum-magnum.ts";
import { AtprotoProvider } from "../packages/core/providers/atproto.ts";
import { BlueskyProvider } from "../packages/core/providers/bluesky.ts";
import { discoverSubstackThread } from "../packages/core/providers/substack-thread.ts";
import { SocialResolver } from "../packages/core/providers/index.ts";
import { composePlan } from "../packages/core/compose.ts";
import { parseSource } from "../packages/core/url.ts";

const forumURL = (id: string) => `https://www.lesswrong.com/posts/5GnwjxbL3SQ7gjRn6/open-thread-july-16-22-2013?commentId=${id}`;
const comment = (id: string, parent?: string, author = "writer") => ({
  _id: id, postId: receiving.post._id, pageUrl: forumURL(id), parentCommentId: parent,
  postedAt: "2026-10-18T10:00:00Z", deleted: false, deletedPublic: false,
  user: { username: author }, contents: { html: `<p>Writing ${id}</p>` },
});
function forum(comments: any[], change?: (parent: string, replies: any[]) => any[]) {
  comments = comments.map(comment => ({ directChildrenCount: comments.filter(child => child.parentCommentId === comment._id).length, ...comment, user: comment.user ? { _id: `User${comment.user.username}`, ...comment.user } : null }));
  const calls: string[] = [];
  const fetcher = (async (_: RequestInfo | URL, init?: RequestInit) => {
    init?.signal?.throwIfAborted();
    const { query, variables } = JSON.parse(String(init?.body));
    if (query.includes("ForumPost")) return Response.json({ data: { post: { result: receiving.post } } });
    if (query.includes("ForumComment")) return Response.json({ data: { comment: { result: comments.find(c => c._id === variables.id) ?? null } } });
    const parent = variables.terms.parentCommentId; calls.push(parent);
    const replies = comments.filter(c => c.parentCommentId === parent);
    return Response.json({ data: { comments: { results: change?.(parent, replies) ?? replies } } });
  }) as typeof fetch;
  return { resolver: new SocialResolver({ forum_magnum: new ForumMagnumProvider(fetcher) }), calls };
}

test("Forum chain keeps the seed's ancestor branch and stops at an other-author edge", async () => {
  const comments = [comment("RootABC"), comment("SeedABC", "RootABC"), comment("SiblingABC", "RootABC"),
    comment("NextABC", "SeedABC"), comment("ReaderABC", "NextABC", "reader"),
    comment("DisconnectedABC", "ReaderABC"), comment("UnrelatedABC")];
  const f = forum(comments);
  const resolved = await f.resolver.resolveComposition([forumURL("SeedABC")], [], { threadExpansion: "on" });
  expect(resolved.posts.map(p => p.id)).toEqual(["RootABC", "SeedABC", "NextABC"]);
  expect(f.calls).toEqual(["SeedABC", "NextABC"]);
  const plan = composePlan(resolved.posts, resolved.policy);
  expect(plan.block.canonicalSource).toBe(forumURL("SeedABC"));
  expect(plan.sources[1]!.selection?.origin).toBe("explicit");
  expect(plan.block.markdown).not.toMatch(/Reply to @|Parent comment|ReaderABC|SiblingABC|DisconnectedABC|UnrelatedABC/);
  const reply = await forum(comments).resolver.resolveComposition([forumURL("DisconnectedABC")], [], { threadExpansion: "on" });
  expect(reply.posts.map(p => p.id)).toEqual(["DisconnectedABC"]);
});

test("Forum forward forks, incomplete pages, cycles and changed ancestry fail", async () => {
  const root = comment("RootABC"), a = comment("ChildABC", root._id), b = comment("OtherABC", root._id);
  await expect(forum([root, a, b]).resolver.resolveComposition([root.pageUrl], [], { threadExpansion: "on" })).rejects.toThrow("author replies branch");
  await expect(forum([{ ...root, directChildrenCount: 2 }, a]).resolver.resolveComposition([root.pageUrl], [], { threadExpansion: "on" })).rejects.toThrow("incomplete");
  await expect(forum([{ ...root, directChildrenCount: null }, a]).resolver.resolveComposition([root.pageUrl], [], { threadExpansion: "on" })).rejects.toThrow("incomplete");
  const full = Array.from({ length: 101 }, (_, i) => comment(`Reader${i}ABC`, root._id, "reader"));
  await expect(forum([root, ...full]).resolver.resolveComposition([root.pageUrl], [], { threadExpansion: "on" })).rejects.toThrow("incomplete");
  await expect(forum([{ ...root, directChildrenCount: 2 }, a], () => [a, a]).resolver.resolveComposition([root.pageUrl], [], { threadExpansion: "on" })).rejects.toThrow("inconsistent");
  await expect(forum([root, a], () => [{ ...a, parentCommentId: "WrongABC" }]).resolver.resolveComposition([root.pageUrl], [], { threadExpansion: "on" })).rejects.toThrow("inconsistent");
  await expect(forum([root, a], () => [{ ...a, user: { username: "reader" }, pageUrl: a.pageUrl.replace("www.lesswrong.com", "www.alignmentforum.org") }]).resolver.resolveComposition([root.pageUrl], [], { threadExpansion: "on" })).rejects.toThrow("different comment link");
  await expect(forum([{ ...root, parentCommentId: a._id }, a]).resolver.resolveComposition([root.pageUrl], [], { threadExpansion: "on" })).rejects.toThrow("cycle");
  await expect(forum([root, { ...a, deleted: true }]).resolver.resolveComposition([root.pageUrl], [], { threadExpansion: "on" })).rejects.toThrow("unavailable");
  const bounded = Array.from({ length: 33 }, (_, i) => comment(`Chain${i}ABC`, i ? `Chain${i-1}ABC` : undefined));
  await expect(forum(bounded).resolver.resolveComposition([bounded[0]!.pageUrl], [], { threadExpansion: "on" })).rejects.toThrow("exceeds 32");
  const controller = new AbortController(); controller.abort();
  await expect(forum([root]).resolver.resolveComposition([root.pageUrl], [], { threadExpansion: "on" }, controller.signal)).rejects.toThrow();
});

test("Forum author matching uses stable IDs across changed or conflicting usernames", async () => {
  const root = { ...comment("RootABC"), user: { _id: "AuthorABC", username: "writer" } };
  const renamed = { ...comment("ChildABC", root._id), user: { _id: "AuthorABC", username: "renamed" } };
  const other = { ...comment("OtherABC", renamed._id), user: { _id: "OtherAuthorABC", username: "renamed" } };
  const result = await forum([root, renamed, other]).resolver.resolveComposition([root.pageUrl], [], { threadExpansion: "on" });
  expect(result.posts.map(post => post.id)).toEqual([root._id, renamed._id]);
});

test("Forum expansion refuses missing seed, ancestor and reply author IDs", async () => {
  const root = comment("RootABC"), child = comment("ChildABC", root._id);
  const missing = (item: ReturnType<typeof comment>) => ({ ...item, user: { _id: undefined, username: item.user.username } });
  await expect(forum([missing(root), child]).resolver.resolveComposition([root.pageUrl], [], { threadExpansion: "on" })).rejects.toThrow("author identity is incomplete");
  await expect(forum([missing(root), child]).resolver.resolveComposition([child.pageUrl], [], { threadExpansion: "on" })).rejects.toThrow("author identity is incomplete");
  await expect(forum([root, missing(child)]).resolver.resolveComposition([root.pageUrl], [], { threadExpansion: "on" })).rejects.toThrow("incomplete reply author identities");
  const selected = await forum([missing(root), child]).resolver.resolveComposition([root.pageUrl], [], { threadExpansion: "off" });
  expect(selected.posts.map(post => post.id)).toEqual([root._id]);
});

test("the reported public Gwern root refuses parallel replies; selecting a descendant retains its branch", async () => {
  await expect(forum(receiving.comments).resolver.resolveComposition([receiving.sourceUrl], [], { threadExpansion: "on" })).rejects.toThrow("author replies branch");
  const seed = "TXDthBGbMtpEpvNqe";
  const resolved = await forum(receiving.comments).resolver.resolveComposition([forumURL(seed)], [], { threadExpansion: "on" });
  expect(resolved.posts.map(p => p.id)).toEqual(["gFRKkcyXDTiKkug56", seed, "LsyGSZRxJM2CAiQ9M"]);
  const plan = composePlan(resolved.posts, resolved.policy);
  expect(plan.block.canonicalSource).toBe(forumURL(seed));
  expect(plan.sources.every(p => p.author.handle === "gwern")).toBe(true);
  expect(plan.block.markdown).toContain("Bryan Caplan");
  expect(plan.block.markdown).not.toMatch(/Reply to @|Parent comment|@Lumifer/);
});

const directory = await mkdtemp(join(tmpdir(), "arena-forum-render-"));
afterAll(() => rm(directory, { recursive: true, force: true }));
test("CLI render writes the actual Gwern body and clean source-date links", async () => {
  const preload = join(directory, "public-forum.ts");
  await Bun.write(preload, `const data = ${JSON.stringify(receiving)};
    globalThis.fetch = async (url, init) => {
      if (String(url) !== 'https://www.lesswrong.com/graphql') throw Error('Unexpected request '+url);
      const {query, variables} = JSON.parse(String(init.body));
      if(query.includes('ForumPost')) return Response.json({data:{post:{result:data.post}}});
      if(query.includes('ForumComment')) return Response.json({data:{comment:{result:data.comments.find(c=>c._id===variables.id)}}});
      return Response.json({data:{comments:{results:data.comments.filter(c=>c.parentCommentId===variables.terms.parentCommentId)}}});
    };`);
  for (const [seed, flags] of [["gFRKkcyXDTiKkug56", []], ["TXDthBGbMtpEpvNqe", ["-t"]]] as const) {
    const output = join(directory, `${seed}.md`);
    const run = Bun.spawnSync([process.execPath, "--preload", preload, "src/cli.ts", "render", forumURL(seed), ...flags, "-o", output], { stdout: "pipe", stderr: "pipe" });
    expect(run.exitCode, run.stderr.toString()).toBe(0);
    const rendered = await Bun.file(output).text();
    expect(rendered).toContain("While reading a psychology paper");
    expect(rendered).not.toMatch(/Reply to @|Parent comment|@Lumifer/);
    if (flags.length) {
      expect(rendered).toContain(`[2014-11-29](<${forumURL(seed)}>)`);
      expect(rendered).toContain("Bryan Caplan");
    } else expect(rendered).not.toContain("Bryan Caplan");
  }
});

function skyPost(id: string, parent?: string, did = "did:plc:writer") {
  const uri = (id: string) => `at://did:plc:writer/app.bsky.feed.post/${id}`;
  return { uri: uri(id), cid: `cid-${id}`, author: { did, handle: "writer.test" }, replyCount: 0,
    record: { $type: "app.bsky.feed.post", text: id, createdAt: "2026-10-18T00:00:00Z", ...(parent ? { reply: { parent: { uri: uri(parent), cid: `cid-${parent}` }, root: { uri: uri("root"), cid: "cid-root" } } } : {}) } };
}
test.each([BlueskyProvider, AtprotoProvider])("%p preserves a proved descendant path across an ancestor sibling fork", async Provider => {
  const root = skyPost("root"), seed = skyPost("seed", "root"), next = skyPost("next", "seed");
  const tree = { post: { ...root, replyCount: 2 }, replies: [
    { post: { ...seed, replyCount: 1 }, replies: [{ post: next }] }, { post: skyPost("sibling", "root") }] };
  const initial: any = { thread: { ...tree.replies[0], parent: { post: root } } };
  const calls: string[] = [];
  const run = async (value: any = initial, expanded: any = tree) => {
    const provider = new Provider("https://public.api.bsky.app", (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      calls.push(url.pathname);
      if (url.pathname.endsWith("getAuthorFeed")) return Response.json({ feed: [root, seed, next].map((post, index) => ({ post, opThreadPostIndex: index + 1, opThreadPostCount: 3 })) });
      if (!url.pathname.endsWith("getPostThread")) throw Error("Unexpected evidence request");
      return Response.json(url.searchParams.get("uri")!.endsWith("/seed") ? value : { thread: expanded });
    }) as typeof fetch);
    const parsed = parseSource("https://bsky.app/profile/writer.test/post/seed");
    if (parsed.provider !== "bluesky") throw Error("Expected Bluesky source");
    return provider.discoverLinear(parsed);
  };
  expect((await run()).posts.map(p => p.id)).toEqual(["root", "seed", "next"]);
  const forwardFork = structuredClone(tree); forwardFork.replies[0]!.replies!.push({ post: skyPost("fork", "seed") }); forwardFork.replies[0]!.post.replyCount = 2;
  calls.length = 0;
  await expect(run(initial, forwardFork)).rejects.toThrow("forks into multiple author replies");
  expect(calls.every(path => path.endsWith("getPostThread"))).toBe(true);
  const incompleteAncestor = structuredClone(forwardFork); incompleteAncestor.post.replyCount = 3;
  const initialFork = { thread: { ...forwardFork.replies[0], parent: { post: root } } };
  await expect(run(initialFork, incompleteAncestor)).rejects.toThrow("forks into multiple author replies");
  await expect(run(initial, incompleteAncestor)).rejects.toThrow("forks into multiple author replies");
  const firstViewFork = structuredClone(initial);
  firstViewFork.thread.replies[0].post.replyCount = 2;
  firstViewFork.thread.replies[0].replies = [{ post: skyPost("branchA", "next") }, { post: skyPost("branchB", "next") }];
  const changedView: any = structuredClone(tree);
  changedView.replies[0].replies[0].post.replyCount = 1;
  changedView.replies[0].replies[0].replies = [{ post: skyPost("branchA", "next") }];
  await expect(run(firstViewFork, changedView)).rejects.toThrow("forks into multiple author replies");
  const broken = structuredClone(initial); broken.thread.post.record.reply!.parent.cid = "wrong";
  await expect(run(broken)).rejects.toThrow("parent reference changed");
  const changed = structuredClone(tree); changed.replies[0]!.post.cid = "changed";
  await expect(run(initial, changed)).rejects.toThrow("ancestry changed");
  const other = structuredClone(initial); other.thread.parent.post.author.did = "did:plc:other";
  expect((await run(other)).posts.map(p => p.id)).toEqual(["seed", "next"]);
});

test.each([BlueskyProvider, AtprotoProvider])("%p refuses two visible direct author continuations despite missing replies", async Provider => {
  const root = { ...skyPost("root"), replyCount: 1 };
  const seed = { ...skyPost("seed", "root"), replyCount: 3 };
  const next = skyPost("next", "seed"), fork = skyPost("fork", "seed");
  const branch = { post: seed, replies: [{ post: next }, { post: fork }] };
  const calls: string[] = [];
  const provider = new Provider("https://public.api.bsky.app", (async (input: RequestInfo | URL) => {
    const url = new URL(String(input)); calls.push(url.pathname);
    if (url.pathname.endsWith("getAuthorFeed")) return Response.json({ feed: [root, seed, next].map((post, index) => ({ post, opThreadPostIndex: index + 1, opThreadPostCount: 3 })) });
    return Response.json({ thread: url.searchParams.get("uri")!.endsWith("/seed") ? { ...branch, parent: { post: root } } : { post: root, replies: [branch] } });
  }) as typeof fetch);
  const source = parseSource("https://bsky.app/profile/writer.test/post/seed");
  if (source.provider !== "bluesky") throw Error("Expected Bluesky source");
  await expect(provider.discoverLinear(source)).rejects.toThrow("forks into multiple author replies");
  expect(calls).toEqual(["/xrpc/app.bsky.feed.getPostThread"]);
});

const subComment = (id: number, ancestor_path = "", user_id = 1) => ({ id, ancestor_path, user_id, handle: user_id === 1 ? "writer" : "reader", type: "feed", post_id: null });
test("Substack retains the selected descendant branch and refuses a forward fork", async () => {
  const root = subComment(100), seed = subComment(101, "100"), next = subComment(102, "100.101");
  const run = (fork = false, intervening = false, broken = false) => {
    const ancestor = intervening ? { ...root, user_id: 2, handle: "reader" } : root;
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/comment/101")) return Response.json({ item: { comment: seed, parentComments: [{ ...ancestor, ...(broken ? { ancestor_path: "99" } : {}) }] } });
      const id = url.split("/").at(-2);
      const current = id === "100" ? ancestor : id === "101" ? seed : next;
      const children = id === "100" ? [seed, subComment(103, "100")] : id === "101" ? [next, ...(fork ? [subComment(104, "100.101")] : []), subComment(200, "100.101", 2)] : [];
      return Response.json({ rootComment: current, commentBranches: children.map(comment => ({ comment, descendantComments: [] })), moreBranches: false, nextCursor: null });
    }) as typeof fetch;
    return discoverSubstackThread("101", async url => ({ provider: "substack", id: url.split("c-")[1]!, canonicalUrl: url, author: { handle: "writer" }, text: url, media: [] }), fetcher);
  };
  expect((await run()).posts.map(p => p.id)).toEqual(["100", "101", "102"]);
  await expect(run(true)).rejects.toThrow("author replies branch");
  expect((await run(false, true)).posts.map(p => p.id)).toEqual(["101", "102"]);
  await expect(run(false, false, true)).rejects.toThrow("prefixes disagree");
});
