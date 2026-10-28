import { createHash } from "node:crypto";
import { mkdir, readdir, rm, stat, copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createCanvas, loadImage, type Image } from "@napi-rs/canvas";
import type { BlockPlan, LayoutNode, MediaAsset, MediaKind, ResolvedPost } from "./types.ts";
import { parseSource } from "../packages/core/url.ts";
import { mediaSources, planMedia } from "../packages/core/media-tree.ts";
import { blockPlanSchema } from "./types.ts";
import { runYtDlp, type YtDlpRunner } from "./providers/soundcloud.ts";

const FFMPEG = "ffmpeg";
const FFPROBE = "ffprobe";
const USER_AGENT = "arena-block/0.1";
const IMAGE_LONG_EDGE = 4096;
const IMAGE_MIN_TILE = 256;
const IMAGE_LIMIT_BYTES = 20 * 1024 * 1024;
const VIDEO_LONG_EDGE = 1920;
const VIDEO_MIN_TILE = 120;
const VIDEO_MAX_FPS = 60;
const VIDEO_LIMIT_BYTES = 250 * 1024 * 1024;
const VIDEO_LIMIT_HEADROOM = 0.9;
const VIDEO_BUFFER_SECONDS = 2;
const VIDEO_CRF = 20;
const VIDEO_PRESET = "medium";
const VIDEO_MAX_COMPOSE_SECONDS = 600;
const VIDEO_MAX_SOURCE_BYTES = 750 * 1024 * 1024;
export class MediaBudgetError extends Error { readonly code = "media_budget"; }
export class MediaInspectionError extends Error {
  readonly code = "media_inspection";
  constructor(message: string, readonly retryable = false) { super(message); }
}
const AUDIO_BITRATE = 192_000;

export type RenderedMedia = {
  hash: string;
  path: string;
  extension: "jpg" | "mp4" | "mp3" | "m4a" | "wav" | "flac" | "ogg" | "opus" | "aac";
  mimeType: "image/jpeg" | "video/mp4" | "audio/mpeg" | "audio/mp4" | "audio/wav" | "audio/flac" | "audio/ogg" | "audio/opus" | "audio/aac";
  size: number;
};

