import { createHash } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { createCanvas, loadImage, type Image } from "@napi-rs/canvas";
import type { BlockPlan, MediaAsset } from "./types.ts";
import type { Rect, Size } from "../packages/core/render-recipe.ts";

export type MosaicMode = "reading" | "wallpaper";
export type PreviewOptions = { mode: MosaicMode; canvas?: Size; minScale?: number; signal?: AbortSignal };
export type PreviewTile = { ref: string; rect: Rect; source: Size; scale: number };
export type PreviewPage = Size & { tiles: PreviewTile[] };
export type PreviewManifest = {
  version: 1; planHash: string; mode: MosaicMode; selectedRefs: string[];
  sourcePixels: number; minScale: number; cropped: false; warnings: string[];
  pages: Array<PreviewPage & { file: string; sha256: string; bytes: number }>;
};
const PADDING = 48;
const GAP = 32;
const MAX_CANVAS_PIXELS = 32 * 1024 * 1024;
const MAX_SOURCE_PIXELS = 64 * 1024 * 1024;
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;

/** Inspect supported raster headers before native decoding can allocate pixels. */
export function previewImageSize(bytes: Uint8Array): Size {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (start: number, length: number) => String.fromCharCode(...bytes.slice(start, start + length));
  if (bytes.length >= 24 && ascii(1, 3) === "PNG" && ascii(12, 4) === "IHDR") return { width: view.getUint32(16), height: view.getUint32(20) };
  if (bytes.length >= 10 && ["GIF87a", "GIF89a"].includes(ascii(0, 6))) return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  if (bytes.length >= 30 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    const kind = ascii(12, 4);
    if (kind === "VP8X") return { width: 1 + bytes[24]! + (bytes[25]! << 8) + (bytes[26]! << 16), height: 1 + bytes[27]! + (bytes[28]! << 8) + (bytes[29]! << 16) };
    if (kind === "VP8 ") return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
    if (kind === "VP8L" && bytes[20] === 0x2f) { const bits = view.getUint32(21, true); return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) }; }
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset < bytes.length) {
      if (bytes[offset++] !== 0xff) break;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda || marker === undefined) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
      if (offset + 2 > bytes.length) break;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 7) {
        return { width: view.getUint16(offset + 5), height: view.getUint16(offset + 3) };
      }
      offset += length;
    }
  }
  throw new Error("Bounded preview requires a valid JPEG, PNG, GIF or WebP image header; normal rendering remains available for other formats");
}

function validateSelection(items: MediaAsset[]): void {
  if (!items.length || items.length > 100) throw new Error("Preview requires 1–100 selected images");
  if (new Set(items.map(item => item.ref)).size !== items.length) throw new Error("Duplicate selected image reference");
  if (items.some(item => item.kind !== "image")) throw new Error("Reading and wallpaper previews currently require images; use the normal renderer for video");
}
function validateSettings(size: Size, minScale: number): void {
  if (!Number.isFinite(minScale) || minScale < 0.1 || minScale > 4) throw new Error("Minimum source scale must be between 0.1 and 4");
  if (![size.width, size.height].every(value => Number.isInteger(value) && value >= 256 && value <= 16384)
      || size.width * size.height > MAX_CANVAS_PIXELS) throw new Error("Preview canvas exceeds the bounded pixel budget");
}
function validate(items: MediaAsset[], size: Size, minScale: number): void {
  validateSelection(items); validateSettings(size, minScale);
  for (const item of items) {
    if (item.kind !== "image") throw new Error("Reading and wallpaper previews currently require images; use the normal renderer for video");
    if (![item.width, item.height].every(value => Number.isInteger(value) && value! > 0)) throw new Error(`Missing decoded dimensions for ${item.ref}`);
  }
  if (items.reduce((sum, item) => sum + item.width! * item.height!, 0) > MAX_SOURCE_PIXELS) throw new Error("Selected originals exceed the bounded decoded pixel budget");
}

