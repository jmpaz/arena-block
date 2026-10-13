import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ArenaClient, ArenaPublisher } from "../src/arena.ts";
import { ArenaBlockStore } from "../src/store.ts";
import { SaveGateway, type SaveSubmission } from "../src/save-gateway.ts";
import { userConfigSchema, credentialProfile } from "../src/config.ts";
import { prepareSaveIntent, snapshotHash } from "../src/save-intent.ts";
import { composePlan, planHash } from "../src/compose.ts";
import { createMcpSession } from "../src/mcp.ts";
import { createService, loadServiceConfig } from "../src/service.ts";
import { boundedJson, abortable, deadline } from "../src/bounded-io.ts";
import { ArenaBlockClient } from "../src/client.ts";
import { MockApi } from "./fixtures/remote-api.ts";

const directories: string[] = [];
const stores: ArenaBlockStore[] = [];
const gateways: SaveGateway[] = [];
afterEach(async () => { await Promise.all(gateways.splice(0).map(gateway => gateway.close())); stores.splice(0).forEach(store => store.close()); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const config = userConfigSchema.parse({ remoteInbox: { channel: "901", mode: "always" }, provenance: { remoteSnapshot: "full" }, credentialProfiles: { shared: { arenaTokenEnv: "ARENA_WRITE_ACCESS_TOKEN", expectedAccountId: 47 }, assistant: { arenaTokenEnv: "ARENA_ASSISTANT_TOKEN", expectedAccountId: 48 } } });
const policy = { inboxChannel: "901", mode: "full" as const, credentialProfile: "shared", expectedAccountId: 47 };
const plan = composePlan([{ provider: "x", id: "1", canonicalUrl: "https://x.com/fictional_fixture/status/1", author: { handle: "fictional_fixture" }, text: "Private MCP fixture. No source fetch.", media: [] }], { media: "none" });
function submission(origin: "cli" | "mcp-local" = "cli", remote = true): SaveSubmission {
  const intent = prepareSaveIntent(plan, remote ? config : userConfigSchema.parse({}), { origin, initiator: { kind: origin === "cli" ? "human" : "agent" }, operation: "publish", destinations: ["901", "active"],
    ...(origin !== "cli" ? { client: { name: "fixture-client", version: "1", identityBasis: "declared" } } : {}) });
  return { plan, snapshot: intent.snapshot, snapshotSha256: intent.snapshotSha256, ...(remote ? { remoteMode: "full" } : {}) };
}
async function harness(remote = true, timeoutMs = 500) {
  const directory = await mkdtemp(join(tmpdir(), "arena-mcp-save-")); directories.push(directory);
  const store = new ArenaBlockStore(join(directory, "state.sqlite"), { private: true }); stores.push(store);
  const api = new MockApi(), client = new ArenaClient("fixture-never-live", "https://arena.invalid/v3", (...args) => api.fetch(...args), 100);
  const publisher = new ArenaPublisher(client, store, { publicBaseUrl: "https://fixture.invalid", mediaDirectory: join(directory, "media"), render: async () => undefined, verifyTimeoutMs: 100, pollIntervalMs: 1, ...(remote ? { remoteProvenance: policy } : {}) });
  const gateway = new SaveGateway(client, publisher, store, { profile: "shared", expectedAccountId: 47 }, remote ? policy : undefined, timeoutMs);
  gateways.push(gateway);
  return { directory, store, api, client, publisher, gateway };
}
function gate() { let arrived!: () => void, release!: () => void; const entered = new Promise<void>(resolve => { arrived = resolve; }); const wait = new Promise<void>(resolve => { release = resolve; }); return { entered, wait, arrived, release }; }
async function mcp(h: Awaited<ReturnType<typeof harness>>, timeoutMs?: number) {
  const dispatch = createMcpSession(config, "mcp-local", { backend: { save: (input, signal) => h.gateway.save(input, "mcp-local", signal), status: async id => h.gateway.status(id), cancel: async id => h.gateway.cancel(id) }, callTimeoutMs: timeoutMs });
  await dispatch({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "fixture-client", version: "1" } } });
  await dispatch({ jsonrpc: "2.0", method: "notifications/initialized" });
  return dispatch;
}
const call = (id: number, name: string, args: unknown) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