export type RenderOptions = { signal?: AbortSignal; downloadTimeoutMs?: number; ytDlp?: YtDlpRunner; fetcher?: typeof fetch; maximumAudioBytes?: number };

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void operation.catch(() => {}); return Promise.reject(signal.reason); }
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", abort);
    const abort = () => { cleanup(); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    operation.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

import { captureRenderRecipe, tileRects, even, type Rect, type Size, type Probe, type Mosaic } from "../packages/core/render-recipe.ts";
export type { Rect, Size, Probe, Mosaic, Tile } from "../packages/core/render-recipe.ts";
type Staged = { item: MediaAsset; path: string; probe?: Probe };
export { tileRects, even, canvasSize } from "../packages/core/render-recipe.ts";

function assetMap(plan: BlockPlan): Map<string, MediaAsset> {
  const frames = new Map((plan.block.frameMedia ?? []).map(item => [item.ref, item.url]));
  return new Map(planMedia(plan).map((item) => [item.ref,
    frames.has(item.ref) ? { ...item, kind: "image" as const, url: frames.get(item.ref)! } : item]));
}

function selectedAssets(plan: BlockPlan): MediaAsset[] {
  const assets = assetMap(plan);
  return plan.block.selectedMedia.map(ref => {
    const item = assets.get(ref);
    if (!item) throw new Error(`Selected media is missing from the snapshot: ${ref}`);
    return item;
  });
}

function drawCover(context: ReturnType<ReturnType<typeof createCanvas>["getContext"]>, image: Image, rect: Rect): void {
  const scale = Math.max(rect.width / image.width, rect.height / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  context.drawImage(image, rect.x + (rect.width - width) / 2, rect.y + (rect.height - height) / 2, width, height);
}

async function fetchBytes(url: string, options: RenderOptions): Promise<Uint8Array> {
  const deadline = AbortSignal.timeout(options.downloadTimeoutMs ?? 20_000);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  signal.throwIfAborted();
  const response = await abortable(fetch(url, { signal, headers: { "user-agent": USER_AGENT } }), signal);
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new Error(`Media download returned ${response.status}`);
  }
  if (!response.body) return new Uint8Array();
  const declaredLength = Number(response.headers.get("content-length"));
  if (declaredLength > IMAGE_LIMIT_BYTES) {
    void response.body.cancel().catch(() => {});
    throw new MediaBudgetError("Selected image exceeds the 20 MiB download limit");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await abortable(reader.read(), signal);
      if (part.done) break;
      chunks.push(part.value); size += part.value.byteLength;
      if (size > IMAGE_LIMIT_BYTES) throw new MediaBudgetError("Selected image exceeds the 20 MiB download limit");
    }
  } finally {
    // Do not wait for a stalled source's cancellation acknowledgement.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  signal.throwIfAborted();
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

const FORMAT_MIME: Record<RenderedMedia["extension"], RenderedMedia["mimeType"]> = {
  jpg: "image/jpeg", mp4: "video/mp4", mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav",
  flac: "audio/flac", ogg: "audio/ogg", opus: "audio/ogg", aac: "audio/aac",
};

async function writeContentAddressed(directory: string, extension: RenderedMedia["extension"], bytes: Uint8Array): Promise<RenderedMedia> {
  const hash = createHash("sha256").update(bytes).digest("hex");
  const path = join(directory, hash.slice(0, 2), `${hash}.${extension}`);
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, bytes);
  return {
    hash,
    path,
    extension,
    mimeType: FORMAT_MIME[extension],
    size: bytes.byteLength,
  };
}

type OutputLimit = { path: string; bytes: number; ref: string };

export async function run(argv: string[], signal?: AbortSignal, outputLimit?: OutputLimit): Promise<string> {
  signal?.throwIfAborted();
  const child = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const abort = () => child.kill("SIGKILL");
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  let exceeded = false;
  const monitor = outputLimit && setInterval(() => {
    void stat(outputLimit.path).then(info => {
      if (info.size > outputLimit.bytes) { exceeded = true; child.kill("SIGKILL"); }
    }).catch(() => {}); // The output file may not exist until ffmpeg opens it.
  }, 100);
  const pending = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const [stdout, stderr, status] = await (signal ? abortable(pending, signal) : pending)
    .finally(() => { signal?.removeEventListener("abort", abort); if (monitor) clearInterval(monitor); });
  signal?.throwIfAborted();
  const finalSize = outputLimit ? (await stat(outputLimit.path).catch(() => undefined))?.size : undefined;
  if (outputLimit && (exceeded || (finalSize !== undefined && finalSize > outputLimit.bytes)))
    throw new MediaBudgetError(`Selected video ${outputLimit.ref} exceeded the ${Math.round(outputLimit.bytes / (1024 * 1024))} MiB staging limit; no block creation was attempted`);
  if (status !== 0) throw new Error(`${argv[0]} failed: ${stderr.trim()}`);
  return stdout;
}

function rate(value: unknown): number {
  const [numerator, denominator] = String(value).split("/").map(Number);
  return numerator && denominator ? numerator / denominator : 0;
}

export async function probe(path: string, signal?: AbortSignal): Promise<Probe> {
  const report = JSON.parse(await run([
    FFPROBE, "-v", "error",
    "-show_entries", "stream=codec_type,width,height,avg_frame_rate,r_frame_rate,duration:format=duration",
    "-of", "json", path,
  ], signal));
  const streams: Array<Record<string, unknown>> = Array.isArray(report.streams) ? report.streams : [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const duration = Number(video?.duration) || Number(report.format?.duration);
  if (!video || !(duration > 0)) throw new Error(`No playable video stream in ${path}`);
  return {
    width: Number(video.width),
    height: Number(video.height),
    duration,
    fps: Math.round((rate(video.avg_frame_rate) || rate(video.r_frame_rate) || 30) * 1000) / 1000,
    audio: streams.some((stream) => stream.codec_type === "audio"),
  };
}

/** Reject oversized video compositions before copying gigabytes or starting a long encode. */
export function checkVideoInputBudget(ref: string, duration: number, bytes: number | undefined): void {
  checkKnownVideoBudget(ref, duration, bytes);
  if (!Number.isFinite(duration) || duration <= 0) throw new MediaBudgetError(`Selected video ${ref} has no measurable duration`);
  if (bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) throw new MediaBudgetError(`Selected video ${ref} has no measurable size; no block creation was attempted`);
}

function checkKnownVideoBudget(ref: string, duration?: number, bytes?: number): void {
  if ((duration !== undefined && Number.isFinite(duration) && duration > VIDEO_MAX_COMPOSE_SECONDS)
      || (bytes !== undefined && Number.isFinite(bytes) && bytes > VIDEO_MAX_SOURCE_BYTES)) {
    const details = [duration && Number.isFinite(duration) ? `${Math.round(duration / 60)} minutes` : undefined,
      bytes && Number.isFinite(bytes) ? `${(bytes / (1024 ** 3)).toFixed(2)} GiB` : undefined].filter(Boolean).join(" / ");
    throw new MediaBudgetError(`Selected video ${ref} is ${details}; a media mosaic is bounded to 10 minutes and 750 MiB per video. Select a smaller clip or use text-only capture; no block creation was attempted.`);
  }
}

/** Read only headers before asking ffprobe to seek through a remote video. */
export async function videoHeaderSize(url: string, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<number | undefined> {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return undefined; }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) return undefined;
  const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(5_000)]) : AbortSignal.timeout(5_000);
  const size = (value: string | null): number | undefined => value && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : undefined;
  try {
    const response = await abortable(fetcher(parsed, { method: "HEAD", signal: bounded, redirect: "error", credentials: "omit" }), bounded);
    void response.body?.cancel().catch(() => {});
    if (response.ok) return size(response.headers.get("content-length"));
  } catch { signal?.throwIfAborted(); }
  return undefined;
}

