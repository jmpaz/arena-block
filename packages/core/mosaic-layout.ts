import type { CompositionPolicy, LayoutNode, MediaAsset } from "./types.ts";
import { combineAspects, mediaAspect, tileRects, even, IMAGE_RECIPE_LONG_EDGE, IMAGE_RECIPE_MIN_TILE, VIDEO_RECIPE_LONG_EDGE, VIDEO_RECIPE_MIN_TILE, MosaicLayoutError } from "./render-recipe.ts";

type Candidate = { node: LayoutNode; aspect: number; rows: boolean };
const MAX_ITEMS = 100;
const VIDEO_AREA_WEIGHT = 1.2;
// This wide band is a repair trigger, not a claim about each source's importance.
const MIN_RELATIVE_AREA = 0.3;
const MAX_RELATIVE_AREA = 2;
const CANVAS_ASPECT_COST = 0.35;
const COLUMN_ORDER_COST = 0.05;

function aspect(node: LayoutNode, assets: Map<string, MediaAsset>): number {
  return node.kind === "media" ? mediaAspect(assets.get(node.ref))
    : combineAspects(node.axis, node.children.map(child => aspect(child, assets)));
}

function lines(media: MediaAsset[], columns: number, axis: "horizontal" | "vertical", raggedFirst: boolean): Candidate {
  const sizes: number[] = [];
  let remaining = media.length;
  const remainder = media.length % columns;
  if (raggedFirst && remainder) { sizes.push(remainder); remaining -= remainder; }
  while (remaining > 0) { const count = Math.min(columns, remaining); sizes.push(count); remaining -= count; }
  let offset = 0;
  const groups = sizes.map(count => {
    const first = offset; offset += count;
    const children = media.slice(first, offset).map(item => ({ kind: "media" as const, ref: item.ref }));
    return children.length === 1 ? children[0]! : { kind: "split" as const, axis, children };
  });
  const node: LayoutNode = groups.length === 1 ? groups[0]! : {
    kind: "split", axis: axis === "horizontal" ? "vertical" : "horizontal", children: groups,
  };
  return { node, aspect: aspect(node, new Map(media.map(item => [item.ref, item]))), rows: axis === "horizontal" };
}

export function balancedMosaicLayout(media: MediaAsset[], preferred: LayoutNode,
  mode: CompositionPolicy["mosaicLayout"] = "balanced", ordered = false): LayoutNode {
  if (mode === "source-order" && media.length > MAX_ITEMS) throw new MosaicLayoutError("Source-order mosaics support at most 100 selected items.");
  if (mode === "compact" || media.length < 2 || media.length > MAX_ITEMS
    || media.some(item => !["image", "video"].includes(item.kind))) return preferred;
  if (mode === "balanced" && media.some(item => !item.width || !item.height)) return preferred;
  const assets = new Map(media.map(item => [item.ref, item]));
  const video = media.some(item => item.kind === "video");
  const native = Math.max(0, ...media.map(item => Math.max(item.width ?? 0, item.height ?? 0)));
  const longEdge = video ? even(Math.min(VIDEO_RECIPE_LONG_EDGE, native || VIDEO_RECIPE_LONG_EDGE)) : IMAGE_RECIPE_LONG_EDGE;
  const minTile = video ? VIDEO_RECIPE_MIN_TILE : IMAGE_RECIPE_MIN_TILE;
  const weights = media.map(item => video && item.kind === "video" ? VIDEO_AREA_WEIGHT : 1);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  function measure(candidate: Candidate) {
    if (candidate.aspect < 0.25 || candidate.aspect > 4) return undefined;
    const { rects } = tileRects(candidate.node, assets, longEdge, 0);
    if ([...rects.values()].some(rect => Math.min(rect.width, rect.height) < minTile)) return undefined;
    const areas = media.map(item => { const rect = rects.get(item.ref)!; return rect.width * rect.height; });
    const total = areas.reduce((sum, area) => sum + area, 0);
    const relative = areas.map((area, index) => area / total / (weights[index]! / totalWeight));
    const error = relative.reduce((sum, value) => sum + Math.log(value) ** 2, 0) / relative.length;
    return { balanced: relative.every(value => value >= MIN_RELATIVE_AREA && value <= MAX_RELATIVE_AREA),
      cost: error + CANVAS_ASPECT_COST * Math.log(candidate.aspect) ** 2 + (candidate.rows ? 0 : COLUMN_ORDER_COST) };
  }
  const original: Candidate = { node: preferred, aspect: aspect(preferred, assets), rows: ordered };
  const current = measure(original);
  if (mode === "balanced" && current?.balanced) return preferred;
  const candidates: Candidate[] = [];
  for (let count = 1; count <= media.length; count++) {
    for (const raggedFirst of [false, true]) {
      candidates.push(lines(media, count, "horizontal", raggedFirst));
      if (mode !== "source-order" && !ordered) candidates.push(lines(media, count, "vertical", raggedFirst));
    }
  }
  let best: { node: LayoutNode; cost: number; balanced: boolean } | undefined;
  for (const candidate of candidates) {
    const result = measure(candidate);
    if (result && (!best || result.balanced && !best.balanced
      || result.balanced === best.balanced && result.cost < best.cost)) best = { node: candidate.node, ...result };
  }
  if (!best) {
    if (mode === "source-order") throw new MosaicLayoutError("No source-order arrangement was found within the tile-size limits. Choose fewer items or another mosaic layout.");
    return preferred;
  }
  return mode === "source-order" || !current || best.balanced && !current.balanced || best.cost < current.cost ? best.node : preferred;
}
