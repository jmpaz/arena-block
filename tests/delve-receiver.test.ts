import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArenaClient, ArenaPublisher } from "../src/arena.ts";
import { composePlan, planHash } from "../src/compose.ts";
import { userConfigSchema } from "../src/config.ts";
import { prepareSaveIntent } from "../src/save-intent.ts";
import { saveSnapshotSchema } from "../src/provenance-schema.ts";
import { createService } from "../src/service.ts";
import { ArenaBlockStore } from "../src/store.ts";
import { blockPlanSchema, type BlockPlan, type PublishRequest } from "../src/types.ts";
import { MockApi } from "./fixtures/remote-api.ts";
import { assignMediaRefs } from "../packages/core/providers/provider.ts";

const policy = { inboxChannel: "901", mode: "full" as const, credentialProfile: "shared", expectedAccountId: 47 };
const config = userConfigSchema.parse({ remoteInbox: { channel: "901", mode: "always" }, provenance: { remoteSnapshot: "full" },
  credentialProfiles: { shared: { arenaTokenEnv: "ARENA_WRITE_ACCESS_TOKEN", expectedAccountId: 47 } } });
async function fixture(name: string): Promise<BlockPlan> {
  if (name === "substack-quoted-images") {
    const legacy = await Bun.file(new URL("./fixtures/substack-legacy-containing-note-plan.json", import.meta.url)).json();
    return blockPlanSchema.parse(composePlan(legacy.sources.map(assignMediaRefs), legacy.policy));
  }
  return blockPlanSchema.parse(await Bun.file(new URL(`./fixtures/${name}.json`, import.meta.url)).json());
}
function submission(plan: BlockPlan): PublishRequest {
  const intent = prepareSaveIntent(plan, config, { origin: "cli", initiator: { kind: "human" }, destinations: ["901", "active"], operation: "publish" });
  return { plan, destinations: intent.snapshot.routing.destinations, force: false, operationId: intent.snapshot.saveId,
    remoteSave: { snapshot: intent.snapshot, snapshotSha256: intent.snapshotSha256, mode: "full" } };
}

test.each(["delve-client-thread-plan", "delve-client-image-plan", "delve-client-quote-images-plan", "legacy-client-bluesky-plan"])(
  "%s retains the exact client snapshot while recomposition preserves sources and selection", async name => {
    const raw = await Bun.file(new URL(`./fixtures/${name}.json`, import.meta.url)).json();
    const plan = blockPlanSchema.parse(raw);
    expect(plan).toEqual(raw);
    const recomposed = composePlan(plan.sources, plan.policy);
    expect(recomposed.sources).toEqual(plan.sources);
    expect(recomposed.policy).toEqual(plan.policy);
    expect(recomposed.block.title).toBe(plan.block.title);
    expect(recomposed.block.selectedMedia).toEqual(plan.block.selectedMedia);
    if (name !== "delve-client-quote-images-plan") expect(recomposed).toEqual(plan);
    else {
      expect(plan.block.markdown).toContain("[reference.example/](<https://reference.example/>)");
      expect(recomposed.block.markdown).toContain("[https://reference.example/](<https://reference.example/>)");
      expect(recomposed.hash).not.toBe(plan.hash);
    }
    const { hash, ...content } = plan;
    expect(planHash(content)).toBe(hash);
    const directory = await mkdtemp(join(tmpdir(), "delve-receiver-store-"));
    const store = new ArenaBlockStore(join(directory, "state.sqlite"));
    try {
      store.savePlan(plan);
      expect(store.plan(hash)?.plan).toEqual(plan);
      const changed = structuredClone(plan);
      changed.sources[0]!.text += " changed";
      expect(() => store.savePlan(changed)).toThrow("hash");
    } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
  },
);

test("protocol record and nested quote metadata remain part of immutable plan identity", async () => {
  const plan = await fixture("delve-client-quote-images-plan");
  for (const mutate of [
    (value: BlockPlan) => { value.sources[0]!.atproto!.cid += "changed"; },
    (value: BlockPlan) => { value.sources[0]!.quote!.atproto!.record.text = "changed"; },
    (value: BlockPlan) => { value.sources[0]!.quote!.facets![0]!.index.byteEnd += 1; },
  ]) {
    const changed = structuredClone(plan); mutate(changed);
    const { hash, ...content } = changed;
    expect(planHash(content)).not.toBe(hash);
  }
});

