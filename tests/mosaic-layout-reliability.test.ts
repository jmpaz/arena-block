import { expect, test } from "bun:test";
import { composePlan, planHash } from "../packages/core/compose.ts";
import { captureRenderRecipe, tileRects, MosaicLayoutError } from "../packages/core/render-recipe.ts";
import type { MediaAsset, ResolvedPost } from "../packages/core/types.ts";
import fixture from "./fixtures/mosaic-xh-dimensions.json";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ArenaClient, ArenaPublisher } from "../src/arena.ts";
import { ArenaBlockStore } from "../src/store.ts";
import { SaveGateway } from "../src/save-gateway.ts";
import { userConfigSchema } from "../src/config.ts";
import { prepareSaveIntent } from "../src/save-intent.ts";
import { MockApi } from "./fixtures/remote-api.ts";

const asset = (width: number, height: number, index: number): MediaAsset => ({ ref: `1.${index}`, kind: "image", url: `https://example.test/${index}.jpg`, width, height, alt: "" });
const post: ResolvedPost = { provider: "x", id: "1", canonicalUrl: "https://x.com/fixture/status/1", author: { handle: "fixture" }, text: "Source prose", media: [] };
function incidentSources(): ResolvedPost[] {
  return Array.from({ length: 19 }, (_, index) => ({ ...post, id: String(index + 1), canonicalUrl: `https://x.com/fixture/status/${index + 1}`,
    text: index ? "Extra source prose" : post.text,
    media: fixture.images.filter(item => item.ref.split(".")[0] === String(index + 1)).map(item => ({ ...asset(item.width, item.height, 1), ref: item.ref, url: `https://example.test/${item.ref}.jpg` })) }));
}
const refs = (layout: NonNullable<ReturnType<typeof composePlan>["block"]["layout"]>): string[] => layout.kind === "media" ? [layout.ref] : layout.children.flatMap(refs);

