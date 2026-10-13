import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArenaClient, ArenaPublisher } from "../src/arena.ts";
import { ArenaBlockStore } from "../src/store.ts";
import { userConfigSchema, routeSave } from "../src/config.ts";
import { composePlan } from "../src/compose.ts";
import { prepareSaveIntent, snapshotHash } from "../src/save-intent.ts";
import { saveSnapshotSchema } from "../src/provenance-schema.ts";
import { remoteProvenancePolicySchema, type RemoteConnectionMigration } from "../src/remote-save.ts";
import { SaveGateway } from "../src/save-gateway.ts";
import { MockApi } from "./fixtures/remote-api.ts";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const plan = composePlan([{ provider: "x", id: "1", canonicalUrl: "https://x.com/fixture/status/1", author: { handle: "fixture" }, text: "Relocation fixture.", media: [] }]);
function intent(channel = "901", mode: "fallback" | "always" = "always", destinations = ["active"]) {
  return prepareSaveIntent(plan, userConfigSchema.parse({ defaultChannel: { channel, mode }, provenance: { remoteSnapshot: "full" } }),
    { origin: "cli", initiator: { kind: "human" }, operation: "publish", destinations });
}
const policy = (channel = "901") => ({ defaultChannel: channel, mode: "full" as const, credentialProfile: "shared", expectedAccountId: 47 });

test("one default has distinct fallback and every-save policies; provenance follows its actual placement", () => {
  const fallback = userConfigSchema.parse({ defaultChannel: { channel: "chosen-default" }, provenance: { remoteSnapshot: "full" } });
  expect(routeSave(fallback, [], ["old-env-default"]).destinations).toEqual(["chosen-default"]);
  expect(routeSave(fallback, ["explicit"]).destinations).toEqual(["explicit"]);
  expect(prepareSaveIntent(plan, fallback, { origin: "cli", initiator: { kind: "human" }, destinations: ["explicit"] }).remoteMetadata).toBeUndefined();
  expect(routeSave(fallback, ["explicit", "chosen-default"]).defaultChannel?.reason).toBe("explicit");
  const always = userConfigSchema.parse({ defaultChannel: { channel: "chosen-default", mode: "always" } });
  expect(routeSave(always, ["explicit"]).destinations).toEqual(["chosen-default", "explicit"]);
  expect(routeSave(always, []).destinations).toEqual(["chosen-default"]);
});

test("legacy config normalizes to one default, retaining always mode and rejecting ambiguous migration", () => {
  expect(userConfigSchema.parse({ remoteInbox: { channel: 901, mode: "always" } }).defaultChannel).toEqual({ channel: "901", mode: "always" });
  expect(userConfigSchema.parse({ defaultDestinations: ["legacy"] }).defaultChannel).toEqual({ channel: "legacy", mode: "fallback" });
  expect(() => userConfigSchema.parse({ defaultChannel: { channel: "new" }, remoteInbox: { channel: "old" } })).toThrow("disagree");
  expect(() => userConfigSchema.parse({ defaultDestinations: ["one", "two"] })).toThrow("Choose one");
  expect(remoteProvenancePolicySchema.parse({ inboxChannel: "901", mode: "full", credentialProfile: "shared", expectedAccountId: 47 })).toEqual(policy());
});

test("immutable legacy snapshots keep their original routing and checksum", () => {
  const snapshot = intent().snapshot;
  const chosen = snapshot.routing.defaultChannel!;
  delete snapshot.routing.defaultChannel;
  snapshot.routing.remoteInbox = { ...chosen, reason: "always_log" };
  const bytes = JSON.stringify(snapshot), checksum = snapshotHash(snapshot);
  expect(JSON.stringify(saveSnapshotSchema.parse(snapshot))).toBe(bytes);
  expect(snapshotHash(saveSnapshotSchema.parse(snapshot))).toBe(checksum);
});

