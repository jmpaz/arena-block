import { MockApi } from "./fixtures/remote-api.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, chmod, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArenaClient, ArenaPublisher } from "../src/arena.ts";
import { ArenaBlockStore } from "../src/store.ts";
import { composePlan } from "../src/compose.ts";
import { prepareSaveIntent } from "../src/save-intent.ts";
import { userConfigSchema } from "../src/config.ts";
import { readProvenanceMetadata, mergedMetadata, type Metadata } from "../src/connection-metadata.ts";
import { createService, loadServiceConfig } from "../src/service.ts";
import type { BlockPlan, PublishRequest } from "../src/types.ts";
import type { RemoteProvenancePolicy } from "../src/remote-save.ts";
import { saveSnapshotSchema } from "../src/provenance-schema.ts";
import { qualificationPlan, qualificationRequests, qualificationBoundaryPatch, QUALIFICATION_APPROVAL } from "./fixtures/qualification-fixtures.ts";
import { runApprovedQualification, verifyCompletedQualification } from "./fixtures/remote-qualification.ts";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const policy: RemoteProvenancePolicy = { inboxChannel: "901", mode: "full", credentialProfile: "shared", expectedAccountId: 47 };
function request(text = "Fictional qualification text. No source was fetched.", destinations = ["901", "active"], suppliedPlan?: BlockPlan): PublishRequest {
  const plan = suppliedPlan ?? composePlan([{ provider: "x", id: "1", canonicalUrl: "https://x.com/fictional_fixture/status/1", author: { handle: "fictional_fixture" }, text, media: [] }], { media: "none" });
  const config = userConfigSchema.parse({ remoteInbox: { channel: "901", mode: "always" }, provenance: { remoteSnapshot: "full" }, credentialProfiles: { shared: { arenaTokenEnv: "ARENA_WRITE_ACCESS_TOKEN", expectedAccountId: 47 } } });
  const intent = prepareSaveIntent(plan, config, { origin: "cli", initiator: { kind: "human" }, destinations, operation: "publish" });
  return { plan, destinations: intent.snapshot.routing.destinations, force: false, operationId: intent.snapshot.saveId,
    remoteSave: { snapshot: intent.snapshot, snapshotSha256: intent.snapshotSha256, mode: "full" } };
}

async function harness(enabled = true) {
  const directory = await mkdtemp(join(tmpdir(), "arena-remote-publisher-")); directories.push(directory);
  const api = new MockApi(), store = new ArenaBlockStore(join(directory, "state.sqlite"));
  const client = new ArenaClient("fixture-never-live", "https://arena.invalid/v3", api.fetch as typeof fetch, 100);
  const publisher = new ArenaPublisher(client, store, { publicBaseUrl: "https://fixture.invalid", mediaDirectory: join(directory, "media"),
    render: async () => undefined, verifyTimeoutMs: 100, pollIntervalMs: 1, ...(enabled ? { remoteProvenance: policy } : {}) });
  return { api, store, publisher, directory };
}

