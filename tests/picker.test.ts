import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { webPlan, publicationPayload } from "../src/capture.ts";
import { verifyPublication } from "../packages/core/verification.ts";
import { createService } from "../src/service.ts";
import { createPickerApp } from "../src/picker-server.ts";
import { userConfigSchema } from "../src/config.ts";
import type { ArenaBlockClient } from "../src/client.ts";
import type { ArenaClient } from "../src/arena.ts";
import { ChannelIndex } from "../src/channel-index.ts";
import { ExistingBlockPlacer } from "../src/existing-placement.ts";
import { ArenaBlockStore } from "../src/store.ts";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

test("ordinary web links keep URL identity, have no rendering, and verify as Link blocks", () => {
  const plan = webPlan({ url: "https://example.com/essay?part=2", title: "A useful essay", description: "Kept for later." });
  expect(plan.block).toMatchObject({ kind: "url", title: "A useful essay", canonicalSource: "https://example.com/essay?part=2", description: "Kept for later.", selectedMedia: [] });
  expect(publicationPayload(plan, "https://engine.invalid", undefined, [4, 4, 8])).toMatchObject({ value: "https://example.com/essay?part=2", channel_ids: [4, 8] });
  expect(() => verifyPublication(plan, { title: "A useful essay", type: "Link", state: "available", description: { markdown: "Kept for later." } }, { state: "available" })).not.toThrow();
  expect(() => webPlan({ url: "https://x.com/a/status/123" })).toThrow("social resolver");
  expect(() => webPlan({ url: "https://user:secret@example.com" })).toThrow();
});

test("authenticated channel pages are bounded, account-scoped and contain only picker fields", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arena-picker-channels-")); directories.push(directory);
  let reads = 0, labelReads = 0;
  const client = {
    me: async () => ({ id: 17 }),
    channel: async (ref: string) => {
      labelReads++;
      return { id: ref === "9002" ? 9002 : 2577980, title: ref === "9002" ? "Notes, links | Inbox" : "math, problems / proofs",
        slug: ref === "9002" ? "inbox-slug" : "math-slug", secret: "not-for-browser" };
    },
    ownedChannels: async (account: number, page: number) => {
      reads++; expect([account, page]).toEqual([17, 2]);
      return { data: [{ id: 31, title: "Motion index", slug: "motion-index", visibility: "private",
        owner: { name: "Someone", slug: "someone", email: "not-for-browser@example.test" },
        counts: { contents: 421 }, can: { add_to: true }, secret: "not-for-browser" }], meta: { next_page: 3, has_more_pages: true } };
    },
  } as unknown as ArenaClient;
  const service = createService({ host: "localhost", port: 8790, publicBaseUrl: "https://engine.invalid", stateDirectory: directory,
    mediaDirectory: directory, accessToken: "test-access", arenaToken: "unused", credential: { schemaVersion: 1, profile: "shared", arenaTokenEnv: "ARENA_WRITE_ACCESS_TOKEN", expectedAccountId: 17 } }, { client });
  const get = (path: string, authorized = true) => service.handler(new Request("https://engine.invalid" + path, { headers: authorized ? { authorization: "Bearer test-access" } : {} }));
  try {
    expect((await get("/v1/channels?page=2", false)).status).toBe(401);
    expect((await get("/v1/channels?page=101")).status).toBe(400);
    expect(await (await get("/v1/channels?page=2")).json()).toEqual({ accountId: 17, nextPage: 3, channels: [{ id: 31, title: "Motion index", slug: "motion-index", visibility: "private", owner: { name: "Someone", slug: "someone" }, count: 421, canAdd: true }] });
    expect(reads).toBe(1);
    expect((await get("/v1/channel-labels?ref=9002", false)).status).toBe(401);
    expect((await get("/v1/channel-labels?ref=bad%2Fref")).status).toBe(400);
    expect(await (await get("/v1/channel-labels?ref=9002&ref=math-slug")).json()).toEqual([
      { ref: "9002", id: 9002, title: "Notes, links | Inbox", slug: "inbox-slug" },
      { ref: "math-slug", id: 2577980, title: "math, problems / proofs", slug: "math-slug" },
    ]);
    expect(labelReads).toBe(2);
    expect(await (await get("/v1/channel-index")).json()).toMatchObject({ accountId: 17, channels: [{ id: 31, title: "Motion index" }], completeAt: null });
    expect(statSync(join(directory, "channel-index.json")).mode & 0o777).toBe(0o600);
    expect(reads).toBe(1);
  } finally { await service.close(); }
});

