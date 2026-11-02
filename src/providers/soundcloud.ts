import type { MediaAsset, ResolvedPost, SoundCloudMetadata } from "../../packages/core/types.ts";
import type { ParsedSource } from "../../packages/core/url.ts";
import type { SocialProvider } from "../../packages/core/providers/provider.ts";
import { MAX_SOUNDCLOUD_PLAYLIST_TRACKS } from "../../packages/core/types.ts";
import { parseSource } from "../../packages/core/url.ts";
import { soundCloudPlaylistText, soundCloudTrackText } from "../../packages/core/soundcloud.ts";

const MAX_PLAYLIST_TRACKS = MAX_SOUNDCLOUD_PLAYLIST_TRACKS;
const MAX_METADATA_BYTES = 32 * 1024 * 1024;
const AUDIO_MIME: Record<string, string> = {
  mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", flac: "audio/flac",
  ogg: "audio/ogg", opus: "audio/ogg", aac: "audio/aac",
};

export type YtDlpResult = { stdout: string; stderr: string };
export type YtDlpRunner = (args: string[], signal?: AbortSignal) => Promise<YtDlpResult>;
export function isolatedYtDlpArgs(args: string[]): string[] { return ["--ignore-config", "--no-cache-dir", "--no-warnings", ...args]; }

async function readOutput(stream: ReadableStream<Uint8Array>, maximum: number, stop: () => void): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > maximum) {
        stop();
        void reader.cancel().catch(() => {});
        throw new Error("yt-dlp output exceeded its safe metadata limit");
      }
      parts.push(decoder.decode(item.value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join("");
  } finally { reader.releaseLock(); }
}

/** Run with isolated yt-dlp defaults; config files, browser cookies and credentials are never consulted. */
export function createYtDlpRunner(binary = "yt-dlp", limits: { metadataTimeoutMs?: number; downloadTimeoutMs?: number } = {}): YtDlpRunner {
  return async (args, signal) => {
    const metadata = args.includes("--simulate");
    const timeout = AbortSignal.timeout(metadata
      ? (limits.metadataTimeoutMs ?? (args.includes("--playlist-end") ? 600_000 : 90_000))
      : (limits.downloadTimeoutMs ?? 600_000));
    const effectiveSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    effectiveSignal.throwIfAborted();
    let child: ReturnType<typeof Bun.spawn>;
    try {
      child = Bun.spawn([binary, ...isolatedYtDlpArgs(args)], {
        stdin: "ignore", stdout: "pipe", stderr: "pipe",
      });
    } catch (error) {
      throw new Error("SoundCloud support requires yt-dlp on PATH", { cause: error });
    }
    const abort = () => child.kill("SIGKILL");
    effectiveSignal.addEventListener("abort", abort, { once: true });
    if (effectiveSignal.aborted) abort();
    try {
      const [stdout, stderr, status] = await Promise.all([
        readOutput(child.stdout as ReadableStream<Uint8Array>, MAX_METADATA_BYTES, () => child.kill()),
        readOutput(child.stderr as ReadableStream<Uint8Array>, 2 * 1024 * 1024, () => child.kill()), child.exited,
      ]);
      effectiveSignal.throwIfAborted();
      if (status !== 0) throw new Error(`yt-dlp failed (${status}): ${stderr.trim().slice(0, 2000)}`);
      return { stdout, stderr };
    } finally {
      effectiveSignal.removeEventListener("abort", abort);
    }
  };
}
export const runYtDlp = createYtDlpRunner();