test("the retained22-image layout remains rejected with a typed reason and is never rewritten", () => {
  const assets = new Map(incidentSources().flatMap(source => source.media).map(item => [item.ref, item]));
  const before = JSON.stringify(fixture.layout);
  let failure: unknown;
  try { tileRects(fixture.layout as Parameters<typeof tileRects>[0], assets, 4096, 256); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(MosaicLayoutError);
  expect(failure).toMatchObject({ code: "media_budget" });
  expect((failure as Error).message).toContain("2510x4096");
  expect(JSON.stringify(fixture.layout)).toBe(before);
});

test("new19-source compositions retain all22 images and prose in a legible bounded layout", () => {
  const sources = incidentSources(), before = JSON.stringify(sources);
  const policy = { media: "all" as const, mediaOnlyPosts: Array.from({ length: 18 }, (_, index) => index + 2) };
  const plan = composePlan(sources, policy), recipe = captureRenderRecipe(plan)!;
  expect(recipe.width).toBe(4096); expect(recipe.height).toBe(3500);
  expect(Math.min(...recipe.tiles.map(tile => Math.min(tile.rect.width, tile.rect.height)))).toBe(314);
  expect(plan.block.selectedMedia).toEqual(fixture.images.map(item => item.ref));
  expect(refs(plan.block.layout!)).toEqual(plan.block.selectedMedia);
  expect(recipe.tiles.map(tile => tile.ref)).toEqual(plan.block.selectedMedia);
  expect(plan.block.markdown).toBe(`${post.text}\n\n*[image]*`);
  expect(plan.sources).toEqual(sources);
  expect(JSON.stringify(sources)).toBe(before);
  expect(composePlan(sources, policy)).toEqual(plan);
  for (const tile of recipe.tiles) {
    expect(Math.min(tile.rect.width, tile.rect.height)).toBeGreaterThanOrEqual(256);
    expect(tile.rect.x + tile.rect.width).toBeLessThanOrEqual(recipe.width);
    expect(tile.rect.y + tile.rect.height).toBeLessThanOrEqual(recipe.height);
  }
});

test("fallback respects an explicit complete order including moving the first image", () => {
  const sources = incidentSources(), desired = sources.flatMap(source => source.media).map(item => item.ref).reverse();
  const plan = composePlan(sources, { media: "all", mediaOrder: desired });
  const recipe = captureRenderRecipe(plan)!;
  expect(plan.block.selectedMedia).toEqual(desired);
  expect(refs(plan.block.layout!)).toEqual(desired);
  expect(recipe.tiles.map(tile => tile.ref)).toEqual(desired);
  expect(recipe.tiles.every(tile => Math.min(tile.rect.width, tile.rect.height) >= 256)).toBe(true);
  expect(plan.sources[0]!.media[0]!.ref).toBe("1.1");
});

test("already-legible automatic and explicit layouts retain their pre-fix hashes", () => {
  // Golden hashes were recorded from a308f4c before introducing the fallback.
  const cases = [
    { media: [asset(640, 480, 1), asset(640, 480, 2)], hash: "af66ba6369311d9bce3bdb13b93269f6a2d6848019684900164097012e8fbefb", order: undefined },
    { media: [asset(400, 800, 1), asset(400, 800, 2), asset(400, 800, 3)], hash: "c8fe9591f3e3c09421640897b3c7a87d0c98fb23fe49abf254bae2660916c4ab", order: undefined },
    { media: [asset(400, 800, 1), asset(800, 400, 2), asset(600, 600, 3)], hash: "2aaa0e215f860e2263fd3dc7352a260e83136d880d35235516c55621138657b4", order: ["1.3", "1.2", "1.1"] },
  ];
  for (const item of cases) {
    const plan = composePlan([{ ...post, media: item.media }], { media: "all", ...(item.order ? { mediaOrder: item.order } : {}) });
    expect(plan.hash).toBe(item.hash);
    expect(captureRenderRecipe(plan)!.tiles.every(tile => Math.min(tile.rect.width, tile.rect.height) >= 256)).toBe(true);
  }
});

test("an impossible image selection retains every asset and still fails the unchanged guard", () => {
  const media = [asset(1, 100_000, 1), asset(100_000, 1, 2)];
  const plan = composePlan([{ ...post, media }], { media: "all" });
  expect(plan.block.selectedMedia).toEqual(["1.1", "1.2"]);
  expect(() => captureRenderRecipe(plan)).toThrow(MosaicLayoutError);
  expect(plan.sources[0]!.media).toEqual(media);
});

test("image selections beyond the100-item fallback bound retain their original failure", () => {
  const media = Array.from({ length: 101 }, (_, index) => asset(1, 100_000, index + 1));
  const plan = composePlan([{ ...post, media }], { media: "all" });
  expect(plan.block.selectedMedia).toEqual(media.map(item => item.ref));
  expect(() => captureRenderRecipe(plan)).toThrow(MosaicLayoutError);
});

test("a frozen dense plan records the specific media_budget failure before creation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arena-layout-failure-"));
  const store = new ArenaBlockStore(join(directory, "state.sqlite"), { private: true });
  const api = new MockApi(), client = new ArenaClient("fixture-never-live", "https://arena.invalid/v3", (...args) => api.fetch(...args), 100);
  const policy = { inboxChannel: "901", mode: "full" as const, credentialProfile: "shared", expectedAccountId: 47 };
  const publisher = new ArenaPublisher(client, store, { publicBaseUrl: "https://fixture.invalid", mediaDirectory: join(directory, "media"),
    render: async plan => { captureRenderRecipe(plan); throw new Error("Expected the frozen geometry to fail"); }, remoteProvenance: policy });
  const gateway = new SaveGateway(client, publisher, store, { profile: "shared", expectedAccountId: 47 }, policy, 500);
  try {
    const generated = composePlan(incidentSources(), { media: "all", mediaOnlyPosts: Array.from({ length: 18 }, (_, index) => index + 2) });
    const { hash: _hash, ...base } = generated;
    base.block.layout = structuredClone(fixture.layout) as typeof base.block.layout;
    const frozen = { ...base, hash: planHash(base) }, before = JSON.stringify(frozen);
    const config = userConfigSchema.parse({ defaultChannel: { channel: "901", mode: "always" }, provenance: { remoteSnapshot: "full" } });
    const intent = prepareSaveIntent(frozen, config, { origin: "cli", initiator: { kind: "human" }, operation: "publish", destinations: ["901"] });
    await expect(gateway.save({ plan: frozen, snapshot: intent.snapshot, snapshotSha256: intent.snapshotSha256, remoteMode: "full" }, "cli")).rejects.toThrow("2510x4096");
    expect(gateway.status(intent.snapshot.saveId)).toMatchObject({ phase: "not_saved", active: false, failure: { code: "media_budget" } });
    expect(gateway.status(intent.snapshot.saveId).failure!.message).toContain("2510x4096");
    expect(store.operationState(intent.snapshot.saveId)).toEqual({ operationId: intent.snapshot.saveId });
    expect(api.creates()).toBe(0);
    expect(api.calls.some(call => call.method === "POST")).toBe(false);
    expect(JSON.stringify(frozen)).toBe(before);
  } finally { await gateway.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});
