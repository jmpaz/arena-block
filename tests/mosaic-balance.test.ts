import { expect, test } from "bun:test";
import { createDocument } from "@mixmark-io/domino";
import { composePlan, planHash, reviseMosaicLayout } from "../packages/core/compose.ts";
import { blockPlanSchema, compositionPolicySchema, type MediaAsset, type ResolvedPost, type LayoutNode } from "../packages/core/types.ts";
import { captureLayoutPreview, captureRenderRecipe, tileRects, MosaicLayoutError } from "../packages/core/render-recipe.ts";
import { requireRetainedCompositionPolicy, requiredCompositionCapabilities } from "../packages/core/composition-capabilities.ts";
import { requiredPlanCapabilities } from "../src/plan-capabilities.ts";
import { renderLayoutPreview } from "../extension/src/mosaic-preview.ts";
const asset = (ref: string, kind: "image" | "video", width: number, height: number): MediaAsset => ({ ref, kind, width, height,
  url: `https://media.example.test/${ref}.${kind === "video" ? "mp4" : "jpg"}`, ...(kind === "video" ? { posterUrl: `https://media.example.test/${ref}-poster.jpg`, durationSeconds: 15 } : {}), alt: "" });
const source = (media: MediaAsset[], index = 1): ResolvedPost => ({ provider: "x", id: String(index), canonicalUrl: `https://x.com/fixture/status/${index}`, author: { handle: "fixture" }, text: "Original writing", media });
const mixed = () => [asset("1.1", "image", 1200, 625), asset("2.1", "video", 1920, 1080), asset("3.1", "video", 1920, 660), asset("4.1", "video", 1920, 1080), asset("5.1", "image", 1200, 308)].map((a, i) => source([a], i + 1));
const leaves = (n: LayoutNode): string[] => n.kind === "media" ? [n.ref] : n.children.flatMap(leaves);
const share = (plan: ReturnType<typeof composePlan>, ref: string) => {
  const preview = captureLayoutPreview(plan)!; const tile = preview.tiles.find(t => t.ref === ref)!;
  return tile.rect.width * tile.rect.height / (preview.width * preview.height);
};

test("default repairs a dominant middle video with source-order rows and a natural canvas", () => {
  const posts = mixed(), before = JSON.stringify(posts), compact = composePlan(posts, { media: "all", mosaicLayout: "compact" }), plan = composePlan(posts, { media: "all" });
  expect(share(compact, "4.1")).toBeGreaterThan(0.55);
  expect(share(plan, "4.1")).toBeLessThan(0.2);
  expect(captureLayoutPreview(plan)).toMatchObject({ width: 1920, height: 1422 });
  expect(leaves(plan.block.layout!)).toEqual(plan.block.selectedMedia);
  expect(plan.sources).toEqual(posts); expect(JSON.stringify(posts)).toBe(before);
  expect(plan.block.markdown).toBe(compact.block.markdown);
  expect(composePlan(posts, { media: "all" })).toEqual(plan);
  expect(plan.policy.mosaicLayout).toBeUndefined();
});

test("balanced can use columns for a portrait map and paired details; source order uses rows", () => {
  const post = source([asset("1.1", "image", 946, 2048), asset("1.2", "image", 1105, 814), asset("1.3", "image", 1005, 909)]);
  const balanced = composePlan([post], { media: "all" });
  expect(share(balanced, "1.3")).toBeLessThan(0.5);
  expect(balanced.block.layout).toMatchObject({ kind: "split", axis: "horizontal", children: [{ kind: "media", ref: "1.1" }, { kind: "split", axis: "vertical" }] });
  const rows = reviseMosaicLayout(balanced, "source-order");
  expect(leaves(rows.block.layout!)).toEqual(balanced.block.selectedMedia);
  expect(rows.block.layout).not.toEqual(balanced.block.layout);
});