async function preflightVideo(item: MediaAsset, knownBytes: number | undefined, bounded: AbortSignal, callerSignal?: AbortSignal): Promise<{ duration: number; bytes: number }> {
  if (item.durationSeconds && knownBytes) {
    checkVideoInputBudget(item.ref, item.durationSeconds, knownBytes);
    return { duration: item.durationSeconds, bytes: knownBytes };
  }
  let raw: string;
  try { raw = await run([FFPROBE, "-v", "error", "-show_entries", "format=duration,size", "-of", "json", item.url], bounded); }
  catch (error) {
    callerSignal?.throwIfAborted();
    const timedOut = bounded.aborted;
    throw new MediaInspectionError(timedOut
      ? `Selected video ${item.ref} did not answer a bounded 15-second media probe; the same save UUID may be retried after the source responds. No block creation was attempted.`
      : `Selected video ${item.ref} rejected media inspection; check the source before retrying. No block creation was attempted.`, timedOut);
  }
  let format: Record<string, unknown>;
  try { format = JSON.parse(raw).format ?? {}; }
  catch { throw new MediaInspectionError(`Selected video ${item.ref} returned invalid media metadata; no block creation was attempted`); }
  const duration = Number(format.duration) || item.durationSeconds || Number.NaN;
  const size = knownBytes ?? (format.size === undefined ? undefined : Number(format.size));
  checkVideoInputBudget(item.ref, duration, size);
  return { duration, bytes: size! };
}