test("channel index retains a complete snapshot through interrupted refresh and isolates accounts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arena-picker-index-")); directories.push(directory);
  const index = new ChannelIndex(directory);
  const channel = (id: number) => ({ id, title: `Channel ${id}`, slug: `channel-${id}`, visibility: "private" as const, owner: { name: "Example", slug: "josh" } });
  index.recordPage(17, 1, [channel(1)], 2);
  expect(index.read(17)).toMatchObject({ accountId: 17, channels: [channel(1)], completeAt: null });
  index.recordPage(17, 2, [channel(2)], null);
  const full = index.read(17);
  expect(full.channels.map(value => value.id)).toEqual([1, 2]);
  expect(full.completeAt).not.toBeNull();
  index.recordPage(17, 1, [channel(3)], 2);
  expect(index.read(17).channels.map(value => value.id)).toEqual([1, 2]);
  expect(index.read(18).channels).toEqual([]);
  index.recordPage(17, 2, [], null);
  expect(index.read(17).channels.map(value => value.id)).toEqual([3]);
});

test("existing-block placement confirms membership and never reposts an uncertain connection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arena-existing-placement-")); directories.push(directory);
  const store = new ArenaBlockStore(join(directory, "arena-block.sqlite"), { private: true });
  const membership = new Set([10]);
  const posts: string[][] = [];
  const client = {
    channel: async (id: number) => ({ id, can: { add_to: true } }),
    completeBlockConnections: async () => new Set(membership),
    connect: async (_block: number, destinations: string[]) => {
      posts.push(destinations);
      if (destinations[0] === "20") membership.add(20);
      if (destinations[0] === "30") throw new Error("Response lost after POST");
      return [];
    },
  } as unknown as ArenaClient;
  try {
    const placer = new ExistingBlockPlacer(client, store);
    const input = { id: crypto.randomUUID(), accountId: 17, blockId: 42, destinations: [10, 20, 30, 40] };
    const first = await placer.place(input);
    expect(first.phase).toBe("unknown");
    expect(first.confirmed).toEqual([10, 20]);
    expect(first.attempted).toEqual([20, 30]);
    expect(posts).toEqual([["20"], ["30"]]);
    expect((await placer.place(input)).phase).toBe("unknown");
    expect(posts).toEqual([["20"], ["30"]]);
    membership.add(30); membership.add(40);
    expect((await placer.place(input)).phase).toBe("saved");
    expect(posts).toEqual([["20"], ["30"]]);
    expect(() => placer.status(input.id, 18)).toThrow("not found");
    expect(() => store.reserveExistingPlacement({ ...input, blockId: 43 })).toThrow("belongs to another");
  } finally { store.close(); }
});

test("existing-block placement reserves a target atomically across instances and confirms before later POSTs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arena-existing-placement-instances-")); directories.push(directory);
  const path = join(directory, "arena-block.sqlite"), store = new ArenaBlockStore(path, { private: true }), other = new ArenaBlockStore(path, { private: true });
  const membership = new Set<number>(), posts: string[][] = [];
  let arrive!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { arrive = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const client = {
    channel: async (id: number) => ({ id, can: { add_to: true } }),
    completeBlockConnections: async () => new Set(membership),
    connect: async (_block: number, destinations: string[]) => {
      posts.push(destinations);
      if (destinations[0] === "10") { arrive(); await held; }
      membership.add(Number(destinations[0])); return [];
    },
  } as unknown as ArenaClient;
  try {
    const first = new ExistingBlockPlacer(client, store), second = new ExistingBlockPlacer(client, other);
    const input = { id: crypto.randomUUID(), accountId: 17, blockId: 42, destinations: [10, 20] };
    const pending = first.place(input); await entered;
    expect((await second.place(input)).phase).toBe("unknown");
    expect(posts).toEqual([["10"]]);
    release(); expect((await pending).phase).toBe("saved");
    expect(posts).toEqual([["10"], ["20"]]);
    expect(store.existingPlacement(input.id)!.attempted).toEqual([10, 20]);
  } finally { release?.(); other.close(); store.close(); }
});

test("an absent formerly confirmed first placement stops an existing-block retry before later targets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arena-existing-placement-absent-")); directories.push(directory);
  const store = new ArenaBlockStore(join(directory, "arena-block.sqlite"), { private: true });
  let posts = 0;
  const client = { channel: async (id: number) => ({ id, can: { add_to: true } }), completeBlockConnections: async () => new Set<number>(), connect: async () => { posts++; return []; } } as unknown as ArenaClient;
  try {
    const input = { id: crypto.randomUUID(), accountId: 17, blockId: 42, destinations: [10, 20] };
    store.reserveExistingPlacement(input);
    store.updateExistingPlacement(input.id, value => ({ ...value, confirmed: [10], phase: "partial" }));
    const placer = new ExistingBlockPlacer(client, store);
    expect((await placer.place(input)).phase).toBe("unknown");
    expect((await placer.retry(input.id, 17)).phase).toBe("unknown");
    expect(posts).toBe(0);
  } finally { store.close(); }
});