type Json = Record<string, unknown>;
function object(value: unknown): Json | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
}
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => text(item) ? [text(item)!.trim()] : []);
}
function safeArtwork(info: Json): string | undefined {
  const thumbnails = Array.isArray(info.thumbnails) ? info.thumbnails.map(object).filter((item): item is Json => !!item) : [];
  const urls = [...thumbnails.reverse().map(item => item.url), info.thumbnail];
  for (const candidate of urls) {
    const candidateText = text(candidate);
    if (!candidateText) continue;
    try {
      const url = new URL(candidateText);
      if (url.protocol === "https:" && !url.username && !url.password && !url.port
        && (url.hostname === "sndcdn.com" || url.hostname.endsWith(".sndcdn.com"))) return url.href;
    } catch { /* skip malformed source artwork */ }
  }
  return undefined;
}
function assertPublic(info: Json): void {
  const availability = text(info.availability);
  if (availability && availability !== "public") {
    throw new Error(`SoundCloud item is ${availability}; only publicly available tracks and playlists can be captured`);
  }
}
function validateResolvedUrl(value: unknown, kind: "track" | "playlist", fallback: string): string {
  const candidate = text(value) ?? fallback;
  let parsed: ReturnType<typeof parseSource>;
  try { parsed = parseSource(candidate); }
  catch { throw new Error("yt-dlp returned a non-public or unsupported SoundCloud source URL"); }
  if (parsed.provider !== "soundcloud" || parsed.kind !== kind) throw new Error("yt-dlp returned a different SoundCloud item type");
  return parsed.canonicalUrl;
}
function artists(info: Json): string[] {
  return strings(info.artists).length ? strings(info.artists)
    : text(info.artist) ? [text(info.artist)!.trim()]
      : text(info.uploader) ? [text(info.uploader)!.trim()] : [];
}
function sourceDescription(info: Json): string { return typeof info.description === "string" ? info.description : ""; }
function author(info: Json, source: Extract<ParsedSource, { provider: "soundcloud" }>) {
  const uploader = text(info.uploader);
  return { handle: source.canonicalUrl.split("/")[3]!, ...(uploader ? { name: uploader } : {}) };
}
function ensureInfoType(info: Json, source: Extract<ParsedSource, { provider: "soundcloud" }>): void {
  assertPublic(info);
  if (!text(info.title)) throw new Error("SoundCloud returned no title; refusing an incomplete capture");
  if (validateResolvedUrl(info.webpage_url, source.kind, source.canonicalUrl) !== source.canonicalUrl) {
    throw new Error("yt-dlp resolved a different SoundCloud item; refusing to substitute its identity");
  }
}
function trackMedia(info: Json, source: Extract<ParsedSource, { provider: "soundcloud" }>): { metadata: Extract<SoundCloudMetadata, { kind: "track" }>; media: MediaAsset[] } {
  const formats = Array.isArray(info.formats) ? info.formats.map(object).filter((item): item is Json => !!item) : [];
  const original = formats.find(format => format.format_id === "download" && format.vcodec === "none" && typeof format.ext === "string");
  const download = original && typeof original.ext === "string" && AUDIO_MIME[original.ext] ? original : undefined;
  const streamable = formats.some(format => format.vcodec === "none" && text(format.url));
  const durationSeconds = positive(info.duration);
  const metadata: SoundCloudMetadata = {
    kind: "track", trackId: text(info.id) ?? source.id, artists: artists(info), description: sourceDescription(info),
    ...(safeArtwork(info) ? { artworkUrl: safeArtwork(info) } : {}),
    ...(durationSeconds ? { durationSeconds } : {}), originalDownloadAvailable: !!original,
    ...(typeof original?.ext === "string" ? { originalDownloadExtension: original.ext } : {}),
  };
  const acquisition: Pick<MediaAsset, "mimeType" | "sourceRole" | "acquisition"> = download
    ? { mimeType: AUDIO_MIME[download.ext as string], sourceRole: "original", acquisition: "soundcloud-original-download" }
    : { mimeType: "audio/mpeg", acquisition: "soundcloud-mp3" };
  const media: MediaAsset[] = download || streamable ? [{ ref: "0.0", id: metadata.trackId, kind: "audio", url: source.canonicalUrl,
    ...acquisition, ...(durationSeconds ? { durationSeconds } : {}), alt: "" }] : [];
  return { metadata, media };
}
function playlistTracks(info: Json, source: Extract<ParsedSource, { provider: "soundcloud" }>): Extract<SoundCloudMetadata, { kind: "playlist" }> {
  const entries = Array.isArray(info.entries) ? info.entries : undefined;
  const declared = info.playlist_count;
  if (!entries || !Number.isSafeInteger(declared) || typeof declared !== "number" || declared < 0) {
    throw new Error("SoundCloud playlist metadata did not include a complete ordered entry list and count");
  }
  if (declared > MAX_PLAYLIST_TRACKS) throw new Error(`SoundCloud playlist has ${declared} tracks; the safe complete-capture limit is ${MAX_PLAYLIST_TRACKS}`);
  if (entries.length !== declared) throw new Error(`SoundCloud playlist metadata is incomplete (${entries.length} of ${declared} tracks); refusing to truncate or reorder it`);
  const tracks = entries.map((value, index) => {
    const entry = object(value);
    if (!entry || !text(entry.title)) throw new Error(`SoundCloud playlist entry ${index + 1} is unavailable; refusing a partial playlist capture`);
    assertPublic(entry);
    const url = validateResolvedUrl(entry.webpage_url ?? entry.original_url, "track", "");
    const entrySource = parseSource(url);
    if (entrySource.provider !== "soundcloud") throw new Error(`SoundCloud playlist entry ${index + 1} has no public track identity`);
    return {
      id: text(entry.id) ?? entrySource.id,
      title: text(entry.title)!,
      artists: artists(entry),
      url,
      ...(positive(entry.duration) ? { durationSeconds: positive(entry.duration) } : {}),
    };
  });
  return {
    kind: "playlist", description: sourceDescription(info), ...(safeArtwork(info) ? { artworkUrl: safeArtwork(info) } : {}),
    tracks, declaredTrackCount: declared,
  };
}

