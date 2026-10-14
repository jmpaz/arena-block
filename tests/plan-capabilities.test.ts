import { expect, test } from "bun:test";
import { ArenaBlockClient } from "../src/client.ts";
import { composePlan, planHash } from "../src/compose.ts";
import { requiredPlanCapabilities } from "../src/plan-capabilities.ts";
import type { ResolvedPost } from "../src/types.ts";

const post: ResolvedPost = { provider: "delve", id: "a", canonicalUrl: "https://delve.town/profile/author.delve.town/post/a",
  author: { handle: "author.delve.town" }, text: "Original Delve text", media: [],
  atproto: { uri: "at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/town.delve.feed.post/a", cid: "cid-a",
    authorDid: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa", record: { $type: "town.delve.feed.post", text: "Original Delve text" } } };
const plan = composePlan([post], { threadExpansion: "off" });
function client(capabilities?: string[]) {
  const reads: Array<{ path: string; method: string }> = [];
  const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    reads.push({ path, method: init?.method ?? "GET" });
    if (path === "/v1/version") return Response.json({ version: "0.1.0", revision: "legacy", sourceId: "fixture", platform: "fixture",
      schemaVersion: 1, packagePath: null, ...(capabilities ? { planCapabilities: capabilities } : {}) });
    return Response.json({ error: "mock publication reached" }, { status: 400 });
  }) as typeof fetch;
  return { daemon: new ArenaBlockClient("https://daemon.example", "fixture-token", fetcher), reads };
}

test("legacy daemon receives only a version read for a Delve publication", async () => {
  const { daemon, reads } = client();
  await expect(daemon.publish(plan, ["channel"])).rejects.toThrow("No save was submitted");
  expect(reads).toEqual([{ path: "/v1/version", method: "GET" }]);
});

test("an older daemon stops a Forum Magnum publication before submission", async () => {
  const forumPlan = composePlan([{ provider: "forum_magnum", id: "commentA",
    canonicalUrl: "https://www.lesswrong.com/posts/postA/?commentId=commentA",
    author: { handle: "writer" }, text: "A public comment", storyTitle: "A post", media: [] }]);
  expect(requiredPlanCapabilities(forumPlan)).toEqual(["forum-magnum-posts-v1"]);
  const older = client(["atproto-post-records-v1", "delve-posts-v1", "bluesky-thread-coverage-v1"]);
  await expect(older.daemon.publish(forumPlan, ["channel"])).rejects.toThrow("No save was submitted");
  expect(older.reads).toEqual([{ path: "/v1/version", method: "GET" }]);
  const matching = client(["forum-magnum-posts-v1"]);
  await expect(matching.daemon.publish(forumPlan, ["channel"])).rejects.toThrow("mock publication reached");
  expect(matching.reads).toEqual([{ path: "/v1/version", method: "GET" }, { path: "/v1/publications", method: "POST" }]);
});

test("an advertised matching daemon may receive the exact immutable Delve plan", async () => {
  const { daemon, reads } = client(requiredPlanCapabilities(plan));
  await expect(daemon.publish(plan, ["channel"])).rejects.toThrow("mock publication reached");
  expect(reads).toEqual([{ path: "/v1/version", method: "GET" }, { path: "/v1/publications", method: "POST" }]);
});

test("new protocol fields require capability support even in a nested quote", () => {
  const legacy = composePlan([{ provider: "x", id: "1", canonicalUrl: "https://x.com/author/status/1",
    author: { handle: "author" }, text: "Original", media: [], quote: post }]);
  expect(requiredPlanCapabilities(legacy)).toEqual(["delve-posts-v1", "atproto-post-records-v1"]);
});

test("existing provider plans keep their publication contract", async () => {
  const legacy = composePlan([{ provider: "bluesky", id: "a", canonicalUrl: "https://bsky.app/profile/author.test/post/a",
    author: { handle: "author.test" }, text: "Original", media: [] }]);
  const { daemon, reads } = client();
  await expect(daemon.publish(legacy, ["channel"])).rejects.toThrow("mock publication reached");
  expect(reads).toEqual([{ path: "/v1/publications", method: "POST" }]);
});

