import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composePlan } from "../src/compose.ts";
import type { BlockPlan } from "../src/types.ts";

const directory = await mkdtemp(join(tmpdir(), "arena-cli-thread-"));
const preload = join(directory, "source-fixture.ts");
const bskyFixture = join(import.meta.dir, "fixtures/bluesky-op-thread.json");
const xSource = "https://x.com/threadwriter/status/102";
const forumSource = "https://www.lesswrong.com/posts/5GnwjxbL3SQ7gjRn6/open-thread-july-16-22-2013#gFRKkcyXDTiKkug56";
const forumPost = { _id: "5GnwjxbL3SQ7gjRn6", title: "Open thread, July 16-22, 2013",
  pageUrl: forumSource.split("#")[0], postedAt: "2013-07-16T00:00:00.000Z", status: 2,
  user: { username: "container-author" }, contents: { html: "<p>Unselected container body.</p>" } };
const forumComments = [
  { _id: "gFRKkcyXDTiKkug56", username: "gwern", text: "Selected comment fixture." },
  { _id: "ReplyCommentABC12", username: "reader", text: "Direct reply fixture.", parentCommentId: "gFRKkcyXDTiKkug56" },
  { _id: "SiblingComment12", username: "other", text: "Unrelated open-thread comment." },
].map(({ username, text, ...comment }) => ({ ...comment, postId: forumPost._id,
  pageUrl: `${forumPost.pageUrl}?commentId=${comment._id}`, postedAt: "2013-07-20T00:00:00.000Z",
  deleted: false, deletedPublic: false, user: { username }, contents: { html: `<p>${text}</p>` } }));
const xPosts = [101, 102, 103].map((id, index) => ({ id: String(id), author: { id: "writer-1", screen_name: "threadwriter" },
  text: `Thread part ${index + 1}.`, created_at: "Fri Oct 16 09:00:00 +0000 2026",
  ...(index ? { replying_to: { status: String(id - 1), screen_name: "threadwriter" } } : {}) }));
await Bun.write(preload, `
const fixture = await Bun.file(${JSON.stringify(bskyFixture)}).json();
const posts = ${JSON.stringify(xPosts)};
const forumPost = ${JSON.stringify(forumPost)};
const forumComments = ${JSON.stringify(forumComments)};
const calls = [];
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  const forumRequest = url.href === "https://www.lesswrong.com/graphql" ? JSON.parse(String(init?.body)) : undefined;
  calls.push({ url: url.href, method: init?.method ?? "GET", ...(forumRequest ? { variables: forumRequest.variables } : {}) });
  await Bun.write(process.env.ARENA_THREAD_TEST_LEDGER, JSON.stringify(calls));
  if (forumRequest) {
    const { query, variables } = forumRequest;
    if (query.includes("ForumPost") && variables.id === forumPost._id) return Response.json({ data: { post: { result: forumPost } } });
    if (query.includes("ForumComment")) return Response.json({ data: { comment: { result: forumComments.find(comment => comment._id === variables.id) ?? null } } });
    if (query.includes("ForumReplies") && variables.terms.view === "commentReplies" && variables.terms.parentCommentId)
      return Response.json({ data: { comments: { results: forumComments.filter(comment => comment.parentCommentId === variables.terms.parentCommentId) } } });
  }
  if (url.origin === "https://api.fxtwitter.com" && url.pathname === "/2/thread/102") return Response.json({ code: 200, status: posts[1], thread: posts });
  if (url.origin === "https://api.fxtwitter.com" && url.pathname === "/threadwriter/status/102") return Response.json({ code: 200, tweet: posts[1] });
  if (url.origin === "https://public.api.bsky.app" && url.pathname.endsWith("getPostThread")) return Response.json(fixture.thread);
  if (url.origin === "https://public.api.bsky.app" && url.pathname.endsWith("getAuthorFeed")) return Response.json(fixture.authorFeed);
  throw new Error("Unexpected test network request: " + url.href);
};`);
afterAll(() => rm(directory, { recursive: true, force: true }));