export class SoundCloudProvider implements SocialProvider {
  constructor(private readonly run: YtDlpRunner = runYtDlp) {}

  async resolve(input: ParsedSource, signal?: AbortSignal): Promise<ResolvedPost> {
    if (input.provider !== "soundcloud") throw new Error("Expected a SoundCloud track or playlist");
    const args = ["--simulate", "--dump-single-json", "--no-flat-playlist"];
    if (input.kind === "track") args.push("--no-playlist");
    else args.push("--ignore-no-formats-error", "--playlist-end", String(MAX_PLAYLIST_TRACKS + 1));
    args.push("--", input.canonicalUrl);
    const { stdout } = await this.run(args, signal);
    let parsed: unknown;
    try { parsed = JSON.parse(stdout); } catch { throw new Error("yt-dlp returned invalid SoundCloud metadata JSON"); }
    const info = object(parsed);
    if (!info) throw new Error("yt-dlp returned no SoundCloud metadata");
    ensureInfoType(info, input);
    const timestamp = positive(info.timestamp);
    const postedAt = timestamp && Number.isFinite(timestamp * 1000) && timestamp * 1000 <= 8.64e15
      ? new Date(timestamp * 1000).toISOString() : undefined;
    const common = { provider: "soundcloud" as const, canonicalUrl: input.canonicalUrl, author: author(info, input), postTitle: text(info.title)!,
      ...(postedAt ? { postedAt } : {}) };
    if (input.kind === "track") {
      const { metadata, media } = trackMedia(info, input);
      return { ...common, id: metadata.trackId, text: soundCloudTrackText(metadata, sourceDescription(info)), media, soundcloud: metadata };
    }
    const metadata = playlistTracks(info, input);
    return { ...common, id: text(info.id) ?? input.id, text: soundCloudPlaylistText(metadata, sourceDescription(info), false), media: [], soundcloud: metadata };
  }
}

export { AUDIO_MIME, MAX_PLAYLIST_TRACKS };