/** Keep every source pixel at the requested scale, in source order. Never crop or silently shrink. */
export function readingPages(items: MediaAsset[], size: Size = { width: 4096, height: 4096 }, minScale = 1): PreviewPage[] {
  validate(items, size, minScale);
  const pages: PreviewPage[] = [];
  let page: PreviewPage = { ...size, tiles: [] };
  let row: PreviewTile[] = [], rowWidth = 0, rowHeight = 0, y = PADDING;
  function flushRow() {
    if (!row.length) return;
    if (y + rowHeight > size.height - PADDING) {
      pages.push(page); page = { ...size, tiles: [] }; y = PADDING;
    }
    let x = Math.round((size.width - rowWidth) / 2);
    for (const tile of row) {
      tile.rect.x = x; tile.rect.y = y;
      page.tiles.push(tile); x += tile.rect.width + GAP;
    }
    y += rowHeight + GAP;
    row = []; rowWidth = 0; rowHeight = 0;
  }
  for (const item of items) {
    const width = Math.ceil(item.width! * minScale), height = Math.ceil(item.height! * minScale);
    if (width > size.width - PADDING * 2 || height > size.height - PADDING * 2) {
      throw new Error(`Image ${item.ref} needs at least ${width + PADDING * 2}x${height + PADDING * 2} at source scale ${minScale}; choose a larger canvas or an explicit smaller --min-scale. Pagination preserves the scale; it cannot shrink this image.`);
    }
    if (row.length && rowWidth + GAP + width > size.width - PADDING * 2) flushRow();
    row.push({ ref: item.ref, source: { width: item.width!, height: item.height! }, scale: minScale, rect: { x: 0, y: 0, width, height } });
    rowWidth += (row.length > 1 ? GAP : 0) + width; rowHeight = Math.max(rowHeight, height);
  }
  flushRow(); if (page.tiles.length) pages.push(page);
  return pages;
}

/** A complete, uncropped wallpaper overview. Source text may require the reading pages. */
export function wallpaperPage(items: MediaAsset[], size: Size = { width: 1440, height: 2560 }): PreviewPage {
  validate(items, size, 1);
  const padding = Math.min(PADDING, Math.floor(size.width / 30));
  const gap = Math.min(GAP, Math.floor(size.width / 90));
  const usable = size.width - padding * 2;
  let best: Array<{ first: number; last: number; height: number }> = [], bestCost = Infinity;
  for (let target = 180; target <= 1000; target += 20) {
    const costs = Array(items.length + 1).fill(Infinity), choices = Array(items.length + 1).fill(0);
    costs[items.length] = 0;
    for (let first = items.length - 1; first >= 0; first--) {
      let ratio = 0;
      for (let count = 1; count <= Math.min(4, items.length - first); count++) {
        const item = items[first + count - 1]!; ratio += item.width! / item.height!;
        const height = (usable - (count - 1) * gap) / ratio;
        const cost = Math.log(height / target) ** 2 + costs[first + count]!;
        if (cost < costs[first]) { costs[first] = cost; choices[first] = count; }
      }
    }
    const rows: typeof best = [];
    for (let first = 0; first < items.length;) {
      const last = first + choices[first]!;
      const ratio = items.slice(first, last).reduce((sum, item) => sum + item.width! / item.height!, 0);
      rows.push({ first, last, height: (usable - (last - first - 1) * gap) / ratio }); first = last;
    }
    const totalHeight = rows.reduce((sum, row) => sum + row.height, 0) + gap * (rows.length - 1);
    const cost = Math.abs(Math.log(totalHeight / (size.height - padding * 2))) + costs[0]! / 20;
    if (cost < bestCost) { best = rows; bestCost = cost; }
  }
  const totalHeight = best.reduce((sum, row) => sum + row.height, 0) + gap * (best.length - 1);
  const fit = Math.min(1, (size.height - padding * 2) / totalHeight);
  let y = (size.height - totalHeight * fit) / 2;
  const tiles: PreviewTile[] = [];
  for (const row of best) {
    let x = (size.width - usable * fit) / 2;
    for (const item of items.slice(row.first, row.last)) {
      const height = row.height * fit, width = height * item.width! / item.height!;
      tiles.push({ ref: item.ref, source: { width: item.width!, height: item.height! }, scale: width / item.width!, rect: { x, y, width, height } });
      x += width + gap * fit;
    }
    y += (row.height + gap) * fit;
  }
  return { ...size, tiles };
}

