import { expect, test } from "bun:test";
import { composePlan, planHash } from "../packages/core/compose.ts";
import { assignMediaRefs } from "../packages/core/providers/provider.ts";
import { mediaSources, requireAddressableQuoteMedia } from "../packages/core/media-tree.ts";
import { captureRenderRecipe } from "../packages/core/render-recipe.ts";
import { blockPlanSchema, type MediaAsset, type ResolvedPost } from "../packages/core/types.ts";
import { requiredPlanCapabilities } from "../src/plan-capabilities.ts";
import { ArenaBlockClient } from "../src/client.ts";

const image = (id: string): MediaAsset => ({ ref: "0.0", kind: "image", url: `https://images.example/${id}.png`, width: 640, height: 480, alt: "" });
const video = (id: string): MediaAsset => ({ ref: "0.0", kind: "video", url: `https://video.example/${id}.mp4`, posterUrl: `https://images.example/${id}.png`, width: 640, height: 480, durationSeconds: 5, alt: "" });
const post = (id: string, media: MediaAsset[], quote?: ResolvedPost): ResolvedPost => ({ provider: "x", id, canonicalUrl: `https://x.com/author${id}/status/${id}`, author: { handle: `author${id}` }, text: `Authored ${id}`, media, ...(quote ? { quote } : {}) });
const tree = () => assignMediaRefs(post("100", [image("100")], post("200", [video("200")], post("300", [video("300")]))), 0);
const probes = { "1.2": { width: 640, height: 480, duration: 5, fps: 30, audio: true }, "1.3": { width: 640, height: 480, duration: 7, fps: 30, audio: true } };

test("quoted videos use distinct owning-source refs, source order, frame choices and an audio-preserving recipe", () => {
  const root = tree();
  const plan = blockPlanSchema.parse(composePlan([root], { media: "all", quoteDepth: "full", audio: "mix" }));
  expect(plan.block.selectedMedia).toEqual(["1.1", "1.2", "1.3"]);
  expect(plan.block.kind).toBe("video");
  expect(mediaSources(plan.sources).map(node => [node.source.id, node.media.map(asset => asset.ref)])).toEqual([["100", ["1.1"]], ["200", ["1.2"]], ["300", ["1.3"]]]);
  const recipe = captureRenderRecipe(plan, probes)!;
  expect(recipe.tiles.map(tile => tile.ref)).toEqual(["1.1", "1.2", "1.3"]);
  expect(recipe.audio).toEqual(["1.2", "1.3"]);
  expect(plan.block.markdown).toContain("@author200");
  expect(plan.block.markdown).toContain("@author300");
  const frame = blockPlanSchema.parse(composePlan([root], { videoFrames: ["1.2", "1.3"] }));
  expect(frame.block.frameMedia?.map(item => item.ref)).toEqual(["1.2", "1.3"]);
  expect(frame.block.kind).toBe("link");
  expect(captureRenderRecipe(frame)!.tiles.map(tile => tile.kind)).toEqual(["image", "image", "image"]);
  expect(requiredPlanCapabilities(plan)).toContain("quoted-video-audio-v1");
  expect(() => requireAddressableQuoteMedia(plan)).not.toThrow();
});

test("quote depth hides videos, frame and soundtrack choices without losing explicit selection preferences", () => {
  const root = tree();
  const policy = { media: "selected" as const, selectedMedia: ["1.1", "1.2", "1.3"], mediaOrder: ["1.3", "1.2", "1.1"], videoFrames: ["1.2", "1.3"] };
  const hidden = blockPlanSchema.parse(composePlan([root], { ...policy, quoteDepth: 0 }));
  expect(hidden.block.selectedMedia).toEqual(["1.1"]);
  expect(hidden.block.frameMedia).toBeUndefined();
  expect(hidden.policy.videoFrames).toEqual(["1.2", "1.3"]);
  expect(composePlan([root], { ...policy, quoteDepth: 2 }).block.selectedMedia).toEqual(["1.3", "1.2", "1.1"]);
  const rootVideo = assignMediaRefs(post("100", [video("100")], post("200", [video("200")])), 0);
  const sound = { media: "selected" as const, selectedMedia: ["1.1", "1.2"], audio: "1.2" };
  const off = composePlan([rootVideo], { ...sound, quoteDepth: 0 });
  expect(captureRenderRecipe(off, { "1.1": probes["1.2"] })!.audio).toEqual(["1.1"]);
  expect(captureRenderRecipe(composePlan([rootVideo], { ...sound, quoteDepth: 1 }), { "1.1": probes["1.2"], "1.2": probes["1.3"] })!.audio).toEqual(["1.2"]);
  expect(() => composePlan([root], { videoFrames: ["1.99"] })).toThrow();
});