test("unavailable quote descendants respect depth while their source identity is retained", async () => {
  const plan = await fixture("delve-client-quote-images-plan");
  const parent = plan.sources[0]!;
  const missing = "at://did:plc:2vb3emjr2ttkwc2dj534fdqj/town.delve.feed.post/missing";
  parent.quote!.embeddedRecord = { uri: missing, status: "not-found" };
  expect(composePlan([parent], { quoteDepth: 1 }).block.markdown).not.toContain(missing);
  expect(composePlan([parent], { quoteDepth: 2 }).block.markdown).toContain(missing);
  expect(composePlan([parent], { quote: "omit" }).block.markdown).not.toContain(missing);
  expect(parent.quote!.embeddedRecord.uri).toBe(missing);
});

test.each(["delve-client-thread-plan", "delve-client-image-plan", "delve-client-quote-images-plan", "legacy-client-bluesky-plan", "substack-quoted-images"])("%s publishes and replays through the existing mock-only provenance path", async name => {
  const directory = await mkdtemp(join(tmpdir(), "delve-receiver-publish-"));
  const store = new ArenaBlockStore(join(directory, "state.sqlite"));
  const api = new MockApi();
  const fetcher = (async (input, init) => {
    const response = await api.fetch(input, init);
    if (init?.method === "POST" && new URL(String(input)).pathname === "/v3/blocks" && JSON.parse(String(init.body)).cover_url) {
      const created = await response.clone().json();
      Object.assign(api.blocks.get(created.data.id)!, { type: "Link", source: { url: JSON.parse(String(init.body)).original_source_url },
        image: { src: "https://fixture.invalid/copied-cover.jpg" } });
    }
    return response;
  }) as typeof fetch;
  const client = new ArenaClient("fixture-never-live", "https://arena.invalid/v3", fetcher, 100);
  const publisher = new ArenaPublisher(client, store, { publicBaseUrl: "https://fixture.invalid", mediaDirectory: directory,
    render: async plan => plan.block.kind === "text" ? undefined : { hash: plan.hash, path: join(directory, "mock.jpg"),
      extension: "jpg", mimeType: "image/jpeg", size: 13 }, verifyTimeoutMs: 100, pollIntervalMs: 1, remoteProvenance: policy });
  try {
    const input = submission(await fixture(name));
    const receipt = await publisher.publish(input);
    expect(receipt.status).toBe("verified");
    expect(receipt.remoteProvenance).toMatchObject({ accountId: 47, state: "verified" });
    expect(store.plan(input.plan.hash)?.plan).toEqual(input.plan);
    expect(store.remoteSave(input.operationId!)?.intent.snapshot).toEqual(saveSnapshotSchema.parse(input.remoteSave!.snapshot));
    expect((await publisher.publish(input)).id).toBe(receipt.id);
    expect(api.creates()).toBe(1);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test.each(["actor", "visibility", "permission", "owner", "checksum"])("Delve preserves the %s authorization/checksum boundary before mock creation", async fault => {
  const directory = await mkdtemp(join(tmpdir(), "delve-receiver-auth-"));
  const store = new ArenaBlockStore(join(directory, "state.sqlite"));
  const api = new MockApi();
  const client = new ArenaClient("fixture-never-live", "https://arena.invalid/v3", api.fetch as typeof fetch, 100);
  const publisher = new ArenaPublisher(client, store, { publicBaseUrl: "https://fixture.invalid", mediaDirectory: directory,
    render: async () => undefined, verifyTimeoutMs: 100, pollIntervalMs: 1, remoteProvenance: policy });
  try {
    const input = submission(await fixture("delve-client-thread-plan"));
    if (fault === "actor") api.account = 48;
    if (fault === "visibility") api.visibility = "public";
    if (fault === "permission") api.writable = false;
    if (fault === "owner") api.ownerId = 48;
    if (fault === "checksum") input.plan.sources[0]!.atproto!.cid += "changed";
    await expect(publisher.publish(input)).rejects.toThrow();
    expect(api.creates()).toBe(0);
    if (fault === "checksum") expect(api.calls).toHaveLength(0);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("capabilities and Delve save endpoints retain bearer and MCP authorization", async () => {
  const directory = await mkdtemp(join(tmpdir(), "delve-receiver-service-"));
  const api = new MockApi();
  const service = createService({ host: "127.0.0.1", port: 0, publicBaseUrl: "https://fixture.invalid", stateDirectory: directory,
    mediaDirectory: directory, accessToken: "fixture-engine-token", arenaToken: "fixture-never-live" },
  { client: new ArenaClient("fixture-never-live", "https://arena.invalid/v3", api.fetch as typeof fetch, 100), render: async () => undefined });
  try {
    const input = submission(await fixture("delve-client-thread-plan"));
    for (const path of ["/v1/version", "/v1/publications", "/v1/saves"]) {
      const response = await service.handler(new Request(`https://fixture.invalid${path}`, path === "/v1/version" ? {} :
        { method: "POST", body: JSON.stringify(input) }));
      expect(response.status).toBe(401);
      await response.text();
    }
    const headers = { authorization: "Bearer fixture-engine-token" };
    const response = await service.handler(new Request("https://fixture.invalid/v1/version", { headers }));
    expect((await response.json()).planCapabilities).toEqual(["atproto-post-records-v1", "delve-posts-v1", "bluesky-thread-coverage-v1", "forum-magnum-posts-v1", "expanded-source-count-32-v1", "reddit-browser-records-v1", "reddit-public-page-records-v1", "substack-browser-records-v1", "substack-public-sources-v2", "substack-native-media-v1", "substack-note-attachments-v1", "quoted-image-media-v1"]);
    const denied = await service.handler(new Request("https://fixture.invalid/v1/mcp-saves", { method: "POST", headers, body: JSON.stringify(input) }));
    expect(denied.status).toBe(403);
    await denied.text();
    expect(api.calls).toHaveLength(0);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test.each(["delve-client-thread-plan", "legacy-client-bluesky-plan"])("%s retains the journaled HTTP save capsule and account checks", async name => {
  const directory = await mkdtemp(join(tmpdir(), "delve-receiver-capsule-"));
  const api = new MockApi();
  const service = createService({ host: "127.0.0.1", port: 0, publicBaseUrl: "https://fixture.invalid", stateDirectory: directory,
    mediaDirectory: directory, accessToken: "fixture-engine-token", arenaToken: "fixture-never-live", remoteProvenance: policy,
    credential: { schemaVersion: 1, profile: "shared", arenaTokenEnv: "ARENA_WRITE_ACCESS_TOKEN", expectedAccountId: 47 } },
  { client: new ArenaClient("fixture-never-live", "https://arena.invalid/v3", api.fetch as typeof fetch, 100), render: async () => undefined });
  try {
    const retained = await fixture(name);
    const plan = name === "legacy-client-bluesky-plan" ? composePlan(retained.sources, { ...retained.policy, media: "none" }) : retained;
    const input = submission(plan);
    const capsule = { plan, snapshot: input.remoteSave!.snapshot, snapshotSha256: input.remoteSave!.snapshotSha256, remoteMode: "full" };
    const send = () => service.handler(new Request("https://fixture.invalid/v1/saves", { method: "POST",
      headers: { authorization: "Bearer fixture-engine-token" }, body: JSON.stringify(capsule) }));
    const response = await send();
    expect(response.status).toBe(200);
    const status = await response.json();
    expect(status).toMatchObject({ phase: "saved", authentication: { accountId: 47, authenticatedAccountVerified: true } });
    expect(status.receipt.planHash).toBe(plan.hash);
    const replay = await send();
    expect((await replay.json()).receipt.id).toBe(status.receipt.id);
    expect(api.creates()).toBe(1);
    api.account = 48;
    const denied = await send();
    expect(denied.status).not.toBe(200);
    await denied.text();
    expect(api.creates()).toBe(1);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});