async function cli(args: string[]) {
  const ledger = join(directory, `${crypto.randomUUID()}.json`);
  await Bun.write(ledger, "[]");
  const child = Bun.spawn([process.execPath, "--preload", preload, "src/cli.ts", ...args], {
    cwd: join(import.meta.dir, ".."), env: { ...process.env, HOME: directory, ARENA_BLOCK_CONFIG: "",
      ARENA_BLOCK_ACCESS_TOKEN: "", ARENA_BLOCK_ENDPOINT: "https://no-daemon.test", ARENA_THREAD_TEST_LEDGER: ledger },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code, calls: await Bun.file(ledger).json() as { url: string; method: string; variables?: { terms?: { view: string; parentCommentId: string; limit: number } } }[] };
}

describe("CLI thread expansion", () => {
  test("help advertises a presence-only shorthand and an off default", async () => {
    for (const prefix of [[], ["plan"], ["render"], ["publish"], ["resolve"]]) {
      const result = await cli([...prefix, "--help"]);
      expect(result.code).toBe(0); expect(result.stderr).toBe(""); expect(result.calls).toEqual([]);
      const option = result.stdout.split("\n").find(line => line.includes("--thread-expansion"));
      expect(option).toContain("-t, --thread-expansion");
      expect(option).not.toContain("<mode>"); expect(option).not.toContain("[mode]");
      expect(result.stdout).toContain("default: off");
      expect(result.stdout).not.toContain("default: false");
      expect(result.stdout).not.toContain("--thread-expansion <mode>");
    }
  });

  test("omission disables automatic AT Protocol expansion, including the root command", async () => {
    const fixture = await Bun.file(bskyFixture).json();
    for (const prefix of [[], ["plan"]]) {
      const result = await cli([...prefix, fixture.source, "--media", "none", "--json"]);
      expect(result.code).toBe(0); expect(result.stderr).toBe("");
      const plan = JSON.parse(result.stdout) as BlockPlan;
      expect(plan.policy.threadExpansion).toBe("off"); expect(plan.sources).toHaveLength(1);
      expect(plan.sources[0]?.id).toBe("3mxjzbrinf22d");
      expect(result.calls.map(call => new URL(call.url).pathname)).toEqual(["/xrpc/app.bsky.feed.getPostThread"]);
    }
  });

  test("both presence-only flags expand the actual provider fixture and retain ordered provenance", async () => {
    for (const args of [["-t", xSource], [xSource, "--thread-expansion"], ["--thread-expansion", xSource]]) {
      const result = await cli(["plan", ...args, "--json"]);
      expect(result.code).toBe(0); expect(result.stderr).toBe("");
      const plan = JSON.parse(result.stdout) as BlockPlan;
      expect(plan.policy.threadExpansion).toBe("on"); expect(plan.sources.map(post => post.id)).toEqual(["101", "102", "103"]);
      expect(plan.sources.map(post => post.selection?.origin)).toEqual(["expanded", "explicit", "expanded"]);
      expect(plan.block.markdown).toBe("Thread part 1.\n\n---\n\nThread part 2.\n\n---\n\nThread part 3.");
      expect(result.calls).toEqual([{ url: "https://api.fxtwitter.com/2/thread/102", method: "GET" }]);
    }
    const global = await cli(["-t", "plan", xSource, "--json"]);
    expect(global.code).toBe(0); expect(JSON.parse(global.stdout).sources).toHaveLength(3);
    const bsky = await cli(["plan", (await Bun.file(bskyFixture).json()).source, "-t", "--media", "none", "--json"]);
    expect(bsky.code).toBe(0); expect(JSON.parse(bsky.stdout).sources.map((post: { id: string }) => post.id))
      .toEqual(["3mxjzbrinf22d", "3mxjzmgx6sc2d", "3mxk2eqkcks2d", "3mxk2iwcjec2a"]);
  });

  test("legacy on/off scripts remain explicit, warn on stderr and never restore auto", async () => {
    for (const [mode, count] of [["on", 3], ["off", 1]] as const) {
      for (const flag of [["--thread-expansion", mode], [`--thread-expansion=${mode}`]]) {
        const result = await cli(["plan", xSource, ...flag, "--json"]);
        expect(result.code).toBe(0); expect(result.stderr).toContain("deprecated");
        expect(result.stdout).not.toContain("deprecated");
        const plan = JSON.parse(result.stdout) as BlockPlan;
        expect(plan.policy.threadExpansion).toBe(mode); expect(plan.sources).toHaveLength(count);
        expect(result.calls).toHaveLength(1);
      }
    }
    const lastOff = await cli(["plan", xSource, "-t", "--thread-expansion", "off", "--json"]);
    expect(lastOff.code).toBe(0); expect(JSON.parse(lastOff.stdout).policy.threadExpansion).toBe("off");
    const lastOn = await cli(["plan", xSource, "--thread-expansion", "off", "-t", "--json"]);
    expect(lastOn.code).toBe(0); expect(JSON.parse(lastOn.stdout).policy.threadExpansion).toBe("on");
    const localOff = await cli(["-t", "plan", xSource, "--thread-expansion", "off", "--json"]);
    expect(localOff.code).toBe(0); expect(JSON.parse(localOff.stdout).policy.threadExpansion).toBe("off");
    const localOn = await cli(["--thread-expansion", "off", "plan", xSource, "-t", "--json"]);
    expect(localOn.code).toBe(0); expect(JSON.parse(localOn.stdout).policy.threadExpansion).toBe("on");
  });

  test("auto and invalid mode-like values fail before reading any source", async () => {
    for (const flag of [["--thread-expansion", "auto"], ["--thread-expansion=auto"], ["-t", "auto"],
      ["--thread-expansion", "sometimes"], ["--thread-expansion=sometimes"], ["--thread-expansion="], ["-t", "on"]]) {
      const result = await cli(["plan", xSource, ...flag, "--json"]);
      expect(result.code).toBe(1); expect(result.stdout).toBe(""); expect(result.calls).toEqual([]);
      expect(result.stderr).toMatch(/no auto mode|takes no value/);
    }
    const literal = await cli(["plan", "-t", "--", "auto", "--json"]);
    expect(literal.code).toBe(1); expect(literal.calls).toEqual([]);
    expect(literal.stderr).not.toContain("deprecated");
  });

  test("new render and dry-run compositions use off/on while resolve remains a raw record read", async () => {
    const config = join(directory, "new-composition-config.json");
    await Bun.write(config, JSON.stringify({ provenance: { local: false, remoteSnapshot: "none" } }));
    for (const [flags, mode, count] of [[[], "off", 1], [["-t"], "on", 3]] as const) {
      const output = join(directory, `new-preview-${mode}.md`);
      const rendered = await cli(["render", xSource, ...flags, "-o", output]);
      expect(rendered.code).toBe(0); expect(rendered.stderr).toBe("");
      expect(await readFile(output, "utf8")).toBe(count === 1 ? "Thread part 2."
        : "Thread part 1.\n\n---\n\nThread part 2.\n\n---\n\nThread part 3.");
      const dryRun = await cli(["publish", xSource, ...flags, "--dry-run", "--config", config, "--to", "fixture-inbox"]);
      expect(dryRun.code).toBe(0); expect(dryRun.stderr).toBe("");
      const snapshot = JSON.parse(dryRun.stdout).snapshot;
      expect(snapshot.plan.policy.threadExpansion).toBe(mode); expect(snapshot.plan.sources).toHaveLength(count);
      for (const result of [rendered, dryRun]) expect(result.calls).toEqual([{ method: "GET",
        url: mode === "on" ? "https://api.fxtwitter.com/2/thread/102" : "https://api.fxtwitter.com/threadwriter/status/102" }]);
      const resolved = await cli(["resolve", xSource, ...flags, "--json"]);
      expect(resolved.code).toBe(0); expect(JSON.parse(resolved.stdout).map((post: { id: string }) => post.id)).toEqual(["102"]);
      expect(resolved.calls).toEqual([{ method: "GET", url: "https://api.fxtwitter.com/threadwriter/status/102" }]);
    }
  });

  test("LessWrong fragment publish dry-run keeps the selected comment while -t adds its replies", async () => {
    const destination = "https://www.are.na/josh-pazmino/on-writing-xbolnqpetki";
    const config = join(directory, "forum-config.json");
    await Bun.write(config, JSON.stringify({ provenance: { local: false, remoteSnapshot: "none" } }));
    for (const flags of [[], ["-t"]]) {
      const result = await cli(["publish", ...flags, "--media", "auto", "--to", destination, forumSource,
        "--dry-run", "--config", config]);
      expect(result.code).toBe(0); expect(result.stderr).toBe("");
      const snapshot = JSON.parse(result.stdout).snapshot;
      const plan = snapshot.plan as BlockPlan;
      expect(snapshot.invocation.inputs.sourceRefs).toEqual([forumSource]);
      expect(snapshot.routing.requestedDestinations).toEqual(["on-writing-xbolnqpetki"]);
      expect(plan.policy).toMatchObject({ media: "auto", threadExpansion: flags.length ? "on" : "off" });
      expect(plan.sources.map(post => post.id)).toEqual(flags.length
        ? ["gFRKkcyXDTiKkug56", "ReplyCommentABC12"] : ["gFRKkcyXDTiKkug56"]);
      expect(plan.sources[0]?.selection).toMatchObject({ origin: "explicit", declaredIndex: 1 });
      expect(plan.block.canonicalSource).toBe(`${forumPost.pageUrl}?commentId=gFRKkcyXDTiKkug56`);
      expect(plan.block.title).toBe("Comment by gwern on “Open thread, July 16-22, 2013”");
      expect(plan.block.markdown).toContain("Selected comment fixture.");
      expect(plan.block.markdown).not.toContain("Unselected container body.");
      expect(plan.block.markdown).not.toContain("Unrelated open-thread comment.");
      expect(plan.block.selectedMedia).toEqual([]);
      expect(result.calls.every(call => call.url === "https://www.lesswrong.com/graphql" && call.method === "POST")).toBe(true);
      expect(result.calls.flatMap(call => call.variables?.terms ? [call.variables.terms] : [])).toEqual(flags.length
        ? [{ view: "commentReplies", parentCommentId: "gFRKkcyXDTiKkug56", limit: 9 }] : []);
    }
  });

  test("render and publish --plan preserve the frozen policy and plan instead of applying CLI defaults", async () => {
    const frozen = composePlan([{ provider: "x", id: "102", canonicalUrl: xSource,
      author: { handle: "threadwriter" }, text: "Frozen source writing.", media: [] }], { threadExpansion: "auto" });
    const path = join(directory, "frozen-plan.json"), output = join(directory, "frozen-preview.md"), config = join(directory, "config.json");
    await Bun.write(path, JSON.stringify(frozen)); await Bun.write(config, JSON.stringify({ provenance: { local: false, remoteSnapshot: "none" } }));
    for (const flags of [[], ["-t"]]) {
      const rendered = await cli(["render", "--plan", path, "-o", output, ...flags]);
      expect(rendered.code).toBe(0); expect(rendered.calls).toEqual([]);
      expect(await readFile(output, "utf8")).toBe(frozen.block.markdown);
      const published = await cli(["publish", "--plan", path, "--dry-run", "--config", config, "--to", "fixture-inbox", ...flags]);
      expect(published.code).toBe(0); expect(published.calls).toEqual([]);
      expect(JSON.parse(published.stdout).snapshot.plan).toEqual(frozen);
    }
    expect(await Bun.file(path).json()).toEqual(frozen);
  });
});