async function stage(item: MediaAsset, directory: string, options: RenderOptions): Promise<Staged> {
  if (item.kind === "image") {
    const path = join(directory, item.ref);
    await Bun.write(path, await fetchBytes(item.url, options));
    return { item, path };
  }
  const path = join(directory, `${item.ref}.mp4`);
  await run([
    FFMPEG, "-nostdin", "-loglevel", "error",
    "-i", item.url, "-c", "copy", "-sn", "-dn", "-movflags", "+faststart", "-y", path,
  ], options.signal, { path, bytes: VIDEO_MAX_SOURCE_BYTES, ref: item.ref });
  const result = await probe(path, options.signal);
  if (item.acquisition === "substack-public-original") verifyOriginalDuration(item.durationSeconds, result.duration);
  return { item, path, probe: result };
}

function verifyOriginalDuration(expected: number | undefined, actual: number): void {
  if (!(expected && expected > 0) || Math.abs(actual - expected) > Math.max(1, expected * 0.02)) throw new Error("Substack original media duration disagrees with its complete public source; no preview was saved");
}

export { videoBitrate } from "../packages/core/render-recipe.ts";
import { videoBitrate } from "../packages/core/render-recipe.ts";

export function mosaicArguments(mosaic: Mosaic, output: string): string[] {
  const inputs = mosaic.tiles.flatMap((tile) => tile.kind === "video"
    ? ["-stream_loop", "-1", "-i", tile.path]
    : ["-loop", "1", "-framerate", String(mosaic.fps), "-i", tile.path]);
  const scaled = mosaic.tiles.map(({ rect }, index) =>
    `[${index}:v]scale=${rect.width}:${rect.height}:force_original_aspect_ratio=increase,crop=${rect.width}:${rect.height},setsar=1[t${index}]`);
  const overlays = mosaic.tiles.map(({ rect }, index) => `[b${index}][t${index}]overlay=${rect.x}:${rect.y}[b${index + 1}]`);
  const audio = mosaic.audio ?? [];
  const mixed = audio.length > 1
    ? [`${audio.map((index) => `[${index}:a]`).join("")}amix=inputs=${audio.length}:duration=longest[aout]`]
    : [];
  const graph = [
    `color=c=black:s=${mosaic.width}x${mosaic.height}:r=${mosaic.fps}[b0]`,
    ...scaled,
    ...overlays,
    `[b${mosaic.tiles.length}]format=yuv420p[out]`,
    ...mixed,
  ].join(";");
  return [
    "-nostdin", "-loglevel", "error",
    ...inputs,
    "-filter_complex", graph,
    "-map", "[out]",
    ...(audio.length
      ? ["-map", audio.length > 1 ? "[aout]" : `${audio[0]}:a:0`, "-c:a", "aac", "-b:a", String(AUDIO_BITRATE)]
      : ["-an"]),
    "-t", mosaic.duration.toFixed(3),
    "-r", String(mosaic.fps),
    "-c:v", "libx264", "-preset", VIDEO_PRESET, "-crf", String(VIDEO_CRF),
    "-maxrate", String(mosaic.bitrate), "-bufsize", String(mosaic.bitrate * VIDEO_BUFFER_SECONDS),
    "-movflags", "+faststart",
    "-y", output,
  ];
}

async function renderImages(plan: BlockPlan, directory: string, options: RenderOptions): Promise<RenderedMedia> {
  const assets = assetMap(plan);
  const selected = selectedAssets(plan);
  if (selected.length === 1) {
    const image = await loadImage(await fetchBytes(selected[0]!.url, options));
    options.signal?.throwIfAborted();
    const canvas = createCanvas(image.width, image.height);
    canvas.getContext("2d").drawImage(image, 0, 0);
    return writeContentAddressed(directory, "jpg", await canvas.encode("jpeg", 92));
  }
  if (!plan.block.layout) throw new Error("Image plan has no layout");
  const images = new Map<string, Image>();
  await Promise.all(selected.map(async (item) => images.set(item.ref, await loadImage(await fetchBytes(item.url, options)))));
  options.signal?.throwIfAborted();
  // Match native preparation: source metadata can omit image dimensions, so
  // compute tile geometry from the decoded originals before drawing covers.
  for (const [ref, image] of images) assets.set(ref, { ...assets.get(ref)!, width: image.width, height: image.height });
  const { size, rects } = tileRects(plan.block.layout, assets, IMAGE_LONG_EDGE, IMAGE_MIN_TILE);
  const canvas = createCanvas(size.width, size.height);
  const context = canvas.getContext("2d");
  for (const [ref, rect] of rects) {
    const image = images.get(ref);
    if (!image) throw new Error(`Missing decoded media ${ref}`);
    drawCover(context, image, rect);
  }
  const bytes = await canvas.encode("jpeg", 92);
  if (bytes.byteLength > IMAGE_LIMIT_BYTES) throw new Error("Rendered mosaic exceeds 20 MB");
  return writeContentAddressed(directory, "jpg", bytes);
}