test("CLI and MCP create through the same durable publisher with distinct transport/client/initiator/account", async () => {
  for (const origin of ["cli", "mcp-local"] as const) {
    const h = await harness(), input = submission(origin);
    const result = await h.gateway.save(input, origin);
    expect(result.phase).toBe("saved"); expect(result.authentication).toEqual({ accountId: 47, credentialProfile: "shared", authenticatedAccountVerified: true });
    const context = h.store.saveContext(input.snapshot.saveId)!;
    expect(context.submission).toEqual(input); expect(context.submission.snapshot.authentication.authenticatedAccountVerified).toBe(false);
    expect(context.submission.snapshot.origin).toBe(origin); expect(context.submission.snapshot.initiator.kind).toBe(origin === "cli" ? "human" : "agent");
    expect(context.submission.snapshot.client?.name).toBe(origin === "cli" ? undefined : "fixture-client");
    expect(result.receipt!.destinations).toEqual(["901", "active"]); expect(h.api.creates()).toBe(1);
    expect((await h.gateway.save(input, origin)).receipt!.id).toBe(result.receipt!.id); expect(h.api.creates()).toBe(1);
    expect(h.gateway.cancel(input.snapshot.saveId)).toEqual(h.gateway.status(input.snapshot.saveId)); expect(h.gateway.status(input.snapshot.saveId).cancelRequested).toBe(false);
  }
});
test("later save metadata remains partial after a lost response and replays to saved without duplicate writes", async () => {
  const h = await harness();
  const first = submission(); expect((await h.gateway.save(first, "cli")).phase).toBe("saved");
  const later = submission(); h.api.loseUpdate = true;
  await expect(h.gateway.save(later, "cli")).rejects.toThrow("Metadata response lost");
  expect(h.gateway.status(later.snapshot.saveId)).toMatchObject({ phase: "partial", active: false });
  expect(h.store.remoteSaveEvent(later.snapshot.saveId)?.state).toBe("pending");
  const puts = h.api.puts();
  expect((await h.gateway.replay(later.snapshot.saveId)).phase).toBe("saved");
  expect(h.api.puts()).toBe(puts); expect(h.api.creates()).toBe(1);
  expect(h.store.remoteSaveEvent(later.snapshot.saveId)?.state).toBe("verified");
});
test("a lost creation response remains unknown and replay recovers the original block", async () => {
  const h = await harness(), input = submission("mcp-local"); h.api.loseCreate = true;
  await expect(h.gateway.save(input, "mcp-local")).rejects.toThrow("unknown");
  expect(h.gateway.status(input.snapshot.saveId)).toMatchObject({ phase: "unknown", active: false });
  const original = JSON.stringify(h.store.saveContext(input.snapshot.saveId)!.submission);
  const result = await h.gateway.replay(input.snapshot.saveId); expect(result.phase).toBe("saved"); expect(h.api.creates()).toBe(1);
  expect(JSON.stringify(h.store.saveContext(input.snapshot.saveId)!.submission)).toBe(original);
});
test("repeat publish reconciles an unknown create before making a later save event", async () => {
  const h = await harness(), first = submission(); h.api.loseCreate = true;
  await expect(h.gateway.save(first, "cli")).rejects.toThrow("unknown");
  expect(h.gateway.status(first.snapshot.saveId).phase).toBe("unknown");
  const second = submission();
  expect((await h.gateway.save(second, "cli")).phase).toBe("saved");
  expect(h.gateway.status(first.snapshot.saveId).phase).toBe("saved");
  expect(h.api.creates()).toBe(1); expect(h.api.connects()).toBe(1);
  expect(h.store.remoteSaveEvent(second.snapshot.saveId)?.state).toBe("verified");
});
test("orphaned uncertain creation fails closed before another remote preparation", async () => {
  const h = await harness(), input = submission();
  const attemptId = crypto.randomUUID();
  h.store.saveCreation({ id: attemptId, planHash: plan.hash, destinations: ["901", "active"],
    status: "creation_unknown", createdAt: new Date().toISOString() });
  await expect(h.gateway.save(input, "cli")).rejects.toThrow("no unique original save identity");
  expect(h.gateway.status(input.snapshot.saveId)).toMatchObject({ phase: "not_saved", failure: { code: "retained_recovery" } });
  expect(h.api.creates()).toBe(0);
  expect(h.store.remoteSave(input.snapshot.saveId)).toBeUndefined();
  expect(h.store.remoteSaveEvent(input.snapshot.saveId)).toBeUndefined();
});
test("same UUID with changed intent or actor cannot replay or replace source strings", async () => {
  const h = await harness(), input = submission(); await h.gateway.save(input, "cli");
  const changed = structuredClone(input); changed.snapshot.createdAt = "2026-10-04T00:00:00Z"; changed.snapshotSha256 = snapshotHash(changed.snapshot);
  await expect(h.gateway.save(changed, "cli")).rejects.toThrow("immutable intent");
  h.api.account = 48; await expect(h.gateway.save(input, "cli")).rejects.toThrow("selected profile"); expect(h.api.creates()).toBe(1);
  expect(h.gateway.status(input.snapshot.saveId).phase).toBe("partial");
});
test("an old verified receipt stays provisional while replay checks a changed account", async () => {
  const h = await harness(false);
  const intent = prepareSaveIntent(plan, userConfigSchema.parse({}), { origin: "cli", initiator: { kind: "human" }, operation: "publish", destinations: ["901"] });
  const input = { plan, snapshot: intent.snapshot, snapshotSha256: intent.snapshotSha256 };
  const first = await h.gateway.save(input, "cli"); expect(first.phase).toBe("saved");
  const pause = gate(), original = h.api.fetch;
  h.api.account = 48;
  h.api.fetch = async (...args) => { if (String(args[0]).endsWith("/me")) { pause.arrived(); await pause.wait; } return original(...args); };
  const pending = h.gateway.replay(input.snapshot.saveId);
  await pause.entered;
  const during = h.gateway.status(input.snapshot.saveId);
  expect(during.active).toBe(true);
  expect(during.phase).not.toBe("saved");
  expect(during.receipt?.id).toBe(first.receipt?.id);
  pause.release();
  await expect(pending).rejects.toThrow("selected profile");
  expect(h.gateway.status(input.snapshot.saveId).failure?.code).toBe("authorization");
  expect(h.api.creates()).toBe(1);
});
test("a reused receipt is not complete until the new destination is placed", async () => {
  const h = await harness(false);
  const prepare = (destinations: string[]) => {
    const intent = prepareSaveIntent(plan, userConfigSchema.parse({}), { origin: "cli", initiator: { kind: "human" }, operation: "publish", destinations });
    return { plan, snapshot: intent.snapshot, snapshotSha256: intent.snapshotSha256 };
  };
  const first = await h.gateway.save(prepare(["901"]), "cli");
  expect(first.phase).toBe("saved");
  const pause = gate(), original = h.api.fetch;
  h.api.fetch = async (...args) => {
    if (String(args[0]).endsWith(`/blocks/${first.receipt!.blockId}/connections`) && (!args[1]?.method || args[1]?.method === "GET")) {
      pause.arrived(); await pause.wait;
    }
    return original(...args);
  };
  const next = prepare(["901", "902"]), pending = h.gateway.save(next, "cli");
  await pause.entered;
  const during = h.gateway.status(next.snapshot.saveId);
  expect(during.active).toBe(true);
  expect(during.phase).not.toBe("saved");
  expect(during.receipt?.id).toBe(first.receipt?.id);
  pause.release();
  const completed = await pending;
  expect(completed.phase).toBe("saved");
  expect(completed.receipt?.destinations).toContain("902");
  expect(h.api.creates()).toBe(1);
});
test("cancellation before creation stops active work without a create or rollback", async () => {
  const h = await harness(), input = submission(), pause = gate(), original = h.api.fetch;
  h.api.fetch = async (...args) => { if (String(args[0]).endsWith("/channels/901")) { pause.arrived(); await pause.wait; } return original(...args); };
  const pending = h.gateway.save(input, "cli"); await pause.entered;
  expect(h.gateway.cancel(input.snapshot.saveId).cancelRequested).toBe(true);
  await expect(pending).rejects.toThrow("cancellation"); pause.release();
  expect(h.api.creates()).toBe(0); expect(h.api.calls.some(c => c.method === "DELETE")).toBe(false);
  expect(h.gateway.status(input.snapshot.saveId).phase).toBe("cancelled");
  expect((await h.gateway.save(input, "cli")).phase).toBe("saved"); expect(h.api.creates()).toBe(1);
});
test("cancellation while account verification is pending is reachable and performs no writes", async () => {
  const h = await harness(), input = submission(), pause = gate(), original = h.api.fetch;
  h.api.fetch = async (...args) => { if (String(args[0]).endsWith("/me")) { pause.arrived(); await pause.wait; } return original(...args); };
  const pending = h.gateway.save(input, "cli"); await pause.entered;
  expect(h.gateway.cancel(input.snapshot.saveId)).toMatchObject({ cancelRequested: true, authentication: { authenticatedAccountVerified: false } });
  await expect(pending).rejects.toThrow("cancellation"); pause.release(); expect(h.api.creates()).toBe(0);
  expect(h.gateway.status(input.snapshot.saveId)).toMatchObject({ phase: "cancelled", active: false, authentication: { authenticatedAccountVerified: false } });
});
test("cancellation arriving before save submission remains durable and prevents its first create", async () => {
  const h = await harness(), input = submission();
  expect(h.gateway.cancel(input.snapshot.saveId)).toMatchObject({ phase: "cancelled", active: false, authentication: { authenticatedAccountVerified: false } });
  const first = await h.gateway.save(input, "cli"); expect(first.phase).toBe("cancelled"); expect(h.api.calls).toHaveLength(0);
  expect((await h.gateway.save(input, "cli")).phase).toBe("saved"); expect(h.api.creates()).toBe(1);
});
test("cancel after a committed create retains unknown attempt then recovers without duplicate POST", async () => {
  const h = await harness(), input = submission(), pause = gate(), original = h.api.fetch;
  h.api.fetch = async (...args) => { const result = await original(...args); if (String(args[0]).endsWith("/blocks") && args[1]?.method === "POST") { pause.arrived(); await pause.wait; } return result; };
  const pending = h.gateway.save(input, "cli"); await pause.entered; h.gateway.cancel(input.snapshot.saveId);
  await expect(pending).rejects.toThrow(); pause.release(); expect(h.api.blocks.size).toBe(1); expect(h.gateway.status(input.snapshot.saveId).phase).toBe("unknown");
  expect((await h.gateway.save(input, "cli")).phase).toBe("saved"); expect(h.api.creates()).toBe(1); expect(h.api.connects()).toBe(1);
  expect(h.api.rows.map(row => row.channel)).toEqual([901, 902]);
});
test("cancel after a verified create but before an extra placement retains Inbox and stops future connects", async () => {
  const h = await harness(), input = submission(), pause = gate(), original = h.api.fetch;
  h.api.fetch = async (...args) => {
    if (String(args[0]).includes("/blocks/10000/connections") && (!args[1]?.method || args[1]?.method === "GET")) {
      pause.arrived(); await pause.wait;
    }
    return original(...args);
  };
  const pending = h.gateway.save(input, "cli"); await pause.entered;
  expect(h.api.creates()).toBe(1);
  expect(h.api.rows.map(row => row.channel)).toEqual([901]);
  h.gateway.cancel(input.snapshot.saveId);
  await expect(pending).rejects.toThrow(); pause.release();
  expect(h.api.connects()).toBe(0);
  expect(h.api.rows.map(row => row.channel)).toEqual([901]);
  expect(h.gateway.status(input.snapshot.saveId).cancelRequested).toBe(true);
});
test("a later changed-media command is a distinct intent after cancellation, without resuming the old block", async () => {
  const h = await harness(), first = submission(), pause = gate(), original = h.api.fetch;
  h.api.fetch = async (...args) => {
    if (String(args[0]).includes("/blocks/10000/connections")) { pause.arrived(); await pause.wait; }
    return original(...args);
  };
  const pending = h.gateway.save(first, "cli"); await pause.entered;
  h.gateway.cancel(first.snapshot.saveId);
  await expect(pending).rejects.toThrow(); pause.release();
  const firstBlock = h.gateway.status(first.snapshot.saveId).receipt!.blockId;
  expect(h.api.rows.filter(row => row.block === firstBlock).map(row => row.channel)).toEqual([901]);
  h.api.fetch = original;
  const changedPlan = composePlan([{ ...plan.sources[0]!, media: [{ ref: "1.1", kind: "image", url: "https://example.invalid/alternate-image.jpg", width: 800, height: 600, alt: "" }] }], { media: "none" });
  const intent = prepareSaveIntent(changedPlan, config, { origin: "cli", initiator: { kind: "human" }, operation: "publish", destinations: ["901", "active"] });
  const changed = { plan: changedPlan, snapshot: intent.snapshot, snapshotSha256: intent.snapshotSha256, remoteMode: "full" as const };
  expect(changed.plan.hash).not.toBe(first.plan.hash);
  expect(changed.snapshot.saveId).not.toBe(first.snapshot.saveId);
  const second = await h.gateway.save(changed, "cli");
  expect(second.phase).toBe("saved"); expect(second.receipt!.blockId).not.toBe(firstBlock);
  expect(h.api.creates()).toBe(2);
  expect(h.api.rows.filter(row => row.block === firstBlock).map(row => row.channel)).toEqual([901]);
  expect(h.gateway.status(first.snapshot.saveId).cancelRequested).toBe(true);
});
test("finite daemon deadline interrupts a slow authorization read while durable status remains recoverable", async () => {
  const h = await harness(true, 25), input = submission(), pause = gate(), original = h.api.fetch;
  h.api.fetch = async (...args) => { if (String(args[0]).endsWith("/channels/901")) { pause.arrived(); await pause.wait; } return original(...args); };
  const pending = h.gateway.save(input, "cli"); await pause.entered; await expect(pending).rejects.toThrow(); pause.release();
  await Promise.resolve(); expect(h.api.creates()).toBe(0); expect(h.gateway.status(input.snapshot.saveId).phase).toBe("unknown");
});
test("failed processing and partial connections retain exact capsule and a recoverable receipt", async () => {
  const h = await harness(), input = submission(); h.api.failProcessing = true;
  await expect(h.gateway.save(input, "cli")).rejects.toThrow("processing failed");
  expect(h.gateway.status(input.snapshot.saveId)).toMatchObject({ phase: "partial", receipt: { blockId: 10000 } });
  h.api.failProcessing = false; expect((await h.gateway.save(input, "cli")).phase).toBe("saved"); expect(h.api.creates()).toBe(1);
});
test("repeat publish recovers the retained original and completes its later event without another create", async () => {
  const h = await harness(), first = submission(); h.api.failProcessing = true;
  await expect(h.gateway.save(first, "cli")).rejects.toThrow("processing failed");
  const original = h.gateway.status(first.snapshot.saveId).receipt!;
  h.api.blocks.get(original.blockId)!.content.html = "<p>Private MCP fixture. No source fetch.</p>";
  const second = submission();
  await expect(h.gateway.save(second, "cli")).rejects.toThrow(`arena-block retry-save ${first.snapshot.saveId}`);
  const blocked = h.gateway.status(second.snapshot.saveId);
  expect(blocked).toMatchObject({ phase: "not_saved", active: false,
    failure: { code: "retained_recovery" } });
  expect(blocked.failure?.message).toContain(`arena-block inspect ${original.id}`);
  expect(blocked.failure?.message).toContain("Repeating publish will not create a replacement");
  expect(blocked.failure?.message).toContain(`retained block ${original.blockId}`);
  expect(blocked.failure?.message).toContain("Markdown and rendered HTML, but processing is not verified");
  expect(blocked.failure?.message).toContain("check channel placements separately");
  expect(blocked.receipt).toBeUndefined();
  expect(h.api.creates()).toBe(1);
  expect(h.api.calls.filter(call => call.method === "PUT" && call.path === `/blocks/${original.blockId}`)).toHaveLength(0);
  expect(h.store.remoteSaveEvent(second.snapshot.saveId)).toBeUndefined();
  h.api.failProcessing = false;
  expect((await h.gateway.replay(second.snapshot.saveId)).phase).toBe("saved");
  expect(h.gateway.status(first.snapshot.saveId)).toMatchObject({ phase: "saved", receipt: { id: original.id } });
  expect(h.store.remoteSaveEvent(second.snapshot.saveId)?.state).toBe("verified");
  expect(h.api.creates()).toBe(1);
  expect(h.api.rows.map(row => row.channel)).toEqual([901, 902]);
});
test("repeat publish waits for the original owner lease to stop before recovery", async () => {
  const h = await harness(), first = submission(); h.api.failProcessing = true;
  await expect(h.gateway.save(first, "cli")).rejects.toThrow("processing failed");
  const original = h.gateway.status(first.snapshot.saveId).receipt!;
  const second = submission(); h.api.failProcessing = false;
  expect(h.store.reserveRemoteSaveLease(first.snapshot.saveId, "other-owner")).toBe(true);
  await expect(h.gateway.save(second, "cli")).rejects.toThrow("active in another publisher");
  expect(h.api.creates()).toBe(1); expect(h.api.connects()).toBe(0);
  expect(h.store.remoteSaveEvent(second.snapshot.saveId)).toBeUndefined();
  h.store.releaseRemoteSaveLease(first.snapshot.saveId, "other-owner");
  expect((await h.gateway.replay(second.snapshot.saveId)).phase).toBe("saved");
  expect(h.gateway.status(first.snapshot.saveId).receipt?.id).toBe(original.id);
  expect(h.api.creates()).toBe(1); expect(h.api.connects()).toBe(1);
});
test("repeat publish preserves edits to an unfinished block", async () => {
  const h = await harness(), first = submission(); h.api.failProcessing = true;
  await expect(h.gateway.save(first, "cli")).rejects.toThrow("processing failed");
  const original = h.gateway.status(first.snapshot.saveId).receipt!;
  h.api.failProcessing = false;
  h.api.blocks.get(original.blockId)!.content = { markdown: "An owner edit made while recovery was pending" };
  const second = submission();
  await expect(h.gateway.save(second, "cli")).rejects.toThrow("preserve user edits");
  expect(h.api.blocks.get(original.blockId)!.content.markdown).toBe("An owner edit made while recovery was pending");
  expect(h.api.calls.filter(call => call.method === "PUT" && call.path === `/blocks/${original.blockId}`)).toHaveLength(0);
  expect(h.api.creates()).toBe(1); expect(h.api.connects()).toBe(0);
});