test("old receiver rejects quoted video selections and hidden frame or soundtrack preferences before any save", async () => {
  const root = tree();
  for (const policy of [{ media: "all" as const }, { quoteDepth: 0, videoFrames: ["1.2"] }, { quoteDepth: 0, audio: "1.2" }]) {
    const plan = composePlan([root], policy), requests: string[] = [];
    const client = new ArenaBlockClient("https://receiver.invalid", "fixture", (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(`${init?.method ?? "GET"} ${new URL(String(input)).pathname}`);
      return Response.json({ version: "0.1.0", revision: null, sourceId: "older", platform: "test", schemaVersion: 1, packagePath: null, planCapabilities: ["quoted-image-media-v1"] });
    }) as typeof fetch);
    await expect(client.publish(plan, ["901"])).rejects.toThrow("quoted-video-audio-v1");
    expect(requests).toEqual(["GET /v1/version"]);
  }
});

test("frozen legacy audiovisual and v1 quoted-image queues retain their exact fields and hashes", async () => {
  const old = await Bun.file(new URL("./fixtures/quoted-av-legacy-plans.json", import.meta.url)).json();
  old.push(await Bun.file(new URL("./fixtures/quoted-image-v1-queued-plan.json", import.meta.url)).json());
  for (const plan of old) {
    expect(blockPlanSchema.parse(plan)).toEqual(plan);
    const { hash, ...content } = plan;
    expect(planHash(content)).toBe(hash);
  }
  const stale = old[0];
  expect(() => requireAddressableQuoteMedia(stale)).toThrow("matching receiver");
  const fresh = composePlan(stale.sources.map(assignMediaRefs), stale.policy);
  expect(fresh.block.selectedMedia).toEqual([]);
  expect(composePlan(fresh.sources, { media: "all" }).block.selectedMedia).toEqual(["1.1"]);
  expect(fresh.sources[0]!.quote!.media[0]!.ref).toBe("1.1");
  expect(blockPlanSchema.parse(fresh)).toEqual(fresh);
});