test("already balanced image and video groups retain their geometry and legacy hashes", () => {
  for (const media of [[asset("1.1", "image", 400, 800), asset("1.2", "image", 400, 800), asset("1.3", "image", 400, 800)],
    [asset("1.1", "video", 2256, 1504), asset("1.2", "video", 2256, 1504), asset("1.3", "image", 1502, 424)]]) {
    const plan = composePlan([source(media)], { media: "all" }), compact = reviseMosaicLayout(plan, "compact");
    expect(plan.block.layout).toEqual(compact.block.layout);
    const { hash: _hash, ...body } = compact; const { mosaicLayout: _mode, ...policy } = body.policy;
    expect(planHash({ ...body, policy })).toBe(plan.hash);
  }
});

test("changing only layout keeps frozen content, sources, choices, frame URLs and soundtrack", () => {
  const original = composePlan(mixed(), { media: "all", videoFrames: ["2.1"], videoMotion: ["4.1"], audio: "3.1" });
  const { hash: _hash, ...body } = original; body.block.title = "Edited title"; body.block.markdown = "Edited writing"; body.block.description = "Edited description";
  const edited = { ...body, hash: planHash(body) }, before = JSON.stringify(edited);
  for (const mode of ["balanced", "source-order", "compact"] as const) {
    const next = reviseMosaicLayout(edited, mode), { layout: _a, ...a } = next.block, { layout: _b, ...b } = edited.block;
    expect(a).toEqual(b); expect(next.sources).toEqual(edited.sources);
    expect(next.policy).toEqual({ ...edited.policy, mosaicLayout: mode });
    expect(blockPlanSchema.parse(next)).toEqual(next);
  }
  expect(JSON.stringify(edited)).toBe(before);
  expect(() => reviseMosaicLayout({ ...edited, hash: "a".repeat(64) }, "balanced")).toThrow("hash");
});

test("explicit media order keeps complete row-major selection order", () => {
  const posts = mixed(), order = posts.flatMap(p => p.media.map(a => a.ref)).reverse();
  for (const mode of ["balanced", "source-order"] as const) {
    const plan = composePlan(posts, { media: "all", mediaOrder: order, mosaicLayout: mode });
    expect(leaves(plan.block.layout!)).toEqual(order);
    const tiles = captureLayoutPreview(plan)!.tiles;
    expect([...tiles].sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x).map(t => t.ref)).toEqual(order);
  }
});

test("selected quote media retain their source ownership and row-major order when balancing or revising", () => {
  const post = source([asset("1.1", "image", 946, 2048)]);
  post.quote = { ...source([asset("1.2", "image", 1105, 814), asset("1.3", "image", 1005, 909)], 2), text: "Quoted writing" };
  const before = JSON.stringify(post);
  const plan = composePlan([post], { media: "selected", selectedMedia: ["1.1", "1.2", "1.3"] });
  for (const mode of ["balanced", "source-order"] as const) {
    const revised = reviseMosaicLayout(plan, mode);
    const tiles = captureLayoutPreview(revised)!.tiles;
    expect([...tiles].sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x).map(t => t.ref)).toEqual(plan.block.selectedMedia);
    expect(revised.sources).toEqual(plan.sources); expect(revised.block.markdown).toBe(plan.block.markdown);
  }
  expect(JSON.stringify(post)).toBe(before);
});

test("layout posters use render geometry without audio probes or source mutation", () => {
  const plan = composePlan(mixed(), { media: "all", audio: "3.1" }), before = JSON.stringify(plan);
  const probes = Object.fromEntries(plan.sources.flatMap(s => s.media.filter(a => a.kind === "video").map(a => [a.ref, { width: a.width!, height: a.height!, duration: 15, fps: 30, audio: true }])));
  const preview = captureLayoutPreview(plan)!, rendered = captureRenderRecipe(plan, probes)!;
  expect({ width: preview.width, height: preview.height }).toEqual({ width: rendered.width, height: rendered.height });
  expect(preview.tiles.map(t => t.rect)).toEqual(rendered.tiles.map(t => t.rect));
  expect(preview.tiles.find(t => t.ref === "3.1")!.url).toEndWith("-poster.jpg");
  expect(JSON.stringify(plan)).toBe(before);
});