test("existing-block placement can retry an unattempted destination after a read failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arena-existing-placement-retry-")); directories.push(directory);
  const store = new ArenaBlockStore(join(directory, "arena-block.sqlite"), { private: true });
  let readFails = true, posts = 0;
  const membership = new Set<number>();
  const client = {
    channel: async (id: number) => ({ id, can: { add_to: true } }),
    completeBlockConnections: async () => { if (readFails) throw new Error("Provider read timed out"); return new Set(membership); },
    connect: async () => { posts++; membership.add(10); return []; },
  } as unknown as ArenaClient;
  try {
    const placer = new ExistingBlockPlacer(client, store);
    const input = { id: crypto.randomUUID(), accountId: 17, blockId: 42, destinations: [10] };
    expect((await placer.place(input)).phase).toBe("prepared");
    expect(posts).toBe(0);
    readFails = false;
    expect((await placer.place(input)).phase).toBe("saved");
    expect(posts).toBe(1);
  } finally { store.close(); }
});

test("cancelled placement stays stopped until an explicit retry of the same ID", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arena-existing-placement-cancel-")); directories.push(directory);
  const store = new ArenaBlockStore(join(directory, "arena-block.sqlite"), { private: true });
  let arrive!: () => void, release!: () => void, posts = 0;
  const entered = new Promise<void>(resolve => { arrive = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  let wait = true;
  const membership = new Set<number>();
  const client = {
    channel: async (id: number) => { if (wait) { arrive(); await held; } return { id, can: { add_to: true } }; },
    completeBlockConnections: async () => new Set(membership),
    connect: async () => { posts++; membership.add(10); return []; },
  } as unknown as ArenaClient;
  try {
    const placer = new ExistingBlockPlacer(client, store);
    const input = { id: crypto.randomUUID(), accountId: 17, blockId: 42, destinations: [10] };
    const pending = placer.place(input);
    await entered;
    expect(placer.cancel(input.id, 17).cancelRequested).toBe(true);
    wait = false; release();
    expect((await pending).phase).toBe("cancelled");
    expect((await placer.place(input)).phase).toBe("cancelled");
    expect(posts).toBe(0);
    expect((await placer.retry(input.id, 17)).phase).toBe("saved");
    expect(posts).toBe(1);
  } finally { release?.(); store.close(); }
});

test("local picker reuses a save ID and disables implicit Inbox and remote provenance", async () => {
  const config = userConfigSchema.parse({ remoteInbox: { channel: "secret-inbox", mode: "always" },
    provenance: { local: false, remoteSnapshot: "summary" } });
  const plan = webPlan({ url: "https://example.com/read" });
  const id = crypto.randomUUID();
  let submissions = 0, retained: any;
  const daemon = {
    assertSaveProfile: async () => {},
    saveStatus: async () => { if (!retained) throw new Error("Save not found in this journal"); return retained; },
    save: async () => { throw new Error("Picker must not wait on the synchronous save route"); },
    beginCliSave: async (submission: any) => { submissions++; retained = { saveId: id, phase: "running", active: true, receipt: undefined }; expect(submission.snapshot.routing.destinations).toEqual(["12", "24"]); expect(submission.snapshot.routing.remoteInbox).toBeUndefined(); expect(submission.remoteMode).toBeUndefined(); return retained; },
    cancelSave: async () => ({ saveId: id, phase: "cancelled" }),
    retrySave: async () => { throw new Error("Picker must not wait on a synchronous retry"); },
    beginCliRetry: async () => { retained = { saveId: id, phase: "running", active: true }; return retained; },
  } as unknown as ArenaBlockClient;
  const app = createPickerApp(config, daemon, "test-secret");
  const request = (path: string, method = "GET", body?: unknown, origin = "http://127.0.0.1:8791") => app.handler(new Request("http://127.0.0.1:8791" + path, {
    method, headers: { host: "127.0.0.1:8791", "x-arena-block-picker": "test-secret", ...(method === "POST" ? { origin } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  const body = { plan, destinations: ["12", "24"], saveId: id };
  expect((await request("/api/save", "POST", body, "https://other.test")).status).toBe(403);
  expect((await app.handler(new Request("http://127.0.0.1:8791/api/channels", { headers: { host: "127.0.0.1:8791" } }))).status).toBe(404);
  expect((await request("/api/save", "POST", body)).status).toBe(200);
  expect((await request("/api/save", "POST", body)).status).toBe(200);
  expect(submissions).toBe(1);
  expect((await request("/api/save", "POST", { ...body, destinations: ["25"] })).status).toBe(409);
  expect((await request(`/api/saves/${id}/cancel`, "POST", {})).status).toBe(200);
  expect((await request(`/api/saves/${id}/retry`, "POST", {})).status).toBe(200);
  expect(retained).toMatchObject({ saveId: id, phase: "running", active: true });
});
