import type { CompositionPolicy, LayoutNode, MediaAsset, MediaKind } from "./types.ts";
import { mediaSources, planMedia } from "./media-tree.ts";
import { renderedQuoteDepth } from "./quote-policy.ts";

export type Rect = { x: number; y: number; width: number; height: number };
export type Size = { width: number; height: number };
export type Probe = Size & { duration: number; fps: number; audio: boolean };
export type Tile = { path: string; kind: MediaKind; rect: Rect };
export type Mosaic = Size & { fps: number; duration: number; bitrate: number; audio?: number[]; tiles: Tile[] };
type Staged = { item: MediaAsset; path: string; probe?: Probe };
export const IMAGE_RECIPE_LONG_EDGE = 4096;
export const IMAGE_RECIPE_MIN_TILE = 256;
export const VIDEO_RECIPE_LONG_EDGE = 1920;
export const VIDEO_RECIPE_MIN_TILE = 120;
export class MosaicLayoutError extends Error { readonly code = "media_budget"; }

export function mediaAspect(item: MediaAsset | undefined): number {
  return item?.width && item.height ? item.width / item.height : 1;
}

export function combineAspects(axis: "horizontal" | "vertical", values: number[]): number {
  const bounded = values.map((value) => Math.max(0.05, value));
  return axis === "horizontal"
    ? bounded.reduce((sum, value) => sum + value, 0)
    : 1 / bounded.reduce((sum, value) => sum + 1 / value, 0);
}

function aspect(node: LayoutNode, assets: Map<string, MediaAsset>): number {
  if (node.kind === "media") return mediaAspect(assets.get(node.ref));
  return combineAspects(node.axis, node.children.map((child) => aspect(child, assets)));
}

export function even(value: number): number {
  return Math.round(value / 2) * 2;
}

function evenRect(rect: Rect): Rect {
  const x = even(rect.x);
  const y = even(rect.y);
  return { x, y, width: even(rect.x + rect.width) - x, height: even(rect.y + rect.height) - y };
}

function rectangles(
  node: LayoutNode,
  rect: Rect,
  assets: Map<string, MediaAsset>,
  output: Map<string, Rect>,
): void {
  if (node.kind === "media") {
    output.set(node.ref, evenRect(rect));
    return;
  }
  const childAspects = node.children.map((child) => aspect(child, assets));
  if (node.axis === "horizontal") {
    const total = childAspects.reduce((sum, value) => sum + value, 0);
    let x = rect.x;
    node.children.forEach((child, index) => {
      const width = index === node.children.length - 1
        ? rect.x + rect.width - x
        : rect.width * (childAspects[index]! / total);
      rectangles(child, { x, y: rect.y, width, height: rect.height }, assets, output);
      x += width;
    });
    return;
  }
  const inverse = childAspects.map((value) => 1 / value);
  const total = inverse.reduce((sum, value) => sum + value, 0);
  let y = rect.y;
  node.children.forEach((child, index) => {
    const height = index === node.children.length - 1
      ? rect.y + rect.height - y
      : rect.height * (inverse[index]! / total);
    rectangles(child, { x: rect.x, y, width: rect.width, height }, assets, output);
    y += height;
  });
}

export function canvasSize(ratio: number, longEdge: number): Size {
  const clamped = Math.min(4, Math.max(0.25, ratio));
  return clamped >= 1
    ? { width: longEdge, height: even(longEdge / clamped) }
    : { width: even(longEdge * clamped), height: longEdge };
}

export function tileRects(
  layout: LayoutNode,
  assets: Map<string, MediaAsset>,
  longEdge: number,
  minTile: number,
): { size: Size; rects: Map<string, Rect> } {
  const size = canvasSize(aspect(layout, assets), longEdge);
  const rects = new Map<string, Rect>();
  rectangles(layout, { x: 0, y: 0, ...size }, assets, rects);
  if ([...rects.values()].some((rect) => Math.min(rect.width, rect.height) < minTile)) {
    throw new MosaicLayoutError(`Mosaic selection is too dense for a legible ${size.width}x${size.height} composition. Create a new composition before publishing; retrying this unchanged layout cannot increase tile sizes. Reading and wallpaper are local image-only previews, not publish options.`);
  }
  return { size, rects };
}

