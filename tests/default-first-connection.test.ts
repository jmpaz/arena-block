import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArenaClient, ArenaPublisher } from "../src/arena.ts";
import { ArenaBlockStore } from "../src/store.ts";
import { composePlan } from "../src/compose.ts";
import { userConfigSchema } from "../src/config.ts";
import { prepareSaveIntent } from "../src/save-intent.ts";
import type { PublishRequest } from "../src/types.ts";
import { MockApi } from "./fixtures/remote-api.ts";

const paths: string[] = [], stores: ArenaBlockStore[] = [];
afterEach(async () => { stores.splice(0).forEach(store => store.close()); await Promise.all(paths.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const plan = composePlan([{ provider: "x", id: "1", canonicalUrl: "https://x.com/fictional_fixture/status/1", author: { handle: "fictional_fixture" }, text: "Ordered connection fixture", media: [] }], { media: "none" });
function request(destinations: string[], mode: "always" | "fallback" | null = "always", remote = true): PublishRequest {
  const config = userConfigSchema.parse({ ...(mode ? { defaultChannel: { channel: "901", mode } } : {}), provenance: { remoteSnapshot: remote ? "full" : "none" }, credentialProfiles: { shared: { arenaTokenEnv: "ARENA_WRITE_ACCESS_TOKEN", expectedAccountId: 47 } } });
  const intent = prepareSaveIntent(plan, config, { origin: "cli", initiator: { kind: "human" }, operation: "publish", destinations });
  return { plan, destinations: intent.snapshot.routing.destinations, force: false, operationId: intent.snapshot.saveId,
    ...(intent.remoteMetadata ? { remoteSave: { snapshot: intent.snapshot, snapshotSha256: intent.snapshotSha256, mode: "full" as const } } : {}) };
}
async function harness(remote = true) {
  const path = await mkdtemp(join(tmpdir(), "arena-first-connection-")); paths.push(path);
  const store = new ArenaBlockStore(join(path, "state.sqlite")); stores.push(store);
  const api = new MockApi(), client = new ArenaClient("fixture-never-live", "https://arena.invalid/v3", (...args) => api.fetch(...args), 100);
  const publisher = new ArenaPublisher(client, store, { publicBaseUrl: "https://fixture.invalid", mediaDirectory: join(path, "media"), render: async () => undefined, verifyTimeoutMs: 100, pollIntervalMs: 1,
    ...(remote ? { remoteProvenance: { defaultChannel: "901", mode: "full" as const, credentialProfile: "shared", expectedAccountId: 47 } } : {}) });
  return { api, store, publisher };
}
const writes = (api: MockApi) => api.calls.filter(call => call.method === "POST" && ["/blocks", "/connections"].includes(call.path));
const targets = (body: any): number[] => body.channels?.map((channel: any) => channel.id) ?? body.channel_ids;

test("default is the only creation target and extras follow confirmed single-channel POSTs", async () => {
  const { api, publisher } = await harness(); const input = request(["active", "later", "904", "905", "906"]);
  await publisher.publish(input);
  const posts = writes(api);
  expect(posts.map(post => targets(post.body))).toEqual([[901], [902], [903], [904], [905], [906]]);
  expect(posts[0]!.body.channels[0].metadata.ab_save_id).toBe(input.operationId);
  expect(posts.slice(1).every(post => post.body.channels[0].metadata === undefined)).toBe(true);
  expect(api.rows.map(row => row.channel)).toEqual([901, 902, 903, 904, 905, 906]);
  const firstExtra = api.calls.indexOf(posts[1]!);
  expect(api.calls.slice(0, firstExtra).some(call => call.method === "GET" && call.path === "/connections/700")).toBe(true);
  for (let index = 1; index < posts.length - 1; index++) {
    const between = api.calls.slice(api.calls.indexOf(posts[index]!) + 1, api.calls.indexOf(posts[index + 1]!));
    expect(between.some(call => call.method === "GET" && call.path === `/channels/${targets(posts[index]!.body)[0]}/contents`)).toBe(true);
  }
});
test("snapshot-none saves use first-only creation without provenance and preserve extra order", async () => {
  const { api, publisher } = await harness(false);
  await publisher.publish(request(["later", "active"], "always", false));
  expect(writes(api).map(post => targets(post.body))).toEqual([[901], [903], [902]]);
  expect(api.rows.every(row => Object.keys(row.connection.metadata).length === 0)).toBe(true);
});
test("no default and fallback explicit destinations do not gain a hidden default connection", async () => {
  for (const mode of [null, "fallback"] as const) {
    const { api, publisher } = await harness(false);
    const input = request(["active", "later"], mode, false);
    await publisher.publish(input);
    expect(writes(api).map(post => targets(post.body))).toEqual([[902], [903]]);
    expect(api.rows.some(row => row.channel === 901)).toBe(false);
  }
});
test("fallback without explicit choices creates the default first and aliases are deduplicated", async () => {
  const first = await harness(); await first.publisher.publish(request([], "fallback"));
  expect(writes(first.api).map(post => targets(post.body))).toEqual([[901]]);
  const second = await harness(); await second.publisher.publish(request(["active", "902", "901", "later"]));
  expect(writes(second.api).map(post => targets(post.body))).toEqual([[901], [902], [903]]);
});
test("an unconfirmed initial default never permits extra placements or a duplicate default POST", async () => {
  const { api, publisher } = await harness(); const input = request(["active", "later"]); api.omitInbox = true;
  await expect(publisher.publish(input)).rejects.toThrow("Initial inbox placement");
  await expect(publisher.publish(input)).rejects.toThrow("Initial inbox placement");
  expect(writes(api).map(post => targets(post.body))).toEqual([[901]]);
});
test("response loss on an extra stops later writes and replay confirms before advancing", async () => {
  for (const remote of [true, false]) {
    const { api, store, publisher } = await harness(remote); const input = request(["active", "later"], "always", remote); api.loseConnect = true;
    await expect(publisher.publish(input)).rejects.toThrow("Connect response lost");
    expect(writes(api).map(post => targets(post.body))).toEqual([[901], [902]]);
    const original = remote ? structuredClone(store.remoteSave(input.operationId!)!.intent) : undefined;
    await publisher.publish(input);
    expect(writes(api).map(post => targets(post.body))).toEqual([[901], [902], [903]]);
    expect(api.rows.map(row => row.channel)).toEqual([901, 902, 903]);
    if (original) expect(store.remoteSave(input.operationId!)!.intent).toEqual(original);
  }
});
test("successful response without membership blocks later placements and blind retries", async () => {
  for (const remote of [true, false]) {
    const { api, publisher } = await harness(remote); const input = request(["active", "later"], "always", remote); const original = api.fetch;
    api.fetch = async (...args) => {
      const response = await original(...args);
      if (args[1]?.method === "POST" && String(args[0]).endsWith("/connections")) api.rows = api.rows.filter(row => row.channel !== 902);
      return response;
    };
    await expect(publisher.publish(input)).rejects.toThrow("later placements were not sent");
    await expect(publisher.publish(input)).rejects.toThrow("previously attempted placement");
    expect(writes(api).map(post => targets(post.body))).toEqual([[901], [902]]);
  }
});
test("legacy batch reservations remain ambiguous and are not reinterpreted as never sent", async () => {
  const { api, store, publisher } = await harness(); const input = request(["active", "later"]); api.loseCreate = true;
  await expect(publisher.publish(input)).rejects.toThrow("unknown");
  const record = store.remoteSave(input.operationId!)!;
  record.attemptedChannels = [...record.intent.channelIds]; store.saveRemoteSave(record);
  await expect(publisher.publish(input)).rejects.toThrow("previously attempted placement");
  expect(writes(api).map(post => targets(post.body))).toEqual([[901]]);
});
test("legacy plain pending batch is never repeated while completed legacy receipts allow new targets", async () => {
  const first = await harness(false); const input = request([], "always", false);
  const receipt = await first.publisher.publish(input);
  first.store.updateReceipt(receipt.id, value => ({ ...value, attemptedChannelIds: undefined, pendingDestinations: ["active", "later"] }));
  await expect(first.publisher.resume(receipt.id, ["active", "later"])).rejects.toThrow("previously attempted placement");
  expect(writes(first.api).map(post => targets(post.body))).toEqual([[901]]);
  const second = await harness(false); const completed = await second.publisher.publish(request([], "always", false));
  second.store.updateReceipt(completed.id, value => ({ ...value, attemptedChannelIds: undefined }));
  await second.publisher.resume(completed.id, ["active", "later"]);
  expect(writes(second.api).map(post => targets(post.body))).toEqual([[901], [902], [903]]);
});
test("an existing block connects missing default with event metadata before new explicit placements", async () => {
  const { api, store, publisher } = await harness();
  await publisher.publish({ plan, destinations: ["904"], force: false });
  const input = request(["active", "later"]); await publisher.publish(input);
  expect(writes(api).map(post => targets(post.body))).toEqual([[904], [901], [902], [903]]);
  expect(writes(api)[1]!.body.channels[0].metadata).toMatchObject({ ab_latest_save_id: input.operationId, ab_latest_event_kind: "legacy_block" });
  expect(store.remoteSaveEvent(input.operationId!)?.state).toBe("verified");
  expect(api.calls.some(call => call.method === "DELETE")).toBe(false);
});
test("an existing default is read and validated before extras while its latest pointer updates afterward", async () => {
  const { api, publisher } = await harness();
  await publisher.publish({ plan, destinations: ["901"], force: false });
  api.rows[0]!.connection.metadata = { unrelated: "preserved" };
  await publisher.publish(request(["active", "later"]));
  const posts = writes(api), firstExtra = api.calls.indexOf(posts[1]!), lastExtra = api.calls.indexOf(posts[2]!);
  expect(api.calls.slice(0, firstExtra).some(call => call.method === "GET" && call.path === "/connections/700")).toBe(true);
  expect(api.calls.findIndex(call => call.method === "PUT" && call.path === "/connections/700")).toBeGreaterThan(lastExtra);
  expect(api.rows[0]!.connection.metadata.unrelated).toBe("preserved");
});
test("foreign actor or conflicting original metadata on an existing default blocks all extra writes", async () => {
  for (const fault of ["actor", "metadata"] as const) {
    const { api, publisher } = await harness();
    await publisher.publish({ plan, destinations: ["901"], force: false });
    if (fault === "actor") api.rows[0]!.connection.connected_by = { id: 48 };
    else api.rows[0]!.connection.metadata.ab_save_id = crypto.randomUUID();
    await expect(publisher.publish(request(["active", "later"]))).rejects.toThrow();
    expect(writes(api).map(post => targets(post.body))).toEqual([[901]]);
    expect(api.puts()).toBe(0);
  }
});
test("failed read-only authorization before a new default POST leaves its write unattempted", async () => {
  const { api, store, publisher } = await harness();
  const receipt = await publisher.publish({ plan, destinations: ["904"], force: false });
  const input = request(["active"]); api.transientRead = true;
  await expect(publisher.publish(input)).rejects.toThrow();
  expect(store.receipt(receipt.id)!.attemptedChannelIds).toEqual([904]);
  expect(writes(api).map(post => targets(post.body))).toEqual([[904]]);
  await publisher.publish(input);
  expect(writes(api).map(post => targets(post.body))).toEqual([[904], [901], [902]]);
});