test("a quoted verified public audio file follows its own source and passes through without conversion", async () => {
  const { SubstackProvider } = await import("../packages/core/providers/substack.ts");
  const { parseSource } = await import("../packages/core/url.ts");
  const { renderPlan } = await import("../src/render.ts");
  const { mkdtemp, rm, readdir } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const raw = await Bun.file(new URL("./fixtures/substack-public-podcast.json", import.meta.url)).json();
  const owner = await new SubstackProvider([], (async () => Response.json(raw)) as unknown as typeof fetch).resolve(parseSource(raw.canonical_url));
  // A one-second original fixture exercises byte preservation and duration checks.
  owner.media = owner.media.filter(asset => asset.kind === "audio").map(asset => ({ ...asset, durationSeconds: 1 }));
  owner.substackArticle!.nativeMedia = owner.substackArticle!.nativeMedia!.map(asset => asset.kind === "audio" ? { ...asset, durationSeconds: 1 } : asset);
  const root = assignMediaRefs(post("100", [], owner), 0);
  const plan = blockPlanSchema.parse(composePlan([root], { media: "audio" }));
  expect(plan.block.kind).toBe("audio");
  expect(plan.block.canonicalSource).toBe(root.canonicalUrl);
  expect(plan.block.selectedMedia).toEqual(["1.1"]);
  expect(plan.sources[0]!.quote!.author).toEqual(owner.author);
  expect(requiredPlanCapabilities(plan)).toContain("quoted-video-audio-v1");
  const bytes = Buffer.alloc(44 + 16000);
  bytes.write("RIFF"); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write("data", 36); bytes.writeUInt32LE(16000, 40);
  const dir = await mkdtemp(join(tmpdir(), "quoted-original-audio-")), calls: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => { calls.push(String(input)); return new Response(Uint8Array.from(bytes)); }) as typeof fetch;
  try {
    const output = await renderPlan(plan, dir, { fetcher });
    expect(output!.extension).toBe("wav");
    expect(Buffer.from(await Bun.file(output!.path).arrayBuffer())).toEqual(bytes);
    expect(calls).toEqual([owner.media[0]!.url]);
    const forged = structuredClone(plan); forged.sources[0]!.quote!.media[0]!.durationSeconds = 50;
    await expect(renderPlan(forged, dir, { fetcher })).rejects.toThrow("consistent complete public source evidence");
    expect(calls).toHaveLength(1);
    expect(await readdir(join(dir, ".staging"))).toEqual([]);
    expect(composePlan([root]).block.kind).toBe("text");
    const doubled = assignMediaRefs(post("100", [], { ...owner, quote: { ...owner, id: "article:999", canonicalUrl: "https://audio.example/p/other" } }), 0);
    expect(composePlan([doubled]).block.kind).toBe("text");
    expect(() => composePlan([doubled], { media: "audio" })).toThrow("one original audio");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("actual Substack quote fixtures retain separate authors, native video evidence, explicit frames and source roles", async () => {
  for (const name of ["substack-quoted-video-public-plan", "substack-quoted-mixed-public-plan"]) {
    const plan = await Bun.file(new URL(`./fixtures/${name}.json`, import.meta.url)).json();
    expect(blockPlanSchema.parse(plan)).toEqual(plan);
    expect(composePlan(plan.sources, plan.policy).block.selectedMedia).toEqual(plan.sources[0].media.map((asset: MediaAsset) => asset.ref));
    const root = plan.sources[0], child = root.quote;
    expect(root.author.handle).not.toBe(child.author.handle);
    expect(child.author.handle).toBe("substack");
    expect(child.media[0]).toMatchObject({ kind: "video", sourceRole: "original", acquisition: "substack-public-original" });
    expect(plan.block.markdown).toContain("[`@substack`]");
    expect(composePlan(plan.sources, { ...plan.policy, quoteDepth: 0 }).block.selectedMedia).toEqual(root.media.map((asset: MediaAsset) => asset.ref));
    const frame = blockPlanSchema.parse(composePlan(plan.sources, { ...plan.policy, media: "all", videoFrameThresholdSeconds: 60 }));
    expect(frame.block.kind).toBe("link");
    expect(frame.block.frameMedia).toEqual([{ ref: child.media[0].ref, url: child.media[0].posterUrl }]);
    expect(frame.sources[0]!.quote!.media[0]!.kind).toBe("video");
    const forged = structuredClone(plan); forged.sources[0].quote.media[0].durationSeconds += 10;
    expect(() => blockPlanSchema.parse(forged)).toThrow("complete source record");
  }
});

test("soundtrack controls expose selected moving videos with their quote owners and exclude frames", async () => {
  const { videoSoundtrackSources } = await import("../packages/core/media-tree.ts");
  const root = tree();
  const choices = videoSoundtrackSources(composePlan([root], { media: "all" }));
  expect(choices.map(node => [node.source.author.handle, node.media[0]!.ref])).toEqual([["author200", "1.2"], ["author300", "1.3"]]);
  expect(videoSoundtrackSources(composePlan([root], { media: "all", videoFrames: ["1.2"] })).flatMap(node => node.media).map(asset => asset.ref)).toEqual(["1.3"]);
  expect(videoSoundtrackSources(composePlan([root], { quoteDepth: 0 }))).toEqual([]);
});

test("browser media edits preserve hidden soundtrack owners and select original audio alone", async () => {
  const { mediaSelectionPolicy, revisePlan } = await import("../extension/src/core.ts");
  const hidden = composePlan([tree()], { quoteDepth: 0, audio: "1.2" });
  const edited = revisePlan(hidden, { policy: mediaSelectionPolicy(hidden, "1.1", false) });
  expect(edited.policy.audio).toBe("1.2"); expect(edited.policy.selectedMedia).toEqual(["1.2"]);
  expect(revisePlan(edited, { policy: { quoteDepth: 2 } }).block.selectedMedia).toEqual(["1.2"]);
  const queued = await Bun.file(new URL("./fixtures/quoted-av-legacy-plans.json", import.meta.url)).json();
  const audio = queued[1].sources[0].quote;
  const full = composePlan([assignMediaRefs(post("100", [image("100")], audio), 0)]);
  const ref = mediaSources(full.sources).flatMap(node => node.media).find(asset => asset.kind === "audio")!.ref;
  const original = revisePlan(full, { policy: mediaSelectionPolicy(full, ref, true) });
  expect(original.block.kind).toBe("audio"); expect(original.block.selectedMedia).toEqual([ref]);
  const visual = revisePlan(original, { policy: mediaSelectionPolicy(original, "1.1", true) });
  expect(visual.block.selectedMedia).toEqual(["1.1"]); expect(visual.block.kind).toBe("link");
});

test("receiver snapshots and local journals retain original quoted audiovisual evidence without dropping fields", async () => {
  const { userConfigSchema } = await import("../src/config.ts"), { prepareSaveIntent, saveSnapshotSchema } = await import("../src/save-intent.ts");
  const { ArenaBlockStore } = await import("../src/store.ts"), { mkdtemp, rm } = await import("node:fs/promises"), { join } = await import("node:path"), { tmpdir } = await import("node:os");
  const original = await Bun.file(new URL("./fixtures/substack-quoted-mixed-public-plan.json", import.meta.url)).json();
  const queued = await Bun.file(new URL("./fixtures/quoted-av-legacy-plans.json", import.meta.url)).json();
  const plans = [original, composePlan(queued[1].sources.map(assignMediaRefs), { media: "audio" })];
  const dir = await mkdtemp(join(tmpdir(), "quoted-av-receiver-")), store = new ArenaBlockStore(join(dir, "journal.sqlite"));
  try {
    for (const plan of plans) {
      const config = userConfigSchema.parse({ remoteInbox: { channel: "901", mode: "always" }, provenance: { remoteSnapshot: "full" } });
      const intent = prepareSaveIntent(plan, config, { origin: "cli", initiator: { kind: "human" }, destinations: ["901"], operation: "publish" });
      expect(saveSnapshotSchema.parse(JSON.parse(JSON.stringify(intent.snapshot))).plan).toEqual(plan);
      store.savePlan(plan); expect(store.plan(plan.hash)?.plan).toEqual(plan);
    }
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