describe("private remote provenance publisher integration", () => {
  test("records a relocation without rewriting original provenance or accepting another mapping", async () => {
    const { publisher, store } = await harness();
    const input = request();
    const receipt = await publisher.publish(input);
    const original = store.remoteSave(input.operationId!)!;
    const mapping = { saveId: original.saveId, accountId: 47, blockId: receipt.blockId,
      fromChannelId: 901, fromConnectionId: original.connectionId!, toChannelId: 903,
      toConnectionId: 800, metadataSha256: "a".repeat(64), migratedAt: "2026-10-06T00:00:00Z" };
    store.recordRemoteConnectionMigration(mapping);
    store.recordRemoteConnectionMigration(mapping);
    expect(store.remoteConnectionMigration(original.saveId)).toEqual(mapping);
    expect(store.remoteSave(original.saveId)).toEqual(original);
    expect(() => store.recordRemoteConnectionMigration({ ...mapping, toConnectionId: 801 })).toThrow("immutable");
    expect(() => store.recordRemoteConnectionMigration({ ...mapping, fromConnectionId: 999 })).toThrow("original");
    store.close();
  });
  test("creates one block with inbox-only metadata, verified account and actual channel mapping", async () => {
    const { api, publisher, store } = await harness(); const input = request();
    const receipt = await publisher.publish(input);
    expect(receipt.status).toBe("verified"); expect(receipt.remoteProvenance).toMatchObject({ accountId: 47, inboxChannelId: 901, connectionId: 700, state: "verified" });
    const payload = api.calls.find(call => call.method === "POST")!.body;
    expect(payload.channel_ids).toBeUndefined(); expect(payload.channels[0].metadata.ab_save_id).toBe(input.operationId);
    expect(payload.channels).toHaveLength(1); expect(payload.metadata?.ab_save_id).toBeUndefined();
    expect(api.calls.find(call => call.method === "POST" && call.path === "/connections")!.body.channels).toEqual([{ id: 902 }]);
    expect(api.creates()).toBe(1); expect(api.connects()).toBe(1);
    const metadata = api.rows[0]!.connection.metadata;
    expect(readProvenanceMetadata(metadata)).toEqual(saveSnapshotSchema.parse(input.remoteSave!.snapshot));
    expect(metadata.ab_actor_id).toBe(47); expect(metadata.ab_result_status).toBe("verified");
    expect(store.remoteSave(input.operationId!)?.intent.snapshot).toEqual(saveSnapshotSchema.parse(input.remoteSave!.snapshot));
    store.close();
  });
  test("disabled daemon rejects remote intent without any Are.na request", async () => {
    const { api, publisher, store } = await harness(false);
    await expect(publisher.publish(request())).rejects.toThrow("disabled"); expect(api.calls).toHaveLength(0); store.close();
  });
  test("wrong actor, public inbox and permission failure stop before block creation", async () => {
    for (const fault of ["actor", "visibility", "permission", "owner"]) {
      const { api, publisher, store } = await harness();
      if (fault === "actor") api.account = 48; else if (fault === "visibility") api.visibility = "public"; else if (fault === "owner") api.ownerId = 48; else api.writable = false;
      await expect(publisher.publish(request())).rejects.toThrow(); expect(api.creates()).toBe(0); store.close();
    }
  });
  test("tampered capsule rejects before network or credential use", async () => {
    const { api, publisher, store } = await harness(); const input = request();
    (input.remoteSave!.snapshot.plan as any).block.markdown = "Tampered";
    await expect(publisher.publish(input)).rejects.toThrow("checksum"); expect(api.calls).toHaveLength(0); store.close();
  });
  test("caller changes cannot race the actual plan or capsule", async () => {
    const { api, publisher, store } = await harness(); const input = request(); const original = structuredClone(input);
    const pending = publisher.publish(input); input.plan.block.markdown = "Changed after submission";
    (input.remoteSave!.snapshot.plan as any).block.markdown = "Also changed";
    const receipt = await pending; expect(api.blocks.get(receipt.blockId)?.content.markdown).toBe(original.plan.block.markdown);
    expect(store.remoteSave(original.operationId!)?.intent.snapshot).toEqual(saveSnapshotSchema.parse(original.remoteSave!.snapshot)); store.close();
  });
  test("same save replay and slug/numeric aliases never duplicate a block or inbox connection", async () => {
    const { api, publisher, store } = await harness(); const input = request(undefined, ["901", "active", "902"]);
    const first = await publisher.publish(input), second = await publisher.publish(input);
    expect(second.id).toBe(first.id); expect(api.creates()).toBe(1); expect(api.rows).toHaveLength(2); expect(api.connects()).toBe(1); store.close();
  });
  test("a 21-source capsule keeps its immutable receipt across two requested channels and replay", async () => {
    const expanded = composePlan(Array.from({ length: 21 }, (_, index) => ({
      provider: "x" as const, id: String(index + 1), canonicalUrl: `https://x.com/fixture/status/${index + 1}`,
      author: { handle: "fixture" }, text: `Part ${index + 1}`, media: [],
    })), { media: "none", threadExpansion: "on" });
    const input = request(undefined, ["901", "active", "later"], expanded);
    const { api, publisher, store } = await harness();
    const first = await publisher.publish(input), replay = await publisher.publish(input);
    expect(first.status).toBe("verified");
    expect(first.planHash).toBe(expanded.hash);
    expect(first.destinations).toContain("active");
    expect(first.destinations).toContain("later");
    expect(store.remoteSave(input.operationId!)?.intent.snapshot.plan.hash).toBe(expanded.hash);
    expect(replay.id).toBe(first.id);
    expect(api.creates()).toBe(1);
    expect(api.connects()).toBe(2);
    store.close();
  });
  test("a combined expanded thread and Forum Magnum comment stays intact in the saved capsule", async () => {
    const posts = Array.from({ length: 21 }, (_, index) => ({
      provider: "x" as const, id: String(index + 1), canonicalUrl: `https://x.com/fixture/status/${index + 1}`,
      author: { handle: "fixture" }, text: `Part ${index + 1}`, media: [],
    }));
    const combined = composePlan([...posts, { provider: "forum_magnum" as const, id: "CommentABC123",
      canonicalUrl: "https://www.lesswrong.com/posts/PostABC123/?commentId=CommentABC123",
      author: { handle: "writer" }, text: "A public comment", media: [],
    }], { media: "none", threadExpansion: "on" });
    const input = request(undefined, ["901", "active"], combined);
    const { api, publisher, store } = await harness();
    const receipt = await publisher.publish(input);
    expect(receipt.status).toBe("verified");
    expect(receipt.planHash).toBe(combined.hash);
    const retained = store.remoteSave(input.operationId!)?.intent.snapshot.plan;
    expect(retained?.sources).toHaveLength(22);
    expect(retained?.sources[21]).toMatchObject({ provider: "forum_magnum", id: "CommentABC123", text: "A public comment" });
    expect(api.creates()).toBe(1);
    store.close();
  });
  test("finds an old extra placement on page four and proves a missing destination from complete block membership", async () => {
    const { api, publisher, store } = await harness();
    const first = await publisher.publish(request());
    const connects = api.connects(), before = api.calls.length;
    api.placementPage.set(902, 4); // Existing connection is older than 300 channel entries.
    const resumed = await publisher.resume(first.id, ["active"]);
    expect(resumed.status).toBe("verified");
    expect(api.creates()).toBe(1);
    expect(api.connects()).toBe(connects);
    expect(api.calls.slice(before).filter(call => call.path === "/channels/902/contents")).toHaveLength(4);
    const after = await publisher.resume(first.id, ["later"]);
    expect(after.status).toBe("verified");
    expect(after.pendingDestinations).toBeUndefined();
    expect(api.creates()).toBe(1); expect(api.connects()).toBe(connects + 1);
    expect(api.calls.filter(call => call.method === "POST" && call.path === "/connections").at(-1)?.body.channels).toEqual([{ id: 903 }]);
    const again = await publisher.resume(first.id, ["later"]);
    expect(again.status).toBe("verified"); expect(api.connects()).toBe(connects + 1);
    expect(api.rows[0]!.connection.metadata.ab_save_id).toBeDefined();
    expect(api.rows.at(-1)!.connection.metadata).toEqual({});
    store.close();
  });
  test("a partial verified save resumes an older confirmed placement without creating, reconnecting or rewriting the block", async () => {
    const { api, publisher, store } = await harness();
    api.loseConnect = true;
    const input = request();
    await expect(publisher.publish(input)).rejects.toThrow("Connect response lost");
    const partial = store.operationState(input.operationId!)!.receipt!;
    expect(partial.status).toBe("verified"); expect(partial.pendingDestinations).toContain("active");
    const count = api.connects();
    api.placementPage.set(902, 4);
    const start = api.calls.length;
    const resumed = await publisher.resume(partial.id, ["active"]);
    expect(resumed.id).toBe(partial.id); expect(resumed.blockId).toBe(partial.blockId);
    expect(resumed.pendingDestinations).toBeUndefined(); expect(resumed.remoteProvenance?.state).toBe("verified");
    expect(api.creates()).toBe(1); expect(api.connects()).toBe(count);
    expect(api.calls.slice(start).some(call => call.path === "/blocks" && call.method === "POST" || /^\/blocks\/\d+$/.test(call.path) && call.method === "PUT")).toBe(false);
    expect(api.calls.slice(start).filter(call => call.path === "/channels/902/contents")).toHaveLength(4);
    expect(api.rows[0]!.connection.metadata.ab_save_id).toBe(input.operationId);
    expect(api.rows[1]!.connection.metadata).toEqual({});
    store.close();
  });
  test("incomplete block membership cannot authorize an extra connection", async () => {
    const { api, publisher, store } = await harness();
    const first = await publisher.publish(request());
    const connects = api.connects();
    api.blockConnectionsComplete = false;
    await expect(publisher.resume(first.id, ["later"])).rejects.toThrow("Block connections lack complete pagination evidence");
    expect(api.creates()).toBe(1); expect(api.connects()).toBe(connects);
    store.close();
  });
  test("freshly observed membership is journaled before a later lost POST and cannot be duplicated after removal", async () => {
    const { api, publisher, store } = await harness();
    const first = await publisher.publish(request(undefined, ["901"]));
    let reads = 0;
    api.onBlockConnectionRead = () => { if (++reads === 3) api.add(first.blockId, 902); };
    api.loseConnect = true;
    await expect(publisher.resume(first.id, ["active", "later"])).rejects.toThrow("Connect response lost");
    api.onBlockConnectionRead = undefined;
    const afterLoss = api.connects();
    expect(afterLoss).toBe(1); // Only the later channel received a POST.
    api.rows = api.rows.filter(row => !(row.block === first.blockId && row.channel === 902));
    await expect(publisher.resume(first.id, ["active", "later"])).rejects.toThrow("already attempted");
    expect(api.connects()).toBe(afterLoss);
    expect(api.creates()).toBe(1);
    store.close();
  });
  test("initially observed membership survives a later lookup failure and cannot be duplicated after removal", async () => {
    const { api, publisher, store } = await harness();
    const first = await publisher.publish(request(undefined, ["901"]));
    api.add(first.blockId, 902);
    api.add(first.blockId, 903);
    api.failContentsFor = 903;
    await expect(publisher.resume(first.id, ["active", "later"])).rejects.toThrow("returned 400");
    api.failContentsFor = undefined;
    api.rows = api.rows.filter(row => !(row.block === first.blockId && row.channel === 902));
    await expect(publisher.resume(first.id, ["active", "later"])).rejects.toThrow("already attempted");
    expect(api.connects()).toBe(0);
    expect(api.creates()).toBe(1);
    store.close();
  });
  test("each later save gets an immutable event and a bounded Inbox pointer without replacing the original", async () => {
    const { api, publisher, store } = await harness(); const first = request(); const receipt = await publisher.publish(first);
    const later = request(undefined, ["901", "later"]);
    const next = await publisher.publish(later);
    expect(next.id).toBe(receipt.id); expect(api.creates()).toBe(1); expect(api.connects()).toBe(2);
    expect(store.remoteSave(first.operationId!)?.intent.snapshot).toEqual(saveSnapshotSchema.parse(first.remoteSave!.snapshot));
    expect(store.remoteSaveEvent(later.operationId!)?.state).toBe("verified");
    expect(store.remoteSaveEvent(later.operationId!)?.intent.snapshot).toEqual(saveSnapshotSchema.parse(later.remoteSave!.snapshot));
    const metadata = api.rows[0]!.connection.metadata;
    expect(metadata.ab_save_id).toBe(first.operationId);
    expect(readProvenanceMetadata(metadata)).toEqual(saveSnapshotSchema.parse(first.remoteSave!.snapshot));
    expect(metadata.ab_latest_save_id).toBe(later.operationId);
    expect(metadata.ab_latest_snapshot_sha256).toBe(later.remoteSave!.snapshotSha256);
    expect(metadata.ab_latest_receipt_id).toBe(receipt.id);
    expect(api.rows[2]!.connection.metadata).toEqual({});
    store.close();
  });
  test("same later save replays without duplicate metadata or placement writes", async () => {
    const { api, publisher, store } = await harness(); await publisher.publish(request());
    const later = request(undefined, ["901", "later"]);
    const first = await publisher.publish(later), puts = api.puts(), connects = api.connects();
    const second = await publisher.publish(later);
    expect(second.id).toBe(first.id); expect(api.creates()).toBe(1);
    expect(api.connects()).toBe(connects); expect(api.puts()).toBe(puts);
    expect(store.remoteSaveEvent(later.operationId!)?.state).toBe("verified"); store.close();
  });
  test("later events use the recorded Inbox connection when its channel has outgrown a bounded scan", async () => {
    const { api, publisher, store } = await harness(); await publisher.publish(request());
    const before = api.calls.length; api.inboxComplete = false;
    const later = request(); await publisher.publish(later);
    expect(api.calls.slice(before).filter(call => call.path === "/channels/901/contents")).toHaveLength(0);
    expect(api.calls.slice(before).some(call => call.path === "/blocks/10000/connections")).toBe(true);
    expect(store.remoteSaveEvent(later.operationId!)?.state).toBe("verified"); store.close();
  });
  test("lost later placement is reconciled before event metadata, without a second connect", async () => {
    const { api, publisher, store } = await harness(); await publisher.publish(request());
    const later = request(undefined, ["901", "later"]); api.loseConnect = true;
    await expect(publisher.publish(later)).rejects.toThrow("Connect response lost");
    expect(store.remoteSaveEvent(later.operationId!)?.state).toBe("prepared");
    expect(api.rows[0]!.connection.metadata.ab_latest_save_id).toBeUndefined();
    const connects = api.connects(); await publisher.publish(later);
    expect(api.connects()).toBe(connects); expect(api.creates()).toBe(1);
    expect(store.remoteSaveEvent(later.operationId!)?.state).toBe("verified"); store.close();
  });
  test("a prepared event with an uncertain placement blocks newer metadata until recovery", async () => {
    const { api, publisher, store } = await harness(); const first = await publisher.publish(request());
    const pending = request(undefined, ["901", "later"]); api.loseConnect = true;
    await expect(publisher.publish(pending)).rejects.toThrow("Connect response lost");
    const newer = request(); const puts = api.puts();
    const failure = await publisher.publish(newer).catch(error => error as Error);
    if (!(failure instanceof Error)) throw new Error("New save unexpectedly reused an unfinished original receipt");
    expect(failure.message).toContain("existing block is not fully verified");
    expect(failure.message).toContain(first.blockUrl);
    expect(failure.message).toContain(`arena-block inspect ${first.id}`);
    expect(failure.message).toContain(`arena-block retry-save ${first.remoteProvenance!.saveId}`);
    expect(api.puts()).toBe(puts);
    await publisher.publish(pending); await publisher.publish(newer);
    expect(api.rows[0]!.connection.metadata.ab_latest_save_id).toBe(newer.operationId);
    store.close();
  });
  test("cancellation after an event PUT keeps its pending intent for readback recovery", async () => {
    const { api, store, directory } = await harness();
    const client = new ArenaClient("fixture", "https://arena.invalid/v3", api.fetch as typeof fetch);
    const publisher = new ArenaPublisher(client, store, { publicBaseUrl: "https://fixture.invalid", mediaDirectory: directory,
      render: async () => undefined, remoteProvenance: policy, verifyTimeoutMs: 100, pollIntervalMs: 1 });
    await publisher.publish(request()); const later = request(), controller = new AbortController();
    const fetcher = (async (input, init) => {
      const response = await api.fetch(input, init);
      if (init?.method === "PUT" && String(input).includes("/connections/") && String(init.body).includes("ab_latest_save_id"))
        controller.abort(new Error("Fixture cancellation after write"));
      return response;
    }) as typeof fetch;
    const cancellable = new ArenaPublisher(new ArenaClient("fixture", "https://arena.invalid/v3", fetcher), store,
      { publicBaseUrl: "https://fixture.invalid", mediaDirectory: directory, render: async () => undefined,
        remoteProvenance: policy, verifyTimeoutMs: 100, pollIntervalMs: 1 });
    await expect(cancellable.publish(later, controller.signal)).rejects.toThrow();
    expect(store.remoteSaveEvent(later.operationId!)?.state).toBe("pending");
    const puts = api.puts(); await publisher.publish(later);
    expect(api.puts()).toBe(puts); expect(store.remoteSaveEvent(later.operationId!)?.state).toBe("verified"); store.close();
  });
  test("two concurrent later saves serialize one block's Inbox event updates", async () => {
    const { api, publisher, store } = await harness(); await publisher.publish(request());
    const first = request(), second = request();
    await Promise.all([publisher.publish(first), publisher.publish(second)]);
    expect(api.creates()).toBe(1); expect(api.connects()).toBe(1);
    expect(store.remoteSaveEvent(first.operationId!)?.state).toBe("verified");
    expect(store.remoteSaveEvent(second.operationId!)?.state).toBe("verified");
    expect(api.rows[0]!.connection.metadata.ab_latest_save_id).toBe(second.operationId); store.close();
  });
  test("Inbox privacy or account changes reject a later event before metadata writes", async () => {
    for (const fault of ["visibility", "account"]) {
      const { api, publisher, store } = await harness(); await publisher.publish(request());
      const later = request(), puts = api.puts();
      if (fault === "visibility") api.visibility = "public"; else api.account = 48;
      await expect(publisher.publish(later)).rejects.toThrow();
      expect(api.puts()).toBe(puts); expect(store.remoteSaveEvent(later.operationId!)).toBeUndefined();
      store.close();
    }
  });
  test("lost event metadata response is recovered by readback with no duplicate PUT", async () => {
    const { api, publisher, store } = await harness(); await publisher.publish(request());
    const later = request(); api.loseUpdate = true;
    await expect(publisher.publish(later)).rejects.toThrow("Metadata response lost");
    expect(store.remoteSaveEvent(later.operationId!)?.state).toBe("pending");
    const puts = api.puts(); await publisher.publish(later);
    expect(api.puts()).toBe(puts); expect(store.remoteSaveEvent(later.operationId!)?.state).toBe("verified");
    expect(api.creates()).toBe(1); store.close();
  });
  test("unresolved event blocks a newer event and foreign metadata cannot be overwritten", async () => {
    const { api, publisher, store } = await harness(); await publisher.publish(request());
    const pending = request(); api.loseUpdate = true;
    await expect(publisher.publish(pending)).rejects.toThrow("Metadata response lost");
    const newer = request(); const puts = api.puts();
    await expect(publisher.publish(newer)).rejects.toThrow("prior Inbox metadata event is unresolved");
    expect(api.puts()).toBe(puts);
    await publisher.publish(pending);
    api.rows[0]!.connection.metadata.ab_latest_save_id = crypto.randomUUID();
    await expect(publisher.publish(newer)).rejects.toThrow("unknown or unresolved save");
    expect(api.puts()).toBe(puts); store.close();
  });
  test("a verified legacy block gains an explicitly labeled later event without inventing original provenance", async () => {
    const { api, publisher, store, directory } = await harness(false);
    const first = request();
    const receipt = await publisher.publish({ ...first, remoteSave: undefined });
    const protectedPublisher = new ArenaPublisher(new ArenaClient("fixture", "https://arena.invalid/v3", api.fetch as typeof fetch), store,
      { publicBaseUrl: "https://fixture.invalid", mediaDirectory: join(directory, "media"), render: async () => undefined,
        remoteProvenance: policy, verifyTimeoutMs: 100, pollIntervalMs: 1 });
    const later = request(); const next = await protectedPublisher.publish(later);
    expect(next.id).toBe(receipt.id); expect(api.creates()).toBe(1);
    expect(api.rows[0]!.connection.metadata).toMatchObject({ ab_latest_save_id: later.operationId,
      ab_latest_event_kind: "legacy_block", ab_latest_receipt_id: receipt.id });
    expect(api.rows[0]!.connection.metadata.ab_save_id).toBeUndefined();
    expect(store.remoteSaveEvent(later.operationId!)?.state).toBe("verified"); store.close();
  });
  test("lost creation response reconciles one matching inbox save before recovery, never repeats POST", async () => {
    const { api, publisher, store } = await harness(); const input = request(); api.loseCreate = true;
    await expect(publisher.publish(input)).rejects.toThrow("outcome is unknown");
    const next = await publisher.publish(input); expect(next.remoteProvenance?.state).toBe("verified"); expect(api.creates()).toBe(1); store.close();
  });
  test("lost creation with missing, ambiguous or truncated evidence remains unknown without another creation", async () => {
    for (const fault of ["missing", "ambiguous", "truncated"]) {
      const { api, publisher, store } = await harness(); const input = request(); api.loseCreate = true;
      await expect(publisher.publish(input)).rejects.toThrow("outcome is unknown");
      if (fault === "missing") api.rows = []; else if (fault === "ambiguous") api.add(10000, 901, api.rows[0]!.connection.metadata); else api.complete = false;
      await expect(publisher.publish(input)).rejects.toThrow("remains unknown"); expect(api.creates()).toBe(1); expect(api.connects()).toBe(0); store.close();
    }
  });
  test("journal interruption after a known create response recovers through the reserved save ID", async () => {
    const { api, publisher, store } = await harness(); const input = request(); const recordCreated = store.recordCreated.bind(store); let fail = true;
    store.recordCreated = (...args) => { if (fail) { fail = false; throw new Error("Fixture receipt I/O failure"); } return recordCreated(...args); };
    await expect(publisher.publish(input)).rejects.toThrow("I/O failure");
    const recovered = await publisher.publish(input); expect(recovered.remoteProvenance?.state).toBe("verified"); expect(api.creates()).toBe(1); store.close();
  });
  test("cancellation after a create reached the API preserves the intent for read-based recovery", async () => {
    const { api, publisher, store } = await harness(); const input = request(), controller = new AbortController(); api.cancelCreate = controller;
    await expect(publisher.publish(input, controller.signal)).rejects.toThrow("outcome is unknown"); api.cancelCreate = undefined;
    const recovered = await publisher.publish(input); expect(recovered.status).toBe("verified"); expect(api.creates()).toBe(1); store.close();
  });
  test("failed media processing keeps block and capsule; recovery uses the same block", async () => {
    const { api, publisher, store } = await harness(); const input = request(); api.failProcessing = true;
    await expect(publisher.publish(input)).rejects.toThrow("processing failed"); expect(api.rows[0]!.connection.metadata.ab_save_id).toBe(input.operationId);
    api.failProcessing = false; const receipt = await publisher.publish(input); expect(receipt.status).toBe("verified"); expect(api.creates()).toBe(1); store.close();
  });
  test("transient processing reads recover without repeating creation", async () => {
    const { api, publisher, store } = await harness(); api.transientRead = true;
    expect((await publisher.publish(request())).status).toBe("verified"); expect(api.creates()).toBe(1); store.close();
  });
  test("missing initial inbox is preserved as unknown and is never blindly connected", async () => {
    const { api, publisher, store } = await harness(); const input = request(); api.omitInbox = true;
    await expect(publisher.publish(input)).rejects.toThrow("no duplicate connect");
    await expect(publisher.publish(input)).rejects.toThrow("no duplicate connect");
    expect(api.creates()).toBe(1); expect(api.connects()).toBe(0); expect(store.operationState(input.operationId!)?.receipt?.status).toBe("verified"); store.close();
  });
  test("lost additional connect response reconciles its actual target; response ordering is unused", async () => {
    const { api, publisher, store } = await harness(); const receipt = await publisher.publish(request()); api.loseConnect = true;
    await expect(publisher.resume(receipt.id, ["901", "later"])).rejects.toThrow("Connect response lost");
    const recovered = await publisher.resume(receipt.id, ["901", "later"]);
    expect(recovered.destinations).toContain("later"); expect(recovered.connectionIds).toContain(702); expect(api.connects()).toBe(2); expect(api.rows[2]!.connection.metadata).toEqual({}); store.close();
  });
  test("lost connect plus absent evidence stops rather than repeating the placement", async () => {
    const { api, publisher, store } = await harness(); const receipt = await publisher.publish(request()); api.loseConnect = true;
    await expect(publisher.resume(receipt.id, ["later"])).rejects.toThrow(); api.rows = api.rows.filter(row => row.channel !== 903);
    await expect(publisher.resume(receipt.id, ["later"])).rejects.toThrow("previously attempted"); expect(api.connects()).toBe(2); store.close();
  });
  test("lost metadata update confirms the existing values before repeating PUT", async () => {
    const { api, publisher, store } = await harness(); const input = request(); api.loseUpdate = true;
    await expect(publisher.publish(input)).rejects.toThrow("Metadata response lost"); expect(api.puts()).toBe(1);
    const next = await publisher.publish(input); expect(next.remoteProvenance?.state).toBe("verified"); expect(api.puts()).toBe(1); expect(api.creates()).toBe(1); store.close();
  });
  test("resume refuses an account switch or another event on the mapped inbox connection", async () => {
    const { api, publisher, store } = await harness(); const receipt = await publisher.publish(request()); const puts = api.puts();
    api.account = 48; await expect(publisher.resume(receipt.id, ["later"])).rejects.toThrow("Authenticated"); expect(api.puts()).toBe(puts); api.account = 47;
    api.rows[0]!.connection.metadata.ab_save_id = crypto.randomUUID();
    await expect(publisher.resume(receipt.id, ["later"])).rejects.toThrow("original provenance"); expect(api.puts()).toBe(puts); expect(api.connects()).toBe(1); store.close();
  });
  test("an unknown connected_by actor cannot be promoted to authenticated provenance", async () => {
    const { api, publisher, store } = await harness(); const receipt = await publisher.publish(request()); api.rows[0]!.connection.connected_by = null;
    await expect(publisher.resume(receipt.id, ["901"])).rejects.toThrow("authenticated actor"); expect(api.creates()).toBe(1); store.close();
  });
  test("cross-process journal lease prevents overlapping remote writes", async () => {
    const { api, publisher, store } = await harness(); const input = request();
    expect(store.reserveRemoteSaveLease(input.operationId!, "fixture-owner")).toBe(true);
    await expect(publisher.publish(input)).rejects.toThrow("active in another publisher"); expect(api.calls).toHaveLength(0);
    store.releaseRemoteSaveLease(input.operationId!, "fixture-owner"); await publisher.publish(input); expect(api.creates()).toBe(1); store.close();
  });
  test("daemon policy defaults disabled and rejects unrecognized profile configuration", async () => {
    expect(loadServiceConfig({ HOME: "/tmp/fictional", ARENA_BLOCK_ACCESS_TOKEN: "fixture", ARENA_WRITE_ACCESS_TOKEN: "fixture" }).remoteProvenance).toBeUndefined();
    const { directory } = await harness(); const path = join(directory, "policy.json");
    await Bun.write(path, JSON.stringify({ ...policy, credentialProfile: "assistant" }));
    expect(() => loadServiceConfig({ ARENA_BLOCK_ACCESS_TOKEN: "fixture", ARENA_WRITE_ACCESS_TOKEN: "fixture", ARENA_BLOCK_PROVENANCE_POLICY: path })).toThrow();
  });
  test("authenticated service rejects remote publication when its server policy is disabled", async () => {
    const { directory, store } = await harness(); store.close();
    const service = createService({ host: "127.0.0.1", port: 0, publicBaseUrl: "https://fixture.invalid", stateDirectory: directory, mediaDirectory: join(directory, "media"), accessToken: "fixture", arenaToken: "fixture" });
    const response = await service.handler(new Request("https://fixture.invalid/v1/publications", { method: "POST", headers: { authorization: "Bearer fixture" }, body: JSON.stringify(request()) }));
    expect(response.status).toBe(422); expect((await response.json()).error).toContain("disabled"); service.close();
  });
  test("force with an omitted capsule cannot bypass identity verification on an unfinished original operation", async () => {
    const { api, publisher, store } = await harness(); const input = request(); api.failProcessing = true;
    await expect(publisher.publish(input)).rejects.toThrow("processing failed"); api.failProcessing = false; api.account = 48;
    const before = api.calls.filter(call => call.method === "PUT").length;
    await expect(publisher.publish({ ...input, force: true, remoteSave: undefined })).rejects.toThrow("Authenticated");
    expect(api.calls.filter(call => call.method === "PUT")).toHaveLength(before); expect(api.creates()).toBe(1); store.close();
  });
  test("concurrent snapshot or actor corruption in final readback cannot be marked verified", async () => {
    for (const fault of ["hash", "actor"]) {
      const { api, store, directory } = await harness();
      const wrapper = (async (input, init) => {
        const response = await api.fetch(input, init);
        if (init?.method === "PUT" && String(input).includes("/connections/")) {
          if (fault === "hash") api.rows[0]!.connection.metadata.ab_snapshot_sha256 = "a".repeat(64); else api.rows[0]!.connection.connected_by = { id: 48 };
        }
        return response;
      }) as typeof fetch;
      const publisher = new ArenaPublisher(new ArenaClient("fixture", "https://arena.invalid/v3", wrapper), store,
        { publicBaseUrl: "https://fixture.invalid", mediaDirectory: directory, render: async () => undefined, remoteProvenance: policy });
      const input = request(); await expect(publisher.publish(input)).rejects.toThrow();
      expect(store.operationState(input.operationId!)?.receipt?.remoteProvenance?.state).toBe("unknown"); store.close();
    }
  });
  test("owned SQLite database and sidecars are private and shared directories reject remote journaling", async () => {
    const { store, directory, api } = await harness();
    for (const name of ["state.sqlite", "state.sqlite-wal", "state.sqlite-shm"]) expect((await stat(join(directory, name))).mode & 0o077).toBe(0);
    await chmod(directory, 0o755);
    expect(() => new ArenaPublisher(new ArenaClient("fixture", "https://arena.invalid/v3", api.fetch as typeof fetch), store,
      { publicBaseUrl: "https://fixture.invalid", mediaDirectory: directory, remoteProvenance: policy })).toThrow("private state directory");
    expect((await stat(directory)).mode & 0o777).toBe(0o755); await chmod(directory, 0o700); store.close();
    await symlink(join(directory, "state.sqlite"), join(directory, "alias.sqlite"));
    expect(() => new ArenaBlockStore(join(directory, "alias.sqlite"))).toThrow("owned regular file");
  });
  test("qualification plan contains exactly two fictional bounded capsules and never targets the real Inbox", () => {
    const plan = qualificationPlan(); expect(plan.approvalStatus).toBe("pending"); expect(plan.executionPerformed).toBe(false);
    expect(plan.fixtures).toHaveLength(2); expect(plan.budgets).toMatchObject({ channelCreates: 1, blockCreates: 2, connectionCreates: 0 });
    expect(plan.fixtures[1]!.chunks.length).toBeGreaterThan(1);
    expect(plan.fixtures.every(fixture => fixture.chunks.every(chunk => chunk.bytes <= 1800))).toBe(true);
    expect(String(qualificationBoundaryPatch.ab_test_ascii).length).toBe(2000);
    expect(() => qualificationRequests(90001, 700)).toThrow("real Remote Inbox");
  });
  test("prepared qualification runner stays within its complete one-channel/two-block budget against a fake API", async () => {
    const { api, directory, store } = await harness(); store.close(); api.account = 700;
    const result = await runApprovedQualification({ approval: QUALIFICATION_APPROVAL, stateDirectory: join(directory, "qualification"), token: "fixture-not-live", fetcher: api.fetch as typeof fetch });
    expect(result.state.completed).toBe(true); expect(result.state.used).toMatchObject({ channelCreates: 1, blockCreates: 2, connectionCreates: 0, blockUpdates: 2, connectionMetadataUpdates: 4 });
    expect(result.state.used.reads).toBeLessThanOrEqual(120); expect(api.rows).toHaveLength(2); expect(api.rows[0]!.connection.metadata.ab_test_remove).toBeUndefined();
    expect(api.rows[0]!.connection.metadata.ab_test_keep).toBe("kept_changed");
    const before = api.calls.length;
    expect((await runApprovedQualification({ approval: QUALIFICATION_APPROVAL, stateDirectory: join(directory, "qualification"), token: "fixture-not-live", fetcher: api.fetch as typeof fetch })).execution).toBe("already_completed_no_requests");
    expect(api.calls).toHaveLength(before);
    const proof = await verifyCompletedQualification({ stateDirectory: join(directory, "qualification"), token: "fixture-not-live", fetcher: api.fetch as typeof fetch });
    expect(proof.reads).toBe(9); expect(proof.writes).toBe(0); expect(proof.fixtures).toHaveLength(2);
    expect(proof.channel.visibility).toBe("private"); expect(proof.fixtures.every(fixture => fixture.sourceTextVerified && fixture.snapshotVerified)).toBe(true);
  });
  test("qualification channel response loss consumes its only allowance and never repeats creation", async () => {
    const { api, directory, store } = await harness(); store.close(); api.account = 700;
    const wrapper = (async (input, init) => { if (init?.method === "POST" && String(input).endsWith("/channels")) { await api.fetch(input, init); throw new Error("Lost channel response fixture"); } return api.fetch(input, init); }) as typeof fetch;
    const options = { approval: QUALIFICATION_APPROVAL, stateDirectory: join(directory, "lost-channel"), token: "fixture-not-live", fetcher: wrapper };
    await expect(runApprovedQualification(options)).rejects.toThrow("Lost channel response");
    await expect(runApprovedQualification(options)).rejects.toThrow("already attempted");
    expect(api.calls.filter(call => call.path === "/channels" && call.method === "POST")).toHaveLength(1); expect(api.creates()).toBe(0);
  });
  test("qualification refuses a public state directory before any checkpoint or network request", async () => {
    const { api, directory, store } = await harness(); store.close(); await chmod(directory, 0o755);
    await expect(runApprovedQualification({ approval: QUALIFICATION_APPROVAL, stateDirectory: directory, token: "fixture-not-live", fetcher: api.fetch as typeof fetch })).rejects.toThrow("private state directory");
    expect(api.calls).toHaveLength(0); expect((await stat(directory)).mode & 0o777).toBe(0o755); await chmod(directory, 0o700);
  });
  test("qualification refuses a missing journal after a partial run without any additional request", async () => {
    const { api, directory, store } = await harness(); store.close(); api.account = 700;
    const wrapper = (async (input, init) => {
      const response = await api.fetch(input, init);
      if (init?.method === "PUT" && String(input).includes("/connections/") && String(init.body).includes("ab_test_ascii")) throw new Error("Boundary response lost fixture");
      return response;
    }) as typeof fetch;
    const stateDirectory = join(directory, "missing-journal"), options = { approval: QUALIFICATION_APPROVAL, stateDirectory, token: "fixture-not-live", fetcher: wrapper };
    await expect(runApprovedQualification(options)).rejects.toThrow("Boundary response lost");
    for (const suffix of ["", "-wal", "-shm"]) await rm(join(stateDirectory, `qualification.sqlite${suffix}`), { force: true });
    const before = api.calls.length;
    await expect(runApprovedQualification(options)).rejects.toThrow("ENOENT"); expect(api.calls).toHaveLength(before); expect(api.creates()).toBe(1);
  });
});
