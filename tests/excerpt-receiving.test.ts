import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArenaClient, ArenaPublisher } from "../src/arena.ts";
import { ArenaBlockClient } from "../src/client.ts";
import { ArenaBlockStore } from "../src/store.ts";
import { createService } from "../src/service.ts";
import { manualExcerptPlan, excerptPlanFromDocument } from "../packages/core/excerpt.ts";
import { MockApi } from "./fixtures/remote-api.ts";

const source = "https://gwern.net/example#source";
test("receiving creates a native Text block, verifies the source/body, and replays without duplicate creation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "excerpt-receiving-"));
  const store = new ArenaBlockStore(join(directory, "store.sqlite"));
  const api = new MockApi();
  const publisher = new ArenaPublisher(new ArenaClient("fixture", "https://arena.invalid/v3", api.fetch as typeof fetch, 100), store,
    { publicBaseUrl: "https://fixture.invalid", mediaDirectory: directory, render: async plan => { expect(plan.block.kind).toBe("text"); expect(plan.block.selectedMedia).toEqual([]); return undefined; }, verifyTimeoutMs: 100, pollIntervalMs: 1 });
  try {
    const plan = manualExcerptPlan({ url: source, text: "- **Retained list**\n\n> Exact quote and [citation](https://example.com/).", title: "Curated excerpt" });
    const receipt = await publisher.publish({ plan, destinations: ["902"], force: false });
    expect(receipt.status).toBe("verified"); expect(api.creates()).toBe(1);
    const block = api.blocks.get(receipt.blockId!)!;
    expect(block.type).toBe("Text"); expect(block.source.url).toBe(source); expect(block.content.markdown).toBe(plan.block.markdown);
    expect((await publisher.publish({ plan, destinations: ["902"], force: false })).id).toBe(receipt.id); expect(api.creates()).toBe(1);
    expect(store.plan(plan.hash)?.plan).toEqual(plan);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("an older receiver cannot silently discard excerpt provenance", async () => {
  const plan = manualExcerptPlan({ url: source, text: "Exact text." });
  const calls: string[] = [];
  const client = new ArenaBlockClient("https://fixture.invalid", "fixture", async url => { calls.push(String(url)); return Response.json({ version: "old", revision: null, sourceId: "old", platform: "fixture", schemaVersion: 1, packagePath: null, planCapabilities: [] }); });
  await expect(client.publish(plan, ["902"])).rejects.toThrow("web-excerpts-v1");
  expect(calls).toEqual(["https://fixture.invalid/v1/version"]);
});

test("excerpt planning endpoint requires authorization, stores exact manual text, and performs no Are.na write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "excerpt-service-")), api = new MockApi();
  const service = createService({ host: "127.0.0.1", port: 0, publicBaseUrl: "https://fixture.invalid", stateDirectory: directory,
    mediaDirectory: directory, accessToken: "fixture-engine", arenaToken: "fixture" }, { client: new ArenaClient("fixture", "https://arena.invalid/v3", api.fetch as typeof fetch, 100), render: async () => undefined });
  try {
    const body = JSON.stringify({ url: source, text: "A supplied excerpt.", title: "My title" });
    const denied = await service.handler(new Request("https://fixture.invalid/v1/excerpt-plans", { method: "POST", body }));
    expect(denied.status).toBe(401); await denied.text();
    const response = await service.handler(new Request("https://fixture.invalid/v1/excerpt-plans", { method: "POST", headers: { authorization: "Bearer fixture-engine" }, body }));
    expect(response.status).toBe(200); const plan = await response.json();
    expect(plan.block).toMatchObject({ kind: "text", markdown: "A supplied excerpt.", canonicalSource: source, excerpt: { kind: "manual" } });
    expect(api.calls).toEqual([]);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test("editing a resolved body cannot silently retain its old resolution record", () => {
  const plan = excerptPlanFromDocument({ url: "https://example.com/#:~:text=Exact%20text." }, { body: "<p>Exact text.</p>", responseURL: "https://example.com/", contentType: "text/html" });
  const edited = structuredClone(plan); edited.block.markdown = "Changed text.";
  const { blockPlanSchema } = require("../packages/core/types.ts");
  expect(() => blockPlanSchema.parse(edited)).toThrow("Edited excerpt text");
});