/** Local preview only; publication gives Are.na the original artwork URL directly. */
async function renderPlaylistArtwork(plan: BlockPlan, directory: string, options: RenderOptions): Promise<RenderedMedia> {
  if (!plan.block.artworkUrl) throw new Error("SoundCloud playlist Image has no source artwork");
  const image = await loadImage(await fetchBytes(plan.block.artworkUrl, options));
  options.signal?.throwIfAborted();
  const canvas = createCanvas(image.width, image.height);
  canvas.getContext("2d").drawImage(image, 0, 0);
  return writeContentAddressed(directory, "jpg", await canvas.encode("jpeg", 92));
}

async function renderVideo(plan: BlockPlan, directory: string, options: RenderOptions): Promise<RenderedMedia> {
  const assets = assetMap(plan);
  const selected = selectedAssets(plan);
  if (!selected.length) throw new Error("Video plan selects no media");
  const videos = selected.filter(item => item.kind === "video");
  videos.forEach(item => checkKnownVideoBudget(item.ref, item.durationSeconds));
  const videoInputs = await Promise.all(videos.map(async item => {
    // HEAD and any remote probe share one deadline. A slow HEAD cannot add
    // another full probe window to the user's wait.
    const bounded = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
    const bytes = await videoHeaderSize(item.url, bounded);
    checkKnownVideoBudget(item.ref, item.durationSeconds, bytes);
    return preflightVideo(item, bytes, bounded, options.signal);
  }));
  if (videoInputs.reduce((sum, item) => sum + item.duration, 0) > VIDEO_MAX_COMPOSE_SECONDS
    || videoInputs.reduce((sum, item) => sum + item.bytes, 0) > VIDEO_MAX_SOURCE_BYTES)
    throw new MediaBudgetError("Selected videos together exceed 10 minutes or 750 MiB; choose fewer clips or use text-only capture");
  const layout: LayoutNode = plan.block.layout ?? { kind: "media", ref: selected[0]!.ref };
  const staging = join(directory, ".staging", crypto.randomUUID());
  await mkdir(staging, { recursive: true });
  try {
    const staged: Staged[] = [];
    let stagedBytes = 0;
    let stagedVideoSeconds = 0;
    for (const item of selected) {
      const next = await stage(item, staging, options);
      const size = (await stat(next.path)).size;
      stagedBytes += size;
      if (stagedBytes > 1024 * 1024 * 1024) throw new MediaBudgetError("Selected media staging exceeds 1 GiB; choose fewer items");
      if (next.probe) {
        // Provider duration and HTTP length are hints. Enforce the budget from
        // the staged bytes and the actual local probe before encoding.
        checkVideoInputBudget(item.ref, next.probe.duration, size);
        stagedVideoSeconds += next.probe.duration;
        if (stagedVideoSeconds > VIDEO_MAX_COMPOSE_SECONDS)
          throw new MediaBudgetError("Staged videos together exceed 10 minutes; choose fewer clips or use text-only capture; no block creation was attempted");
      }
      staged.push(next);
    }
    const probes = Object.fromEntries(staged.flatMap(({ item, probe }) => probe ? [[item.ref, probe]] : []));
    const recipe = captureRenderRecipe(plan, probes)!;
    const mosaic: Mosaic = {
      width: recipe.width,
      height: recipe.height,
      fps: recipe.fps!,
      duration: recipe.duration!,
      bitrate: recipe.bitrate!,
      ...(recipe.audio?.length ? { audio: recipe.audio.map(ref => staged.findIndex(entry => entry.item.ref === ref)) } : {}),
      tiles: staged.map(({ item, path }) => ({ path, kind: item.kind, rect: recipe.tiles.find(tile => tile.ref === item.ref)!.rect })),
    };
    const output = join(staging, "mosaic.mp4");
    await run([FFMPEG, ...mosaicArguments(mosaic, output)], options.signal);
    const bytes = new Uint8Array(await Bun.file(output).arrayBuffer());
    if (bytes.byteLength > VIDEO_LIMIT_BYTES) {
      throw new Error(`Normalized video is ${bytes.byteLength} bytes, above Are.na's ${VIDEO_LIMIT_BYTES} byte attachment limit`);
    }
    options.signal?.throwIfAborted();
    return writeContentAddressed(directory, "mp4", bytes);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function renderSoundCloudAudio(plan: BlockPlan, directory: string, options: RenderOptions): Promise<RenderedMedia> {
  const owner = selectedAudioSource(plan);
  if (plan.sources.length !== 1 || owner?.provider !== "soundcloud" || owner.soundcloud?.kind !== "track") {
    throw new Error("Audio plan does not identify a public SoundCloud track");
  }
  const source = parseSource(owner.canonicalUrl);
  if (source.provider !== "soundcloud" || source.kind !== "track" || source.canonicalUrl !== owner.canonicalUrl) throw new Error("Audio source is not a canonical public SoundCloud track URL");
  const assets = selectedAssets(plan);
  if (assets.length !== 1 || assets[0]!.kind !== "audio"
    || !["soundcloud-original-download", "soundcloud-mp3"].includes(assets[0]!.acquisition ?? "") || assets[0]!.url !== source.canonicalUrl) {
    throw new Error("Audio plan must select a SoundCloud track download");
  }
  const mp3 = assets[0]!.acquisition === "soundcloud-mp3";
  if (!mp3 && !owner.soundcloud.originalDownloadAvailable) {
    throw new Error("SoundCloud original download is unavailable for this retained plan");
  }
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(options.downloadTimeoutMs ?? 600_000)]);
  const maximumBytes = Math.min(VIDEO_LIMIT_BYTES, Math.max(1, options.maximumAudioBytes ?? VIDEO_LIMIT_BYTES));
  const staging = join(directory, ".staging", crypto.randomUUID());
  await mkdir(staging, { recursive: true });
  try {
    const output = join(staging, "original.%(ext)s");
    const runDownload = options.ytDlp ?? runYtDlp;
    const formatArgs = mp3
      ? ["--format", "bestaudio[ext=mp3]/bestaudio", "--extract-audio", "--audio-format", "mp3", "--audio-quality", "0", "--print", "after_move:%(id)s"]
      : ["--format", "download"];
    const downloaded = await runDownload(["--no-playlist", ...formatArgs, "--max-filesize", "250M", "--output", output, "--", source.canonicalUrl], signal);
    signal.throwIfAborted();
    if (mp3 && downloaded.stdout.trim() !== owner.soundcloud.trackId) throw new Error("SoundCloud downloaded a different track than the prepared source");
    const allowed = new Set(mp3 ? ["mp3"] : ["mp3", "m4a", "wav", "flac", "ogg", "opus", "aac"]);
    const candidates = (await readdir(staging)).filter(name => name.startsWith("original.") && allowed.has(name.slice("original.".length)));
    if (candidates.length !== 1) throw new Error("yt-dlp did not produce the requested SoundCloud audio file");
    const path = join(staging, candidates[0]!);
    const details = await stat(path);
    if (!details.isFile() || details.size === 0) throw new Error("yt-dlp produced an empty SoundCloud audio file");
    if (details.size > maximumBytes) throw new MediaBudgetError("SoundCloud audio exceeds the attachment size limit");
    const extension = candidates[0]!.slice("original.".length) as RenderedMedia["extension"];
    if (!mp3 && extension !== owner.soundcloud.originalDownloadExtension) {
      throw new Error("SoundCloud original download format changed since the plan was prepared");
    }
    const probe = JSON.parse(await run([FFPROBE, "-v", "error", "-show_streams", "-show_format", "-of", "json", path], signal)) as {
      format?: { format_name?: string; duration?: string }; streams?: Array<{ codec_type?: string; codec_name?: string; disposition?: { attached_pic?: number } }>;
    };
    const streams = probe.streams ?? [];
    if (!streams.some(stream => stream.codec_type === "audio") || streams.some(stream => stream.codec_type === "video" && stream.disposition?.attached_pic !== 1)) {
      throw new Error("SoundCloud download is not an audio-only media file");
    }
    const formats = new Set(probe.format?.format_name?.split(",") ?? []);
    const expected: Record<string, string> = { mp3: "mp3", m4a: "m4a", wav: "wav", flac: "flac", ogg: "ogg", opus: "ogg", aac: "aac" };
    if (!formats.has(expected[extension]!) || (extension === "opus" && !streams.some(stream => stream.codec_type === "audio" && stream.codec_name === "opus"))) {
      throw new Error(`SoundCloud audio content does not match its .${extension} file extension`);
    }
    if (mp3) {
      const duration = Number(probe.format?.duration), expectedDuration = assets[0]!.durationSeconds;
      if (!streams.some(stream => stream.codec_type === "audio" && stream.codec_name === "mp3") || !(duration > 0)) {
        throw new Error("SoundCloud download is not a valid MP3 audio file");
      }
      if (expectedDuration && Math.abs(duration - expectedDuration) > Math.max(1, expectedDuration * 0.02)) {
        throw new Error("SoundCloud audio duration does not match the selected track");
      }
    }
    const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
    signal.throwIfAborted();
    return writeContentAddressed(directory, extension, bytes);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function renderSubstackAudio(plan: BlockPlan, directory: string, options: RenderOptions): Promise<RenderedMedia> {
  const assets = selectedAssets(plan), source = selectedAudioSource(plan), asset = assets[0];
  let original=source?.substackArticle?.nativeMedia?.find(item=>item.kind==="audio"&&item.url===asset?.url);
  if(asset?.sourceAttribution){
    const node=mediaSources(plan.sources).find(node=>node.media.some(item=>item.ref===asset.ref));
    let note=source?.substackCapture?.note;
    if(!note){
      note=node&&plan.sources[node.rootIndex]?.substackCapture?.note;
      for(let depth=0;note&&depth<(node?.quoteDepth??0);depth++)note=note.quote?.expanded;
    }
    const attachment=note?.attachmentEvidence?.attachments.find(item=>item.id===asset.sourceAttribution!.attachmentId);
    original=attachment?.kind==="article"?attachment.podcast?.article?.audio:undefined;
  }
  if (plan.sources.length !== 1 || assets.length !== 1 || asset?.kind !== "audio" || asset.acquisition !== "substack-public-original"
    || !original || original.kind!=="audio" || original.url!==asset.url
      || original.durationSeconds!==asset.durationSeconds) throw new Error("Original Substack audio is missing consistent complete public source evidence");
  try { blockPlanSchema.parse(plan); }
  catch { throw new Error("Original Substack audio is missing consistent complete public source evidence"); }
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(options.downloadTimeoutMs ?? 60_000)]);
  const staging = join(directory, ".staging", crypto.randomUUID()); await mkdir(staging, { recursive: true });
  const path = join(staging, "original-audio");
  const limit = Math.min(VIDEO_LIMIT_BYTES, Math.max(1, options.maximumAudioBytes ?? VIDEO_LIMIT_BYTES));
  try {
    const response = await abortable((options.fetcher ?? fetch)(asset.url, { credentials: "omit", signal, headers: { accept: "audio/*" } }), signal);
    if (!response.ok || !response.body) throw new Error(`Public Substack audio download returned HTTP ${response.status}`);
    if (Number(response.headers.get("content-length")) > limit) { void response.body.cancel(); throw new MediaBudgetError("Original audio exceeds the attachment limit"); }
    const writer = Bun.file(path).writer(), reader = response.body.getReader(); let size = 0;
    try {
      while (true) {
        const { done, value } = await abortable(reader.read(), signal); if (done) break;
        if ((size += value.byteLength) > limit) throw new MediaBudgetError("Original audio exceeds the attachment limit");
        writer.write(value);
      }
    } finally { await writer.end(); void reader.cancel().catch(() => {}); }
    signal.throwIfAborted();
    if (!size) throw new Error("Public Substack audio was empty");
    const report = JSON.parse(await run([FFPROBE, "-v", "error", "-show_entries", "format=format_name,duration:stream=codec_type,codec_name:stream_disposition=attached_pic", "-of", "json", path], signal));
    const streams: Array<{ codec_type: string; codec_name?: string; disposition?: { attached_pic?: number } }> = report.streams ?? [];
    if (!streams.some(item => item.codec_type === "audio") || streams.some(item => item.codec_type === "video" && item.disposition?.attached_pic !== 1) || !(Number(report.format?.duration) > 0)) throw new Error("The public Substack original is not a valid audio-only attachment");
    verifyOriginalDuration(asset.durationSeconds, Number(report.format.duration));
    const formats = String(report.format?.format_name ?? "").split(",");
    const extension = formats.includes("mp3") ? "mp3" : formats.includes("wav") ? "wav" : formats.includes("flac") ? "flac"
      : formats.includes("ogg") ? "ogg" : formats.includes("aac") ? "aac" : formats.includes("m4a") || formats.includes("mp4") ? "m4a" : undefined;
    if (!extension) throw new Error("This public audio format is not supported without conversion");
    const hash = createHash("sha256"); for await (const chunk of Bun.file(path).stream()) { signal.throwIfAborted(); hash.update(chunk); }
    signal.throwIfAborted();
    const digest = hash.digest("hex"), output = join(directory, digest.slice(0, 2), `${digest}.${extension}`);
    await mkdir(dirname(output), { recursive: true }); signal.throwIfAborted(); await copyFile(path, output);
    if (signal.aborted) { await rm(output, { force: true }); signal.throwIfAborted(); }
    return { path: output, hash: digest, extension, mimeType: FORMAT_MIME[extension], size };
  } finally { await rm(staging, { recursive: true, force: true }); }
}

function selectedAudioSource(plan: BlockPlan): ResolvedPost | undefined {
  const ref = plan.block.selectedMedia[0];
  return mediaSources(plan.sources).find(node => node.media.some(asset => asset.ref === ref && asset.kind === "audio"))?.source;
}

export async function renderPlan(plan: BlockPlan, directory: string, options: RenderOptions = {}): Promise<RenderedMedia | undefined> {
  options.signal?.throwIfAborted();
  if (plan.block.kind === "text" || plan.block.kind === "url") return undefined;
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  try {
    return await (plan.block.kind === "image" ? renderPlaylistArtwork(plan, directory, { ...options, signal })
      : plan.block.kind === "video" ? renderVideo(plan, directory, { ...options, signal })
      : plan.block.kind === "audio" ? (selectedAudioSource(plan)?.provider === "substack" ? renderSubstackAudio(plan, directory, { ...options, signal }) : renderSoundCloudAudio(plan, directory, { ...options, signal }))
        : renderImages(plan, directory, { ...options, signal }));
  } catch (error) {
    controller.abort(error); // Stop other selected downloads after a partial failure.
    throw error;
  }
}