export async function renderMosaicPreview(plan: BlockPlan, directory: string, options: PreviewOptions,
  acquire?: (asset: MediaAsset) => Promise<Uint8Array>): Promise<PreviewManifest> {
  const assets = new Map(plan.sources.flatMap(post => post.media).map(asset => [asset.ref, asset]));
  const selected = plan.block.selectedMedia.map(ref => {
    const item = assets.get(ref); if (!item) throw new Error(`Missing selected image ${ref}`); return item;
  });
  if (!["reading", "wallpaper"].includes(options.mode)) throw new Error("Unknown preview layout");
  validateSelection(selected);
  if (options.mode === "wallpaper" && options.minScale !== undefined) throw new Error("Minimum source scale applies to reading pages");
  validateSettings(options.canvas ?? (options.mode === "reading" ? { width: 4096, height: 4096 } : { width: 1440, height: 2560 }), options.minScale ?? 1);
  const images = new Map<string, Image>();
  const decoded: MediaAsset[] = [];
  let sourcePixels = 0;
  for (const item of selected) {
    options.signal?.throwIfAborted();
    if (item.kind !== "image") throw new Error("Reading and wallpaper previews currently require images");
    let bytes: Uint8Array;
    if (acquire) bytes = await acquire(item);
    else {
      const url = new URL(item.url);
      if (url.protocol !== "https:" || url.username || url.password) throw new Error("Preview media must use public HTTPS URLs");
      const deadline = AbortSignal.timeout(30_000);
      const response = await fetch(url, { redirect: "error", credentials: "omit", signal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline });
      if (!response.ok) throw new Error(`Image ${item.ref} download returned ${response.status}`);
      const reader = response.body?.getReader(); if (!reader) throw new Error(`Image ${item.ref} has no body`);
      const chunks: Uint8Array[] = []; let length = 0;
      try { while (true) { const { done, value } = await reader.read(); if (done) break;
        length += value.length; if (length > MAX_SOURCE_BYTES) throw new Error(`Image ${item.ref} exceeds the source byte budget`); chunks.push(value); }
      } finally { await reader.cancel(); }
      bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    }
    if (bytes.length > MAX_SOURCE_BYTES) throw new Error(`Image ${item.ref} exceeds the source byte budget`);
    const header = previewImageSize(bytes);
    if (!(header.width > 0 && header.height > 0) || sourcePixels + header.width * header.height > MAX_SOURCE_PIXELS) throw new Error("Selected originals exceed the bounded decoded pixel budget");
    const image = await loadImage(bytes);
    const same = image.width === header.width && image.height === header.height;
    const oriented = image.width === header.height && image.height === header.width;
    if (!same && !oriented) throw new Error(`Image ${item.ref} decoded dimensions differ from its bounded header`);
    sourcePixels += image.width * image.height;
    if (sourcePixels > MAX_SOURCE_PIXELS) throw new Error("Selected originals exceed the bounded decoded pixel budget");
    decoded.push({ ...item, width: image.width, height: image.height }); images.set(item.ref, image);
  }
  const pages = options.mode === "reading" ? readingPages(decoded, options.canvas, options.minScale ?? 1) : [wallpaperPage(decoded, options.canvas)];
  const manifest: PreviewManifest = { version: 1, planHash: plan.hash, mode: options.mode, selectedRefs: selected.map(item => item.ref), sourcePixels,
    minScale: Math.min(...pages.flatMap(page => page.tiles.map(tile => tile.scale))), cropped: false,
    warnings: options.mode === "wallpaper" ? ["Complete wallpaper overview; small source text requires the reading pages. No text-legibility guarantee is made for this overview."] : [], pages: [] };
  // A private staging directory keeps cancellation/failure from leaving a misleading completed set.
  const run = `${options.mode}-${plan.hash.slice(0, 12)}-${crypto.randomUUID()}`;
  const staging = join(directory, `.preview-${run}`);
  await mkdir(staging, { recursive: true });
  try {
    for (let i = 0; i < pages.length; i++) {
      options.signal?.throwIfAborted();
      const page = pages[i]!, canvas = createCanvas(page.width, page.height), context = canvas.getContext("2d");
      context.fillStyle = "#ece9e3"; context.fillRect(0, 0, page.width, page.height);
      for (const tile of page.tiles) context.drawImage(images.get(tile.ref)!, tile.rect.x, tile.rect.y, tile.rect.width, tile.rect.height);
      const bytes = await canvas.encode("jpeg", 95);
      if (bytes.length > MAX_SOURCE_BYTES) throw new Error("Preview page exceeds 20 MiB; choose a smaller canvas or more pages");
      const sha256 = createHash("sha256").update(bytes).digest("hex"), file = `${options.mode}-${String(i + 1).padStart(2, "0")}-${sha256.slice(0, 12)}.jpg`;
      await Bun.write(join(staging, file), bytes); manifest.pages.push({ ...page, file, sha256, bytes: bytes.length });
    }
    options.signal?.throwIfAborted();
    // Commit the complete owned run with one directory rename. Existing files in
    // the caller's output directory are never replaced or used as a manifest.
    for (const page of manifest.pages) page.file = `${run}/${page.file}`;
    await Bun.write(join(staging, "manifest.json"), JSON.stringify(manifest, null, 2));
    options.signal?.throwIfAborted();
    await rename(staging, join(directory, run));
    return manifest;
  } finally { await rm(staging, { recursive: true, force: true }); }
}