test("browser preview retains cells for unavailable posters and labels still previews", () => {
  const posts = mixed(); delete posts[1]!.media[0]!.posterUrl;
  const plan = composePlan(posts, { media: "all" });
  const root = createDocument("").createElement("div") as unknown as HTMLElement;
  renderLayoutPreview(root, plan);
  expect(root.hidden).toBe(false); expect(root.querySelectorAll(".mosaic-layout-tile")).toHaveLength(5);
  expect(root.querySelectorAll("img")).toHaveLength(4); expect(root.textContent).toContain("videos shown as posters"); expect(root.textContent).toContain("preview unavailable");
  expect(root.querySelector("img")!.getAttribute("referrerpolicy")).toBe("no-referrer");
});

test("layout choice is optional for retained schemas, validated and capability-gated when explicit", () => {
  expect(compositionPolicySchema.parse({}).mosaicLayout).toBeUndefined();
  expect(() => compositionPolicySchema.parse({ mosaicLayout: "model" })).toThrow();
  const plan = composePlan(mixed(), { media: "all", mosaicLayout: "source-order" });
  expect(requiredPlanCapabilities(plan)).toContain("mosaic-layout-v1");
  expect(requiredCompositionCapabilities({ policy: { mosaicLayout: "compact" } })).toContain("mosaic-layout-v1");
  expect(() => requireRetainedCompositionPolicy({ policy: { mosaicLayout: "compact" } }, plan)).toThrow("mosaic layout choice");
});

test("an older receiver refuses an explicit layout choice before any publication request", async () => {
  const { ArenaBlockClient } = await import("../src/client.ts");
  const plan = composePlan(mixed(), { media: "all", mosaicLayout: "source-order" }), requests: string[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(`${init?.method ?? "GET"} ${new URL(String(input)).pathname}`);
    return Response.json({ version: "0.1.0", revision: "older", sourceId: "fixture", platform: "test", schemaVersion: 1, packagePath: null, planCapabilities: ["video-representation-v2"] });
  }) as typeof fetch;
  await expect(new ArenaBlockClient("https://receiver.invalid", "fixture", fetcher).publish(plan, ["901"])).rejects.toThrow("mosaic-layout-v1");
  expect(requests).toEqual(["GET /v1/version"]);
});

test("geometry stays bounded with at most two percent aspect rounding across diverse shapes and selections", () => {
  for (let n = 2; n <= 25; n++) {
    const media = Array.from({ length: n }, (_, i) => asset(`1.${i + 1}`, i % 3 ? "image" : "video", [640, 1080, 1920][i % 3]!, [1280, 720, 1080, 1500][i % 4]!));
    for (const mode of ["balanced", "source-order"] as const) {
      const plan = composePlan([source(media)], { media: "all", mosaicLayout: mode });
      const g = tileRects(plan.block.layout!, new Map(media.map(a => [a.ref, a])), 1920, 120);
      expect([...g.rects.keys()].sort()).toEqual(media.map(a => a.ref).sort());
      for (const item of media) {
        const r = g.rects.get(item.ref)!;
        expect(r.x).toBeGreaterThanOrEqual(0); expect(r.y).toBeGreaterThanOrEqual(0);
        expect(r.x + r.width).toBeLessThanOrEqual(g.size.width); expect(r.y + r.height).toBeLessThanOrEqual(g.size.height);
        expect(Math.min(r.width, r.height)).toBeGreaterThanOrEqual(120);
        expect(Math.abs(r.width / r.height / (item.width! / item.height!) - 1)).toBeLessThan(0.02);
      }
    }
  }
});

test("impossible source-order rows report the size constraint instead of changing selection", () => {
  const posts = [source([asset("1.1", "image", 1, 100000), asset("1.2", "image", 100000, 1)])];
  expect(() => composePlan(posts, { media: "all", mosaicLayout: "source-order" })).toThrow(MosaicLayoutError);
});