test("legacy receipts recover matching final fields without another content update", async () => {
  const h = await harness(), first = submission(); h.api.failProcessing = true;
  await expect(h.gateway.save(first, "cli")).rejects.toThrow("processing failed");
  const receipt = h.gateway.status(first.snapshot.saveId).receipt!;
  h.store.updateReceipt(receipt.id, current => ({ ...current, initialFields: undefined }));
  const block = h.api.blocks.get(receipt.blockId)!;
  block.content = { markdown: plan.block.markdown }; block.description = null;
  h.api.failProcessing = false;
  expect((await h.gateway.save(first, "cli")).phase).toBe("saved");
  expect(h.api.calls.filter(call => call.method === "PUT" && call.path === `/blocks/${receipt.blockId}`)).toHaveLength(0);
  expect(h.api.creates()).toBe(1);
});

test("a lost content-update response verifies final fields and never repeats an uncertain PUT", async () => {
  for (const restoreInitial of [false, true]) {
    const h = await harness(), first = submission(), fetch = h.api.fetch;
    let lose = true;
    h.api.fetch = async (...args) => {
      const response = await fetch(...args);
      if (lose && args[1]?.method === "PUT" && new URL(String(args[0])).pathname.includes("/blocks/")) {
        lose = false; throw new Error("Fixture lost update response");
      }
      return response;
    };
    await expect(h.gateway.save(first, "cli")).rejects.toThrow();
    const receipt = h.gateway.status(first.snapshot.saveId).receipt!;
    expect(h.store.receipt(receipt.id)?.initialFields?.status).toBe("attempted");
    if (restoreInitial) {
      const initial = h.store.receipt(receipt.id)!.initialFields!;
      const block = h.api.blocks.get(receipt.blockId)!;
      block.content = { markdown: initial.content }; block.description = { markdown: initial.description };
      await expect(h.gateway.save(first, "cli")).rejects.toThrow("preserve user edits");
      expect(block.content.markdown).toBe(initial.content);
    } else {
      expect((await h.gateway.save(first, "cli")).phase).toBe("saved");
      expect(h.api.blocks.get(receipt.blockId)!.content.markdown).toBe(plan.block.markdown);
    }
    expect(h.api.calls.filter(call => call.method === "PUT" && call.path === `/blocks/${receipt.blockId}`)).toHaveLength(1);
    expect(h.api.creates()).toBe(1);
  }
});
test("repeat publish recovers a retained Link cover and description without a second create", async () => {
  const h = await harness();
  const link = composePlan([{ ...plan.sources[0]!, media: [{ ref: "1.1", kind: "image", url: "https://example.invalid/source.jpg", width: 800, height: 600, alt: "" }] }], { media: "all" });
  expect(link.block.kind).toBe("link");
  const makeInput = () => {
    const intent = prepareSaveIntent(link, config, { origin: "cli", initiator: { kind: "human" }, operation: "publish", destinations: ["901", "active"] });
    return { plan: link, snapshot: intent.snapshot, snapshotSha256: intent.snapshotSha256, remoteMode: "full" as const };
  };
  const originalFetch = h.api.fetch;
  h.api.fetch = async (...args) => {
    const response = await originalFetch(...args);
    if (String(args[0]).endsWith("/blocks") && args[1]?.method === "POST") {
      const block = h.api.blocks.get(10000)!;
      block.type = "Link"; block.content = null;
      block.source = { url: link.block.canonicalSource };
      block.image = { src: "https://fixture.invalid/copied-cover.jpg", width: 800, height: 600 };
    }
    return response;
  };
  const publisher = new ArenaPublisher(h.client, h.store, { publicBaseUrl: "https://fixture.invalid", mediaDirectory: join(h.directory, "media"),
    render: async () => ({ hash: "a".repeat(64), path: join(h.directory, "rendered.jpg"), extension: "jpg", mimeType: "image/jpeg", size: 100 }),
    remoteProvenance: policy, verifyTimeoutMs: 100, pollIntervalMs: 1 });
  const gateway = new SaveGateway(h.client, publisher, h.store, { profile: "shared", expectedAccountId: 47 }, policy, 500);
  gateways.push(gateway);
  const first = makeInput(); h.api.failProcessing = true;
  await expect(gateway.save(first, "cli")).rejects.toThrow("processing failed");
  const receiptId = gateway.status(first.snapshot.saveId).receipt!.id;
  const cover = structuredClone(h.api.blocks.get(10000)!.image);
  h.api.failProcessing = false;
  const second = makeInput();
  expect((await gateway.save(second, "cli")).phase).toBe("saved");
  expect(gateway.status(first.snapshot.saveId).receipt?.id).toBe(receiptId);
  expect(h.api.creates()).toBe(1); expect(h.api.connects()).toBe(1);
  expect(h.api.calls.filter(call => call.method === "PUT" && call.path === "/blocks/10000")).toHaveLength(1);
  expect(h.api.blocks.get(10000)!.image).toEqual(cover);
  expect(h.api.blocks.get(10000)!.description.markdown).toBe(link.block.markdown);
  expect(h.api.rows.map(row => row.channel)).toEqual([901, 902]);
});
test("retry preserves a Text block's separate description, including a human-cleared null", async () => {
  for (const changed of ["Owner note", null]) {
    const h = await harness();
    const described = composePlan([{ ...plan.sources[0]! }], { media: "none" });
    described.block.description = "Posted at: 2024-01-01T00:00:00.000Z";
    const { hash: _, ...snapshot } = described;
    described.hash = planHash(snapshot);
    const input = () => {
      const intent = prepareSaveIntent(described, config, { origin: "cli", initiator: { kind: "human" }, operation: "publish", destinations: ["901", "active"] });
      return { plan: described, snapshot: intent.snapshot, snapshotSha256: intent.snapshotSha256, remoteMode: "full" as const };
    };
    const first = input(); h.api.failProcessing = true;
    await expect(h.gateway.save(first, "cli")).rejects.toThrow("processing failed");
    const original = h.gateway.status(first.snapshot.saveId).receipt!;
    h.api.failProcessing = false;
    h.api.blocks.get(original.blockId)!.description = changed === null ? null : { markdown: changed };
    await expect(h.gateway.save(input(), "cli")).rejects.toThrow("preserve user edits");
    expect(h.api.blocks.get(original.blockId)!.description).toEqual(changed === null ? null : { markdown: changed });
    expect(h.api.calls.filter(call => call.method === "PUT" && call.path === `/blocks/${original.blockId}`)).toHaveLength(0);
    expect(h.api.creates()).toBe(1);
  }
});
test("an owner-edited, missing or empty retained Link description stops before PUT", async () => {
  for (const value of ["Owner-edited description", "", null]) {
    const h = await harness();
    const link = composePlan([{ ...plan.sources[0]!, media: [{ ref: "1.1", kind: "image", url: "https://example.invalid/source.jpg", alt: "" }] }], { media: "all" });
    const intent = prepareSaveIntent(link, config, { origin: "cli", initiator: { kind: "human" }, operation: "publish", destinations: ["901", "active"] });
    const first = { plan: link, snapshot: intent.snapshot, snapshotSha256: intent.snapshotSha256, remoteMode: "full" as const };
    const originalFetch = h.api.fetch;
    h.api.fetch = async (...args) => {
      const response = await originalFetch(...args);
      if (String(args[0]).endsWith("/blocks") && args[1]?.method === "POST") {
        const block = h.api.blocks.get(10000)!; block.type = "Link"; block.content = null;
        block.source = { url: link.block.canonicalSource };
        block.image = { src: "https://fixture.invalid/copied-cover.jpg", width: 800, height: 600 };
      }
      return response;
    };
    const publisher = new ArenaPublisher(h.client, h.store, { publicBaseUrl: "https://fixture.invalid", mediaDirectory: join(h.directory, "media"),
      render: async () => ({ hash: "b".repeat(64), path: join(h.directory, "rendered.jpg"), extension: "jpg", mimeType: "image/jpeg", size: 100 }),
      remoteProvenance: policy, verifyTimeoutMs: 100, pollIntervalMs: 1 });
    const gateway = new SaveGateway(h.client, publisher, h.store, { profile: "shared", expectedAccountId: 47 }, policy, 500);
    gateways.push(gateway); h.api.failProcessing = true;
    await expect(gateway.save(first, "cli")).rejects.toThrow("processing failed");
    h.api.failProcessing = false; h.api.blocks.get(10000)!.description = value === null ? null : { markdown: value };
    const secondIntent = prepareSaveIntent(link, config, { origin: "cli", initiator: { kind: "human" }, operation: "publish", destinations: ["901", "active"] });
    await expect(gateway.save({ plan: link, snapshot: secondIntent.snapshot, snapshotSha256: secondIntent.snapshotSha256, remoteMode: "full" }, "cli"))
      .rejects.toThrow(value ? "preserve user edits" : "body is missing or empty");
    expect(h.api.blocks.get(10000)!.description).toEqual(value === null ? null : { markdown: value });
    expect(h.api.calls.filter(call => call.method === "PUT" && call.path === "/blocks/10000")).toHaveLength(0);
    expect(h.api.creates()).toBe(1); expect(h.api.connects()).toBe(0);
  }
});
test("a changed Link source stops recovery before update or on final readback", async () => {
  for (const timing of ["before", "after"]) {
    const h = await harness();
    const link = composePlan([{ ...plan.sources[0]!, media: [{ ref: "1.1", kind: "image", url: "https://example.invalid/source.jpg", alt: "" }] }], { media: "all" });
    const input = () => {
      const intent = prepareSaveIntent(link, config, { origin: "cli", initiator: { kind: "human" }, operation: "publish", destinations: ["901", "active"] });
      return { plan: link, snapshot: intent.snapshot, snapshotSha256: intent.snapshotSha256, remoteMode: "full" as const };
    };
    const originalFetch = h.api.fetch;
    let recovering = false, recoveryReads = 0;
    h.api.fetch = async (...args) => {
      const result = await originalFetch(...args);
      const block = h.api.blocks.get(10000);
      if (block && String(args[0]).endsWith("/blocks") && args[1]?.method === "POST") {
        block.type = "Link"; block.content = null; block.source = { url: link.block.canonicalSource };
        block.image = { src: "https://fixture.invalid/copied-cover.jpg", width: 800, height: 600 };
      }
      if (timing === "after" && recovering && block && String(args[0]).endsWith("/blocks/10000") && (!args[1]?.method || args[1]?.method === "GET") && ++recoveryReads === 2)
        block.source = { url: "https://example.invalid/owner-changed-source" };
      return result;
    };
    const publisher = new ArenaPublisher(h.client, h.store, { publicBaseUrl: "https://fixture.invalid", mediaDirectory: join(h.directory, "media"),
      render: async () => ({ hash: "c".repeat(64), path: join(h.directory, "rendered.jpg"), extension: "jpg", mimeType: "image/jpeg", size: 100 }),
      remoteProvenance: policy, verifyTimeoutMs: 100, pollIntervalMs: 1 });
    const gateway = new SaveGateway(h.client, publisher, h.store, { profile: "shared", expectedAccountId: 47 }, policy, 500);
    gateways.push(gateway); h.api.failProcessing = true;
    await expect(gateway.save(input(), "cli")).rejects.toThrow("processing failed");
    h.api.failProcessing = false;
    recovering = true;
    if (timing === "before") h.api.blocks.get(10000)!.source = { url: "https://example.invalid/owner-changed-source" };
    await expect(gateway.save(input(), "cli")).rejects.toThrow(timing === "before" ? "source changed since creation" : "Link source does not match");
    expect(h.api.creates()).toBe(1); expect(h.api.connects()).toBe(0);
    expect(h.api.calls.filter(call => call.method === "PUT" && call.path === "/blocks/10000")).toHaveLength(timing === "before" ? 0 : 1);
  }
});
test("receipt recovery clears the live cancellation indicator while preserving its private audit", async () => {
  const h = await harness(), input = submission(); h.api.failProcessing = true;
  await expect(h.gateway.save(input, "cli")).rejects.toThrow("processing failed");
  const id = input.snapshot.saveId, receipt = h.gateway.status(id).receipt!;
  expect(h.gateway.cancel(id)).toMatchObject({ phase: "partial", cancelRequested: true });
  h.api.failProcessing = false;
  await h.publisher.resume(receipt.id, []);
  expect(h.gateway.status(id)).toMatchObject({ phase: "saved", active: false, cancelRequested: false });
  expect(h.store.saveContext(id)?.cancelRequested).toBe(true);
  expect(h.api.creates()).toBe(1);
});
test("direct receipt recovery clears a stale live deadline failure once fully verified", async () => {
  const h = await harness(), input = submission(); h.api.failProcessing = true;
  await expect(h.gateway.save(input, "cli")).rejects.toThrow("processing failed");
  const id = input.snapshot.saveId, receipt = h.gateway.status(id).receipt!;
  const context = h.store.saveContext(id)!;
  h.store.updateSaveContext(id, { ...context, failure: { code: "deadline", message: "Previous attempt timed out" } });
  h.api.failProcessing = false;
  await h.publisher.resume(receipt.id, []);
  const status = h.gateway.status(id);
  expect(status).toMatchObject({ phase: "saved", active: false, cancelRequested: false });
  expect(status.failure).toBeUndefined();
  expect(h.store.saveContext(id)?.failure?.code).toBe("deadline");
  expect(h.api.creates()).toBe(1);
});
test("snapshot-none still journals verified account and unknown response without activating Remote Inbox metadata", async () => {
  const h = await harness(false), input = submission("cli", false); h.api.loseCreate = true;
  await expect(h.gateway.save(input, "cli")).rejects.toThrow("unknown");
  await expect(h.gateway.save(input, "cli")).rejects.toThrow("unresolved"); expect(h.api.creates()).toBe(1);
  expect(h.api.rows.every(row => Object.keys(row.connection.metadata).length === 0)).toBe(true); expect(h.store.remoteSave(input.snapshot.saveId)).toBeUndefined();
});
test("active duplicate UUID gets status; changed parallel intent and cross-profile journal reuse reject", async () => {
  const h = await harness(), input = submission(), pause = gate(), original = h.api.fetch;
  h.api.fetch = async (...args) => { if (String(args[0]).endsWith("/me")) { pause.arrived(); await pause.wait; } return original(...args); };
  const pending = h.gateway.save(input, "cli"); await pause.entered;
  expect((await h.gateway.save(input, "cli")).phase).toBe("running");
  const changed = structuredClone(input); changed.snapshot.createdAt = "2026-10-04T00:00:00Z"; changed.snapshotSha256 = snapshotHash(changed.snapshot);
  await expect(h.gateway.save(changed, "cli")).rejects.toThrow("immutable intent"); pause.release(); await pending;
  expect(() => h.store.bindSaveAccount("assistant", 48)).toThrow("another account/profile"); expect(h.api.creates()).toBe(1);
});
test("MCP preview/save/status/cancel parity and concurrent cancellation notification", async () => {
  const h = await harness(), dispatch = await mcp(h);
  const listed = await dispatch({ jsonrpc: "2.0", id: 2, method: "tools/list" }); expect((listed!.result as any).tools).toHaveLength(5);
  const preview = await dispatch(call(3, "arena_block_preview_save", { plan, destinations: ["active"], agent: { label: "declared agent" } }));
  const intent = (preview!.result as any).structuredContent;
  expect(intent.snapshot.invocation.operation).toBe("publish"); expect(intent.snapshot.client).toEqual({ name: "fixture-client", version: "1", identityBasis: "declared" });
  const args = { intent: { snapshot: intent.snapshot, snapshotSha256: intent.snapshotSha256 } };
  const saved = await dispatch(call(4, "arena_block_save", args)); expect((saved!.result as any).structuredContent.phase).toBe("saved");
  const status = await dispatch(call(5, "arena_block_save_status", { saveId: intent.snapshot.saveId })); expect((status!.result as any).structuredContent.receipt.id).toBe((saved!.result as any).structuredContent.receipt.id);
  const cancelled = await dispatch(call(6, "arena_block_cancel_save", { saveId: intent.snapshot.saveId })); expect((cancelled!.result as any).structuredContent.phase).toBe("saved"); expect(h.api.creates()).toBe(1);
  const h2 = await harness(), dispatch2 = await mcp(h2), pause = gate(), original = h2.api.fetch, input = submission("mcp-local");
  h2.api.fetch = async (...items) => { if (String(items[0]).endsWith("/channels/901")) { pause.arrived(); await pause.wait; } return original(...items); };
  const active = dispatch2(call(7, "arena_block_save", { intent: { snapshot: input.snapshot, snapshotSha256: input.snapshotSha256 } })); await pause.entered;
  expect(await dispatch2({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7 } })).toBeUndefined();
  expect(await active).toBeUndefined(); pause.release(); expect(h2.api.creates()).toBe(0);
});
test("MCP finite call timeout does not retry and strict arguments cannot override trusted identity", async () => {
  const h = await harness(), dispatch = await mcp(h, 25), input = submission("mcp-local"), pause = gate(), original = h.api.fetch;
  h.api.fetch = async (...args) => { if (String(args[0]).endsWith("/channels/901")) { pause.arrived(); await pause.wait; } return original(...args); };
  const pending = dispatch(call(2, "arena_block_save", { intent: { snapshot: input.snapshot, snapshotSha256: input.snapshotSha256 } })); await pause.entered;
  const failed = await pending; pause.release(); expect((failed!.result as any).isError).toBe(true); expect(h.api.creates()).toBe(0);
  expect((failed!.result as any).structuredContent.saveId).toBe(input.snapshot.saveId);
  const denied = await dispatch(call(3, "arena_block_save", { intent: { snapshot: input.snapshot, snapshotSha256: input.snapshotSha256 }, origin: "cli", token: "private-value" }));
  expect((denied!.result as any).isError).toBe(true); expect(JSON.stringify(denied)).not.toContain("private-value");
});
test("bounded bodies and hung cancellation/fetch settle within a finite deadline", async () => {
  await expect(boundedJson(Response.json({ text: "x".repeat(200) }), 100, deadline(25))).rejects.toThrow("exceeds");
  const stuck = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}), cancel: () => new Promise(() => {}) });
  await expect(boundedJson({ body: stuck }, 100, deadline(25))).rejects.toThrow();
  await expect(abortable(new Promise(() => {}), deadline(25))).rejects.toThrow();
  const client = new ArenaClient("fixture-never-live", "https://arena.invalid/v3", async () => new Promise(() => {}), 25);
  await expect(client.me()).rejects.toThrow();
});
test("explicit credential configuration resolves only its named existing env and rejects missing/mismatched profile", async () => {
  const h = await harness(), path = join(h.directory, "credential.json");
  await writeFile(path, JSON.stringify({ schemaVersion: 1, profile: "assistant", arenaTokenEnv: "ARENA_ASSISTANT_TOKEN", expectedAccountId: 48 }));
  const env = { ARENA_BLOCK_ACCESS_TOKEN: "owner-fixture", ARENA_WRITE_ACCESS_TOKEN: "shared-fixture", ARENA_BLOCK_CREDENTIAL_CONFIG: path };
  expect(() => loadServiceConfig(env)).toThrow("no fallback");
  const loaded = loadServiceConfig({ ...env, ARENA_ASSISTANT_TOKEN: "assistant-fixture" }); expect(loaded.arenaToken).toBe("assistant-fixture"); expect(loaded.credential?.expectedAccountId).toBe(48);
  expect(() => credentialProfile(config, "cli", "missing")).toThrow("no fallback");
  const remotePath = join(h.directory, "remote.json"); await writeFile(remotePath, JSON.stringify(policy));
  expect(() => loadServiceConfig({ ...env, ARENA_ASSISTANT_TOKEN: "assistant-fixture", ARENA_BLOCK_PROVENANCE_POLICY: remotePath })).toThrow("disagree");
});
test("a matching fictional named profile saves through MCP in separate account state", async () => {
  const h = await harness(false); h.api.account = 48;
  const selectedConfig = userConfigSchema.parse({ remoteInbox: { channel: "901", mode: "always" }, provenance: { remoteSnapshot: "full" }, credentialProfiles: { assistant: { arenaTokenEnv: "ARENA_EXISTING_FIXTURE_TOKEN", expectedAccountId: 48 } }, clients: { cli: "assistant", mcpLocal: "assistant", mcpRemote: "assistant" } });
  const selectedPolicy = { ...policy, credentialProfile: "assistant", expectedAccountId: 48 };
  const publisher = new ArenaPublisher(h.client, h.store, { publicBaseUrl: "https://fixture.invalid", mediaDirectory: join(h.directory, "media"), render: async () => undefined, verifyTimeoutMs: 100, pollIntervalMs: 1, remoteProvenance: selectedPolicy });
  const gateway = new SaveGateway(h.client, publisher, h.store, { profile: "assistant", expectedAccountId: 48 }, selectedPolicy); gateways.push(gateway);
  const dispatch = createMcpSession(selectedConfig, "mcp-local", { backend: { save: (input, signal) => gateway.save(input, "mcp-local", signal), status: async id => gateway.status(id), cancel: async id => gateway.cancel(id) } });
  await dispatch({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "fixture-client", version: "1" } } }); await dispatch({ jsonrpc: "2.0", method: "notifications/initialized" });
  const preview = (await dispatch(call(2, "arena_block_preview_save", { plan, agent: { label: "declared fixture agent" } })))!.result as any, intent = preview.structuredContent;
  const saved = (await dispatch(call(3, "arena_block_save", { intent: { snapshot: intent.snapshot, snapshotSha256: intent.snapshotSha256 } })))!.result as any;
  expect(saved.structuredContent).toMatchObject({ phase: "saved", authentication: { credentialProfile: "assistant", accountId: 48, authenticatedAccountVerified: true }, receipt: { remoteProvenance: { credentialProfile: "assistant", accountId: 48 } } });
  expect(h.store.saveContext(intent.snapshot.saveId)!.submission.snapshot).toMatchObject({ origin: "mcp-local", client: { name: "fixture-client", identityBasis: "declared" }, initiator: { kind: "agent", label: "declared fixture agent", identityBasis: "declared" } });
  expect(h.api.rows[0]!.connection.metadata.ab_actor_id).toBe(48); expect(h.api.creates()).toBe(1);
});
test("slow media preparation observes the save deadline before any block is created", async () => {
  const h = await harness(false), input = submission("cli", false), pause = gate();
  const publisher = new ArenaPublisher(h.client, h.store, { publicBaseUrl: "https://fixture.invalid", mediaDirectory: join(h.directory, "media"), render: async (_plan, _directory, options) => { pause.arrived(); await abortable(pause.wait, options!.signal!); return undefined; } });
  const gateway = new SaveGateway(h.client, publisher, h.store, { profile: "shared", expectedAccountId: 47 }, undefined, 25); gateways.push(gateway);
  const pending = gateway.save(input, "cli"); await pause.entered; await expect(pending).rejects.toThrow(); pause.release();
  expect(h.api.creates()).toBe(0); expect(gateway.status(input.snapshot.saveId)).toMatchObject({ phase: "unknown", authentication: { authenticatedAccountVerified: true, accountId: 47 } });
});
test("stale unverified contexts cannot downgrade a scope promoted by another store", async () => {
  const h = await harness(), input = submission(), id = input.snapshot.saveId;
  const stale = { submission: input, credentialProfile: "shared", observation: "prepared" as const, cancelRequested: false };
  h.store.recordSaveContext(id, stale);
  const second = new ArenaBlockStore(join(h.directory, "state.sqlite"), { private: true }); stores.push(second);
  second.updateSaveContext(id, { ...stale, accountId: 47 });
  expect(() => h.store.updateSaveContext(id, stale)).toThrow("cannot be removed");
  expect(h.store.saveContext(id)!.accountId).toBe(47);
  expect(() => h.store.updateSaveContext(id, { ...stale, accountId: 48 })).toThrow("cannot be removed or changed");
});
test("owner HTTP routes keep MCP disabled by default", async () => {
  const h = await harness(), service = createService({ host: "127.0.0.1", port: 8790, stateDirectory: join(h.directory, "service"), mediaDirectory: join(h.directory, "media"), publicBaseUrl: "https://fixture.invalid", accessToken: "owner-fixture", arenaToken: "never-live" });
  try {
    expect((await service.handler(new Request("https://fixture.invalid/v1/save-policy"))).status).toBe(401);
    const policyResponse = await service.handler(new Request("https://fixture.invalid/v1/save-policy", { headers: { authorization: "Bearer owner-fixture" } }));
    expect(await policyResponse.json()).toEqual({ credential: { profile: "shared", arenaTokenEnv: "ARENA_WRITE_ACCESS_TOKEN" }, mcpPublishingEnabled: false });
    const disabled = await service.handler(new Request("https://fixture.invalid/v1/mcp-saves", { method: "POST", headers: { authorization: "Bearer owner-fixture" }, body: JSON.stringify(submission("mcp-local")) })); expect(disabled.status).toBe(403); expect(h.api.calls).toHaveLength(0);
  } finally { await service.close(); }
});
test("forced legacy operation recovery verifies block ownership before any write", async () => {
  const h = await harness(false), input = submission("cli", false);
  const receipt = await h.publisher.publish({ plan, destinations: ["901"], force: false, operationId: input.snapshot.saveId });
  h.store.updateReceipt(receipt.id, current => ({ ...current, status: "needs_attention", stage: "updating" }));
  h.api.account = 48; h.api.calls = [];
  const config48 = userConfigSchema.parse({ credentialProfiles: { shared: { arenaTokenEnv: "ARENA_WRITE_ACCESS_TOKEN", expectedAccountId: 48 } } });
  const intent = prepareSaveIntent(plan, config48, { origin: "cli", initiator: { kind: "human" }, operation: "publish", destinations: ["901"], saveId: input.snapshot.saveId, force: true });
  const gateway = new SaveGateway(h.client, h.publisher, h.store, { profile: "shared", expectedAccountId: 48 }); gateways.push(gateway);
  await expect(gateway.save({ plan, snapshot: intent.snapshot, snapshotSha256: intent.snapshotSha256 }, "cli")).rejects.toThrow("another or unverified account");
  expect(h.api.calls.every(c => c.method === "GET")).toBe(true); expect(h.api.blocks.size).toBe(1);
  expect(gateway.status(input.snapshot.saveId).authentication.authenticatedAccountVerified).toBe(false);
  expect(h.store.saveAccountScope()).toBeUndefined();
});
test("cancelling an active replay preserves a prior successful receipt and stops pending work", async () => {
  const h = await harness(), input = submission(), first = await h.gateway.save(input, "cli"), pause = gate(), original = h.api.fetch;
  h.api.calls = [];
  h.api.fetch = async (...args) => { if (String(args[0]).endsWith("/me")) { pause.arrived(); await pause.wait; } return original(...args); };
  const pending = h.gateway.save(input, "cli"); await pause.entered;
  const cancelled = h.gateway.cancel(input.snapshot.saveId); expect(cancelled.phase).toBe("partial"); expect(cancelled.cancelRequested).toBe(true);
  await expect(pending).rejects.toThrow("cancellation"); pause.release();
  expect(h.gateway.status(input.snapshot.saveId).receipt).toEqual(first.receipt); expect(h.api.calls).toHaveLength(0);
});
test("actual owner HTTP client and MCP adapter share saves; disconnect does not cancel committed work", async () => {
  const h = await harness(), pause = gate(), apiFetch = h.api.fetch;
  const service = createService({ host: "127.0.0.1", port: 8790, stateDirectory: join(h.directory, "service"), mediaDirectory: join(h.directory, "media"), publicBaseUrl: "https://fixture.invalid", accessToken: "owner-fixture", arenaToken: "never-live", remoteProvenance: policy, mcpPublishingEnabled: true }, { client: h.client, render: async () => undefined });
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async (url, init) => service.handler(new Request(String(url), init))) as typeof fetch;
    const owner = new ArenaBlockClient("https://fixture.invalid", "owner-fixture"); await owner.assertSaveProfile(config, "mcp-local");
    const dispatch = createMcpSession(config, "mcp-local", { backend: owner.mcpBackend() });
    await dispatch({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "fixture-client", version: "1" } } });
    await dispatch({ jsonrpc: "2.0", method: "notifications/initialized" });
    const input = submission("mcp-local");
    const result = await dispatch(call(2, "arena_block_save", { intent: { snapshot: input.snapshot, snapshotSha256: input.snapshotSha256 } }));
    expect((result!.result as any).structuredContent.phase).toBe("saved"); expect((await owner.saveStatus(input.snapshot.saveId)).phase).toBe("saved");
    expect((await owner.retainedIntent(input.snapshot.saveId)).snapshot).toEqual(input.snapshot);
    expect((await owner.retrySave(input.snapshot.saveId)).id).toBe((result!.result as any).structuredContent.receipt.id); expect(h.api.creates()).toBe(1);
    const input2 = submission(); input2.plan = composePlan([{ ...plan.sources[0]!, id: "2", text: "Second fictional fixture" }], { media: "none" });
    const prepared = prepareSaveIntent(input2.plan, config, { origin: "cli", initiator: { kind: "human" }, operation: "publish", destinations: ["901"] });
    input2.snapshot = prepared.snapshot; input2.snapshotSha256 = prepared.snapshotSha256;
    h.api.fetch = async (...args) => { const value = await apiFetch(...args); if (String(args[0]).endsWith("/blocks") && args[1]?.method === "POST") { pause.arrived(); await pause.wait; } return value; };
    const controller = new AbortController();
    const pending = service.handler(new Request("https://fixture.invalid/v1/saves", { method: "POST", headers: { authorization: "Bearer owner-fixture" }, body: JSON.stringify(input2), signal: controller.signal }));
    await pause.entered; controller.abort(); pause.release(); const response = await pending;
    expect(response.status).toBe(200); expect((await response.json()).phase).toBe("saved"); expect(h.api.creates()).toBe(2); expect(h.api.calls.some(c => c.method === "DELETE")).toBe(false);
    // Existing native/legacy defaults still work under the journal's original shared actor.
    const legacyPlan = composePlan([{ ...plan.sources[0]!, id: "3", text: "Legacy fictional fixture" }], { media: "none" });
    const legacy = await service.handler(new Request("https://fixture.invalid/v1/publications", { method: "POST", headers: { authorization: "Bearer owner-fixture" }, body: JSON.stringify({ plan: legacyPlan, destinations: ["901"] }) })); expect(legacy.status).toBe(200); const legacyReceipt = await legacy.json(); expect(h.api.creates()).toBe(3);
    const resumeRequest = () => new Request(`https://fixture.invalid/v1/publications/${legacyReceipt.id}/resume`, { method: "POST", headers: { authorization: "Bearer owner-fixture" }, body: JSON.stringify({ destinations: ["901"] }) });
    expect((await service.handler(resumeRequest())).status).toBe(200);
    h.api.account = 48;
    const blocked = await service.handler(new Request("https://fixture.invalid/v1/publications", { method: "POST", headers: { authorization: "Bearer owner-fixture" }, body: JSON.stringify({ plan: legacyPlan, destinations: ["901"], force: true }) })); expect(blocked.status).toBe(422);
    expect((await service.handler(resumeRequest())).status).toBe(422); expect(h.api.creates()).toBe(3);
  } finally { globalThis.fetch = original; pause.release(); await service.close(); }
});
test("every explicit daemon profile including shared rejects legacy write bypass", async () => {
  const h = await harness();
  for (const profile of ["shared", "assistant"]) {
    const service = createService({ host: "127.0.0.1", port: 8790, stateDirectory: join(h.directory, profile), mediaDirectory: join(h.directory, "media"), publicBaseUrl: "https://fixture.invalid", accessToken: "owner-fixture", arenaToken: "never-live", credential: { schemaVersion: 1, profile, arenaTokenEnv: "ARENA_EXISTING_FIXTURE_TOKEN", expectedAccountId: 47 } }, { client: h.client, render: async () => undefined });
    try { const response = await service.handler(new Request("https://fixture.invalid/v1/publications", { method: "POST", headers: { authorization: "Bearer owner-fixture" }, body: JSON.stringify({ plan, destinations: ["901"] }) })); expect(response.status).toBe(422); }
    finally { await service.close(); }
  }
  expect(h.api.calls).toHaveLength(0);
});
test("retained MCP replay cannot bypass disabled publishing through the CLI root", async () => {
  const h = await harness(), directory = join(h.directory, "replay-service");
  const serviceConfig = { host: "127.0.0.1", port: 8790, stateDirectory: directory, mediaDirectory: join(h.directory, "media"), publicBaseUrl: "https://fixture.invalid", accessToken: "owner-fixture", arenaToken: "never-live", remoteProvenance: policy };
  let service = createService({ ...serviceConfig, mcpPublishingEnabled: true }, { client: h.client, render: async () => undefined });
  const input = submission("mcp-local"), request = (path: string, body: unknown = {}) => new Request(`https://fixture.invalid${path}`, { method: "POST", headers: { authorization: "Bearer owner-fixture" }, body: JSON.stringify(body) });
  try {
    expect((await service.handler(request("/v1/mcp-saves", input))).status).toBe(200);
    const count = h.api.calls.length; await service.close();
    service = createService({ ...serviceConfig, mcpPublishingEnabled: false }, { client: h.client, render: async () => undefined });
    for (const root of ["/v1/saves", "/v1/mcp-saves"]) expect((await service.handler(request(`${root}/${input.snapshot.saveId}/retry`))).status).toBe(403);
    expect(h.api.calls).toHaveLength(count); expect(h.api.creates()).toBe(1);
    const status = await service.handler(new Request(`https://fixture.invalid/v1/saves/${input.snapshot.saveId}`, { headers: { authorization: "Bearer owner-fixture" } })); expect((await status.json()).phase).toBe("saved");
  } finally { await service.close(); }
});
test("HTTP client refuses redirect, bounds responses and validates status UUID", async () => {
  const original = globalThis.fetch;
  try {
    const h = await harness(), input = submission(), saved = await h.gateway.save(input, "cli");
    globalThis.fetch = (async (_input, init) => { expect(init?.redirect).toBe("error"); return Response.json({ ...saved, saveId: crypto.randomUUID() }); }) as typeof fetch;
    await expect(new ArenaBlockClient("https://fixture.invalid", "owner-fixture").saveStatus(input.snapshot.saveId)).rejects.toThrow("does not match");
  } finally { globalThis.fetch = original; }
});