export function explicitAudio(policy: CompositionPolicy): string | undefined {
  return policy.audio === "auto" || policy.audio === "mix" ? undefined : policy.audio;
}

function soundtrack(policy: CompositionPolicy, videos: Array<Probe & { ref: string }>): string[] {
  const explicit = explicitAudio(policy);
  if (explicit) {
    const video = videos.find(item => item.ref === explicit);
    if (!video) throw new Error(`Audio source ${explicit} is not a selected video`);
    if (!video.audio) throw new Error(`Video ${explicit} has no audio`);
    return [explicit];
  }
  const audible = videos.filter(item => item.audio);
  const chosen = policy.audio === "mix" || audible.length < 2 ? audible : [audible.reduce((best, item) => item.duration > best.duration ? item : best)];
  return chosen.map(item => item.ref);
}

export function captureRenderRecipe(plan: import("./types.ts").BlockPlan, probes: Record<string, Probe> = {}) {
  const frames = new Map((plan.block.frameMedia ?? []).map(item => [item.ref, item.url]));
  const assets = new Map(planMedia(plan).map(asset => [asset.ref,
    frames.has(asset.ref) ? { ...asset, kind: "image" as const, url: frames.get(asset.ref)! } : asset]));
  const selected = plan.block.selectedMedia.map(ref => assets.get(ref)).filter((asset): asset is MediaAsset => Boolean(asset));
  if (plan.block.kind === "text" || plan.block.kind === "image" || plan.block.kind === "url") return null;
  if (plan.block.kind === "audio") throw new Error("Original audio attachments are passed through and do not use the visual render recipe");
  if (!selected.length) throw new Error("Media plan selects no media");
  const video = plan.block.kind === "video";
  const dimensions = new Map(selected.map(asset => [asset.ref, probes[asset.ref] ? { ...asset, ...probes[asset.ref] } : asset]));
  const native = Math.max(0, ...[...dimensions.values()].map(asset => Math.max(asset.width ?? 0, asset.height ?? 0)));
  const longEdge = video ? even(Math.min(VIDEO_RECIPE_LONG_EDGE, native || VIDEO_RECIPE_LONG_EDGE)) : IMAGE_RECIPE_LONG_EDGE;
  const layout = plan.block.layout ?? { kind: "media" as const, ref: selected[0]!.ref };
  const geometry = !video && selected.length === 1
    ? { size: { width: dimensions.get(selected[0]!.ref)!.width ?? 0, height: dimensions.get(selected[0]!.ref)!.height ?? 0 }, rects: new Map<string, Rect>() }
    : tileRects(layout, dimensions, longEdge, video ? VIDEO_RECIPE_MIN_TILE : IMAGE_RECIPE_MIN_TILE);
  const videos = selected.filter(asset => asset.kind === "video").map(asset => {
    const probe = probes[asset.ref];
    if (!probe) throw new Error(`Missing video probe for ${asset.ref}`);
    return { ref: asset.ref, ...probe };
  });
  const duration = Math.max(0, ...videos.map(item => item.duration));
  const chosenAudio = explicitAudio(plan.policy);
  const hiddenAudioChoice = chosenAudio && mediaSources(plan.sources).some(node => node.quoteDepth > renderedQuoteDepth(plan.policy)
    && node.media.some(asset => asset.kind === "video" && asset.ref === chosenAudio));
  const audio = soundtrack(hiddenAudioChoice ? { ...plan.policy, audio: "auto" } : plan.policy, videos);
  return {
    kind: plan.block.kind,
    ...geometry.size,
    tiles: selected.map(asset => ({ ref: asset.ref, kind: asset.kind, url: asset.url, rect: geometry.rects.get(asset.ref) ?? { x: 0, y: 0, ...geometry.size } })),
    ...(video ? { duration, fps: Math.min(60, Math.max(...videos.map(item => item.fps))), audio, bitrate: videoBitrate(duration) } : {}),
  };
}

export function videoBitrate(duration: number): number {
  return Math.floor((250 * 1024 * 1024 * 0.9 * 8 - 192_000 * duration) / (duration + 2));
}