test("native Bluesky coverage cannot be submitted to a daemon that would drop it", async () => {
  const covered = composePlan([{ provider: "bluesky", id: "a", canonicalUrl: "https://bsky.app/profile/author.test/post/a",
    author: { handle: "author.test" }, text: "Original", media: [],
    threadCoverage: { scope: "author-chain", replyGaps: [{ uri: "at://did:plc:author/app.bsky.feed.post/a", reported: 31, returned: 1, unavailable: 1 }] } }]);
  expect(requiredPlanCapabilities(covered)).toEqual(["bluesky-thread-coverage-v1"]);
  const older = client(["atproto-post-records-v1", "delve-posts-v1"]);
  await expect(older.daemon.publish(covered, ["channel"])).rejects.toThrow("No save was submitted");
  expect(older.reads).toEqual([{ path: "/v1/version", method: "GET" }]);
  const matching = client(requiredPlanCapabilities(covered));
  await expect(matching.daemon.publish(covered, ["channel"])).rejects.toThrow("mock publication reached");
  expect(matching.reads).toEqual([{ path: "/v1/version", method: "GET" }, { path: "/v1/publications", method: "POST" }]);
});


test.each(["save", "beginCliSave"])("%s blocks a Delve capsule before any submission", async method => {
  const { daemon, reads } = client();
  await expect(daemon[method]({ plan, snapshot: { saveId: "00000000-0000-4000-8000-000000000001" } } as any)).rejects.toThrow("No save was submitted");
  expect(reads).toEqual([{ path: "/v1/version", method: "GET" }]);
});

test("retained legacy Bluesky snapshots remain unchanged and require no new capability", async () => {
  const { blockPlanSchema: legacySchema } = await import("./fixtures/installed-daemon-types.ts");
  const raw = await Bun.file(new URL("./fixtures/legacy-client-bluesky-plan.json", import.meta.url)).json();
  const retained = legacySchema.parse(raw);
  expect(retained).toEqual(raw);
  const { hash, ...content } = retained;
  expect(planHash(content)).toBe(hash);
  expect(requiredPlanCapabilities(retained as unknown as Parameters<typeof requiredPlanCapabilities>[0])).toEqual([]);
});

test("fresh faceted Bluesky plans require a receiver that retains their protocol metadata", async () => {
  const { blockPlanSchema: legacySchema } = await import("./fixtures/installed-daemon-types.ts");
  const { BlueskyProvider } = await import("../src/providers/bluesky.ts");
  const { SocialResolver } = await import("../src/providers/index.ts");
  const fixture = await Bun.file(new URL("./fixtures/bluesky-op-thread.json", import.meta.url)).json();
  const fetcher = (async (input: URL | RequestInfo) => Response.json(String(input).includes("getAuthorFeed") ? fixture.authorFeed : fixture.thread)) as typeof fetch;
  const resolved = await new SocialResolver({ bluesky: new BlueskyProvider(undefined, fetcher) }).resolveComposition([fixture.source], [], { media: "all", threadExpansion: "on" });
  const retained = composePlan(resolved.posts, resolved.policy);
  const legacyPlan = legacySchema.parse(retained);
  expect(legacyPlan as unknown).not.toEqual(retained);
  const { hash, ...content } = legacyPlan;
  expect(planHash(content)).not.toBe(hash);
  expect(requiredPlanCapabilities(retained)).toEqual(["atproto-post-records-v1"]);
  const older = client();
  await expect(older.daemon.publish(retained, ["channel"])).rejects.toThrow("No save was submitted");
  expect(older.reads).toEqual([{ path: "/v1/version", method: "GET" }]);
  expect(retained.sources.map(source => source.id)).toEqual(["3mxjzbrinf22d", "3mxjzmgx6sc2d", "3mxk2eqkcks2d", "3mxk2iwcjec2a"]);
});
