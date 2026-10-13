import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArenaClient, ArenaPublisher } from "../src/arena.ts";
import { ArenaBlockStore } from "../src/store.ts";
import { ExistingBlockPlacer } from "../src/existing-placement.ts";
import { composePlan } from "../src/compose.ts";
import { prepareSaveIntent } from "../src/save-intent.ts";
import { userConfigSchema } from "../src/config.ts";
import { MockApi } from "./fixtures/remote-api.ts";

const paths: string[] = [];
afterEach(async () => { await Promise.all(paths.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function path() { const directory = await mkdtemp(join(tmpdir(), "arena-physical-reservation-")); paths.push(directory); return join(directory, "state.sqlite"); }
function gate() {
  let arrive!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { arrive = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  return { arrive, release, entered, held };
}
test("distinct placement IDs reserve one physical target across instances and reconcile the other intent", async () => {
  const file = await path(), firstStore = new ArenaBlockStore(file), secondStore = new ArenaBlockStore(file);
  const members = new Set<number>(), posts: number[] = [], waiting: Array<() => void> = [];
  const client = {
    channel: async (id: number) => ({ id, can: { add_to: true } }),
    completeBlockConnections: async () => {
      if (waiting.length < 2) { await new Promise<void>(resolve => { waiting.push(resolve); if (waiting.length === 2) waiting.forEach(release => release()); }); return new Set<number>(); }
      return new Set(members);
    },
    connect: async (_block: number, destinations: string[]) => { const id = Number(destinations[0]); posts.push(id); members.add(id); return []; },
  } as unknown as ArenaClient;
  try {
    const first = new ExistingBlockPlacer(client, firstStore), second = new ExistingBlockPlacer(client, secondStore);
    const inputs = [crypto.randomUUID(), crypto.randomUUID()].map(id => ({ id, accountId: 47, blockId: 777, destinations: [901, 902] }));
    const results = await Promise.all([first.place(inputs[0]!), second.place(inputs[1]!)]);
    expect(posts).toEqual([901, 902]);
    expect(results.map(result => result.phase).sort()).toEqual(["saved", "unknown"]);
    const index = results.findIndex(result => result.phase === "unknown"), placer = index === 0 ? first : second;
    expect((await placer.retry(inputs[index]!.id, 47)).phase).toBe("saved");
    expect(posts).toEqual([901, 902]);
  } finally { secondStore.close(); firstStore.close(); }
});
test("opening an upgraded journal adds zero reservations; legacy unknown targets import on write and survive restart", async () => {
  const file = await path(); let store = new ArenaBlockStore(file);
  const old = { id: crypto.randomUUID(), accountId: 47, blockId: 777, destinations: [901, 902] };
  store.reserveExistingPlacement(old);
  store.updateExistingPlacement(old.id, value => ({ ...value, attempted: [901], phase: "unknown" }));
  const original = store.existingPlacement(old.id); store.close();
  const db = new Database(file); db.exec("DROP TABLE block_connection_attempts"); db.close();
  store = new ArenaBlockStore(file);
  const inspect = new Database(file, { readonly: true });
  expect(inspect.query("SELECT COUNT(*) AS count FROM block_connection_attempts").get()).toEqual({ count: 0 }); inspect.close();
  expect(store.existingPlacement(old.id)).toEqual(original);
  let posts = 0;
  const client = { channel: async (id: number) => ({ id, can: { add_to: true } }), completeBlockConnections: async () => new Set<number>(), connect: async () => { posts++; return []; } } as unknown as ArenaClient;
  const next = { ...old, id: crypto.randomUUID() };
  expect((await new ExistingBlockPlacer(client, store).place(next)).phase).toBe("unknown");
  expect(store.existingPlacement(old.id)).toEqual(original); store.close();
  store = new ArenaBlockStore(file);
  try {
    expect((await new ExistingBlockPlacer(client, store).place({ ...old, id: crypto.randomUUID() })).phase).toBe("unknown");
    expect(posts).toBe(0);
  } finally { store.close(); }
});
test("a formerly confirmed external membership cannot be silently recreated by a different intent", async () => {
  const file = await path(), store = new ArenaBlockStore(file);
  const old = { id: crypto.randomUUID(), accountId: 47, blockId: 777, destinations: [901] };
  store.reserveExistingPlacement(old); store.updateExistingPlacement(old.id, value => ({ ...value, confirmed: [901], phase: "saved" }));
  let posts = 0;
  const client = { channel: async (id: number) => ({ id, can: { add_to: true } }), completeBlockConnections: async () => new Set<number>(), connect: async () => { posts++; return []; } } as unknown as ArenaClient;
  try { expect((await new ExistingBlockPlacer(client, store).place({ ...old, id: crypto.randomUUID() })).phase).toBe("unknown"); expect(posts).toBe(0); }
  finally { store.close(); }
});
test("ordinary and provenance publishers share reservations with existing-block placement workers", async () => {
  for (const remote of [false, true]) {
    const file = await path(), store = new ArenaBlockStore(file), api = new MockApi(), pause = gate(), originalFetch = api.fetch;
    api.fetch = async (...args) => {
      if (args[1]?.method === "POST" && String(args[0]).endsWith("/connections")) { pause.arrive(); await pause.held; }
      return originalFetch(...args);
    };
    const client = new ArenaClient("fixture-never-live", "https://arena.invalid/v3", (...args) => api.fetch(...args), 100);
    const publisher = new ArenaPublisher(client, store, { publicBaseUrl: "https://fixture.invalid", mediaDirectory: join(file, "media"), render: async () => undefined, verifyTimeoutMs: 100, pollIntervalMs: 1,
      ...(remote ? { remoteProvenance: { defaultChannel: "901", mode: "full" as const, credentialProfile: "shared", expectedAccountId: 47 } } : {}) });
    const plan = composePlan([{ provider: "x", id: "1", canonicalUrl: "https://x.com/fictional_fixture/status/1", author: { handle: "fictional_fixture" }, text: "Shared physical placement fixture", media: [] }], { media: "none" });
    const intent = prepareSaveIntent(plan, userConfigSchema.parse({ defaultChannel: { channel: "901", mode: "always" }, provenance: { remoteSnapshot: remote ? "full" : "none" } }), { origin: "cli", initiator: { kind: "human" }, operation: "publish", destinations: [] });
    try {
      const receipt = await publisher.publish({ plan, destinations: ["901"], force: false, operationId: intent.snapshot.saveId,
        ...(remote ? { remoteSave: { snapshot: intent.snapshot, snapshotSha256: intent.snapshotSha256, mode: "full" as const } } : {}) });
      const placer = new ExistingBlockPlacer(client, store), pending = placer.place({ id: crypto.randomUUID(), accountId: 47, blockId: receipt.blockId, destinations: [902] });
      await pause.entered;
      await expect(publisher.resume(receipt.id, ["901", "active"])).rejects.toThrow("no duplicate connect");
      pause.release(); expect((await pending).phase).toBe("saved");
      expect((await publisher.resume(receipt.id, ["901", "active"])).pendingDestinations).toBeUndefined();
      expect(api.connects()).toBe(1); expect(api.rows.map(row => row.channel)).toEqual([901, 902]);
    } finally { pause.release(); store.close(); }
  }
});
test("legacy remote receipts import resolved original attempts without treating their retained slugs as unknown", async () => {
  const file = await path(), store = new ArenaBlockStore(file), api = new MockApi();
  const client = new ArenaClient("fixture-never-live", "https://arena.invalid/v3", (...args) => api.fetch(...args), 100);
  const publisher = new ArenaPublisher(client, store, { publicBaseUrl: "https://fixture.invalid", mediaDirectory: join(file, "media"), render: async () => undefined, verifyTimeoutMs: 100, pollIntervalMs: 1,
    remoteProvenance: { defaultChannel: "901", mode: "full", credentialProfile: "shared", expectedAccountId: 47 } });
  const plan = composePlan([{ provider: "x", id: "1", canonicalUrl: "https://x.com/fictional_fixture/status/1", author: { handle: "fictional_fixture" }, text: "Legacy remote physical reservation", media: [] }], { media: "none" });
  const intent = prepareSaveIntent(plan, userConfigSchema.parse({ defaultChannel: { channel: "901", mode: "always" }, provenance: { remoteSnapshot: "full" } }), { origin: "cli", initiator: { kind: "human" }, operation: "publish", destinations: ["active"] });
  try {
    const receipt = await publisher.publish({ plan, destinations: ["901", "active"], force: false, operationId: intent.snapshot.saveId, remoteSave: { snapshot: intent.snapshot, snapshotSha256: intent.snapshotSha256, mode: "full" } });
    store.updateReceipt(receipt.id, value => ({ ...value, attemptedChannelIds: undefined }));
    const original = store.remoteSave(intent.snapshot.saveId)!.intent;
    const db = new Database(file); db.exec("DELETE FROM block_connection_attempts"); db.close();
    expect((await new ExistingBlockPlacer(client, store).place({ id: crypto.randomUUID(), accountId: 47, blockId: receipt.blockId, destinations: [903] })).phase).toBe("saved");
    expect(api.rows.map(row => row.channel)).toEqual([901, 902, 903]);
    expect(store.remoteSave(intent.snapshot.saveId)!.intent).toEqual(original);
    expect(store.receipt(receipt.id)!.attemptedChannelIds).toBeUndefined();
  } finally { store.close(); }
});