test("a verified relocation supports old replay and new save events without recreating the retired connection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arena-default-migration-")); directories.push(directory);
  const store = new ArenaBlockStore(join(directory, "state.sqlite"), { private: true });
  const api = new MockApi(); api.privateChannels.add(904);
  const client = new ArenaClient("fixture", "https://arena.invalid/v3", api.fetch as typeof fetch, 100);
  const publisher = (channel: string) => new ArenaPublisher(client, store, { publicBaseUrl: "https://fixture.invalid", mediaDirectory: join(directory, "media"), render: async () => undefined,
    pollIntervalMs: 1, verifyTimeoutMs: 100, remoteProvenance: policy(channel) });
  const original = intent();
  const oldDefault = original.snapshot.routing.defaultChannel!;
  delete original.snapshot.routing.defaultChannel; original.snapshot.routing.remoteInbox = { ...oldDefault, reason: "always_log" };
  original.snapshotSha256 = snapshotHash(original.snapshot);
  const request = { plan, destinations: original.snapshot.routing.destinations, force: false, operationId: original.snapshot.saveId,
    remoteSave: { snapshot: original.snapshot, snapshotSha256: original.snapshotSha256, mode: "full" as const } };
  let gateway: SaveGateway | undefined;
  try {
    const receipt = await publisher("901").publish(request);
    const oldLater = intent("901", "always", ["active"]);
    const laterDefault = oldLater.snapshot.routing.defaultChannel!;
    delete oldLater.snapshot.routing.defaultChannel; oldLater.snapshot.routing.remoteInbox = { ...laterDefault, reason: "always_log" };
    oldLater.snapshotSha256 = snapshotHash(oldLater.snapshot);
    api.loseUpdate = true;
    await expect(publisher("901").publish({ plan, destinations: oldLater.snapshot.routing.destinations, force: false, operationId: oldLater.snapshot.saveId,
      remoteSave: { snapshot: oldLater.snapshot, snapshotSha256: oldLater.snapshotSha256, mode: "full" } })).rejects.toThrow("Metadata response lost");
    expect(store.remoteSaveEvent(oldLater.snapshot.saveId)?.state).toBe("pending");
    const prior = store.remoteSave(original.snapshot.saveId)!;
    const unchangedIntent = JSON.stringify(prior.intent);
    prior.state = "unknown"; store.saveRemoteSave(prior);
    store.updateReceipt(receipt.id, value => ({ ...value, pendingDestinations: ["901", "active"], remoteProvenance: { ...value.remoteProvenance!, state: "unknown" } }));
    const old = api.rows.find(row => row.channel === 901)!;
    const relocated = api.add(receipt.blockId, 904, { ...old.connection.metadata, user_note: "Preserved target note" });
    const migration: RemoteConnectionMigration = { saveId: prior.saveId, accountId: 47, blockId: receipt.blockId,
      fromChannelId: 901, fromConnectionId: old.connection.id, toChannelId: 904, toConnectionId: relocated.id,
      metadataSha256: "a".repeat(64), migratedAt: new Date().toISOString() };
    (store as ArenaBlockStore & { remoteConnectionMigration: (id: string) => RemoteConnectionMigration | undefined }).remoteConnectionMigration = id => id === prior.saveId ? migration : undefined;
    api.rows = api.rows.filter(row => row.channel !== 901);
    const current = publisher("904");
    const resumed = await current.resume(receipt.id, []);
    expect(resumed.remoteProvenance).toMatchObject({ inboxChannelId: 904, connectionId: relocated.id, state: "verified" });
    gateway = new SaveGateway(client, current, store, { profile: "shared", expectedAccountId: 47 }, policy("904"));
    const result = await gateway.save({ plan, snapshot: original.snapshot, snapshotSha256: original.snapshotSha256, remoteMode: "full" }, "cli");
    expect(result.phase).toBe("saved");
    const priorEventIntent = JSON.stringify(store.remoteSaveEvent(oldLater.snapshot.saveId)!.intent);
    expect((await gateway.save({ plan, snapshot: oldLater.snapshot, snapshotSha256: oldLater.snapshotSha256, remoteMode: "full" }, "cli")).phase).toBe("saved");
    expect(store.remoteSaveEvent(oldLater.snapshot.saveId)?.state).toBe("verified");
    expect(JSON.stringify(store.remoteSaveEvent(oldLater.snapshot.saveId)!.intent)).toBe(priorEventIntent);
    const later = intent("904", "always", ["later"]);
    await current.publish({ plan, destinations: later.snapshot.routing.destinations, force: false, operationId: later.snapshot.saveId,
      remoteSave: { snapshot: later.snapshot, snapshotSha256: later.snapshotSha256, mode: "full" } });
    expect(api.creates()).toBe(1);
    expect(api.rows.some(row => row.channel === 901)).toBe(false);
    expect(relocated.metadata.ab_save_id).toBe(prior.saveId);
    expect(relocated.metadata.ab_latest_save_id).toBe(later.snapshot.saveId);
    expect(relocated.metadata.user_note).toBe("Preserved target note");
    expect(JSON.stringify(store.remoteSave(prior.saveId)!.intent)).toBe(unchangedIntent);
    const puts = api.puts();
    relocated.metadata.ab_snapshot_sha256 = "conflict";
    await expect(current.resume(receipt.id, [])).rejects.toThrow("original provenance");
    expect(api.puts()).toBe(puts);
  } finally { await gateway?.close(); store.close(); }
});
