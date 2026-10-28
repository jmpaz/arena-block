import type { ResolvedPost, SoundCloudMetadata } from "../types.ts";
import { MAX_SOUNDCLOUD_PLAYLIST_TRACKS } from "../types.ts";
import { soundCloudPlaylistText, soundCloudTrackText } from "../soundcloud.ts";
import { parseSource, type ParsedSource } from "../url.ts";
import type { SocialProvider } from "./provider.ts";

type Json = Record<string, unknown>;
const MAX_PAGE_CHARS = 2_000_000;
const MAX_NATIVE_COMPLETION_TRACKS = 40;

function object(value: unknown): Json | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
}
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}
function artwork(value: unknown): string | undefined {
  const candidate = text(value);
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    if (url.protocol === "https:" && !url.username && !url.password && !url.port
      && (url.hostname === "sndcdn.com" || url.hostname.endsWith(".sndcdn.com"))) return url.href;
  } catch { /* reject malformed art */ }
  return undefined;
}
function canonical(value: unknown, kind: "track" | "playlist"): string {
  const raw = text(value);
  if (!raw) throw new Error(`SoundCloud ${kind} has no public source URL`);
  const source = parseSource(raw);
  if (source.provider !== "soundcloud" || source.kind !== kind) throw new Error(`SoundCloud returned a different ${kind} URL`);
  return source.canonicalUrl;
}
function milliseconds(value: unknown): number | undefined {
  const number = positive(value);
  return number === undefined ? undefined : number / 1000;
}
function exactTime(value: unknown): string | undefined {
  const raw = text(value);
  if (!raw || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(raw)) return undefined;
  const date = new Date(raw);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}
function artist(value: Json): string[] {
  const credit = text(object(value.publisher_metadata)?.artist);
  const user = object(value.user);
  return credit ? [credit] : text(user?.username) ? [text(user?.username)!] : [];
}
function publicItem(value: Json, label: string): void {
  if (value.sharing !== "public") throw new Error(`${label} is private or unavailable; refusing a partial capture`);
}

/** Decode only SoundCloud's embedded public page record. Never request its private API or stream endpoints. */
export function soundCloudPageRecord(html: string, kind: "track" | "playlist"): Json {
  if (html.length > MAX_PAGE_CHARS) throw new Error("SoundCloud page exceeded the native metadata limit");
  const match = /window\.__sc_hydration\s*=\s*/.exec(html);
  if (!match) throw new Error("SoundCloud page has no source metadata");
  const start = match.index + match[0].length;
  const end = html.indexOf("</script>", start);
  if (end < 0) throw new Error("SoundCloud source metadata is incomplete");
  const raw = html.slice(start, end).trim().replace(/;\s*$/, "");
  let entries: unknown;
  try { entries = JSON.parse(raw); } catch { throw new Error("SoundCloud source metadata is invalid"); }
  if (!Array.isArray(entries)) throw new Error("SoundCloud source metadata is incomplete");
  const matching = entries.filter(entry => object(entry)?.hydratable === (kind === "track" ? "sound" : "playlist"));
  if (matching.length !== 1) throw new Error(`SoundCloud page has no unambiguous ${kind} record`);
  const data = object(object(matching[0])?.data);
  if (!data || data.kind !== kind) throw new Error(`SoundCloud returned a different ${kind} record`);
  return data;
}

function soundCloudPostFromRecord(source: Extract<ParsedSource, { provider: "soundcloud" }>, data: Json): ResolvedPost {
  publicItem(data, "SoundCloud source");
  const title = text(data.title);
  const id = positive(data.id);
  if (!title || !id || canonical(data.permalink_url, source.kind) !== source.canonicalUrl) {
    throw new Error("SoundCloud page identity or title does not match the requested source");
  }
  const user = object(data.user);
  const uploader = text(user?.username);
  const description = typeof data.description === "string" ? data.description : "";
  const common = {
    provider: "soundcloud" as const, id: String(id), canonicalUrl: source.canonicalUrl,
    author: { handle: source.canonicalUrl.split("/")[3]!, ...(uploader ? { name: uploader } : {}) },
    postTitle: title, ...(exactTime(data.created_at) ? { postedAt: exactTime(data.created_at) } : {}),
  };
  if (source.kind === "playlist") {
    const entries = data.tracks;
    const count = data.track_count;
    if (!Array.isArray(entries) || !Number.isSafeInteger(count) || typeof count !== "number" || count < 0 || count > MAX_SOUNDCLOUD_PLAYLIST_TRACKS || entries.length !== count) {
      throw new Error("SoundCloud playlist is incomplete or exceeds the complete-capture limit");
    }
    const tracks = entries.map((value, index) => {
      const track = object(value);
      if (!track) throw new Error(`SoundCloud playlist entry ${index + 1} is unavailable`);
      publicItem(track, `SoundCloud playlist entry ${index + 1}`);
      const trackTitle = text(track.title), trackID = positive(track.id);
      if (!trackTitle || !trackID) throw new Error(`SoundCloud playlist entry ${index + 1} is incomplete`);
      return { id: String(trackID), title: trackTitle, artists: artist(track), url: canonical(track.permalink_url, "track"),
        ...(milliseconds(track.duration) ? { durationSeconds: milliseconds(track.duration) } : {}) };
    });
    const metadata: Extract<SoundCloudMetadata, { kind: "playlist" }> = {
      kind: "playlist", description, tracks, declaredTrackCount: count,
      ...(artwork(data.artwork_url) ? { artworkUrl: artwork(data.artwork_url) } : {}),
    };
    return { ...common, text: soundCloudPlaylistText(metadata, description, false), media: [], soundcloud: metadata };
  }
  const offered = data.downloadable === true && data.has_downloads_left !== false;
  const metadata: Extract<SoundCloudMetadata, { kind: "track" }> = {
    kind: "track", trackId: String(id), artists: artist(data), description,
    ...(artwork(data.artwork_url) ? { artworkUrl: artwork(data.artwork_url) } : {}),
    ...(milliseconds(data.duration) ? { durationSeconds: milliseconds(data.duration) } : {}),
    originalDownloadAvailable: offered,
  };
  return { ...common, text: soundCloudTrackText(metadata, description), soundcloud: metadata,
    media: [{ ref: "0.0", id: metadata.trackId, kind: "audio", url: source.canonicalUrl,
      mimeType: "audio/mpeg", acquisition: "soundcloud-mp3",
      ...(metadata.durationSeconds ? { durationSeconds: metadata.durationSeconds } : {}), alt: "" }] };
}

export function soundCloudPostFromPage(source: Extract<ParsedSource, { provider: "soundcloud" }>, html: string): ResolvedPost {
  return soundCloudPostFromRecord(source, soundCloudPageRecord(html, source.kind));
}

export class NativeSoundCloudProvider implements SocialProvider {
  constructor(private readonly fetcher: (input: string, init?: RequestInit) => Promise<Response> = fetch) {}

  private async page(url: string, signal: AbortSignal): Promise<string> {
    const response = await this.fetcher(url, { signal, redirect: "manual", headers: { accept: "text/html" } });
    if (!response.ok || response.url && response.url !== url) throw new Error("SoundCloud source page is unavailable or redirected");
    if (!(response.headers.get("content-type") ?? "").toLowerCase().includes("text/html")) throw new Error("SoundCloud did not return an HTML source page");
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > MAX_PAGE_CHARS) throw new Error("SoundCloud page exceeded the native metadata limit");
    const html = await response.text();
    if (html.length > MAX_PAGE_CHARS) throw new Error("SoundCloud page exceeded the native metadata limit");
    return html;
  }

  private async completeTrack(id: number, signal: AbortSignal): Promise<Json> {
    const embed = new URL("https://soundcloud.com/oembed");
    embed.searchParams.set("url", `https://api.soundcloud.com/tracks/${id}`);
    embed.searchParams.set("format", "json");
    const response = await this.fetcher(embed.href, { signal, redirect: "manual", headers: { accept: "application/json" } });
    if (!response.ok || response.url && response.url !== embed.href) throw new Error(`SoundCloud playlist track ${id} has no public oEmbed identity`);
    if (!(response.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) throw new Error(`SoundCloud playlist track ${id} has no public oEmbed identity`);
    const raw = await response.text();
    if (raw.length > 32_000) throw new Error("SoundCloud oEmbed response exceeded its limit");
    let embedData: Json | undefined;
    try { embedData = object(JSON.parse(raw)); } catch { /* fail below */ }
    if (!embedData || embedData.provider_name !== "SoundCloud") throw new Error(`SoundCloud playlist track ${id} has no valid oEmbed identity`);
    const authorURL = text(embedData.author_url), authorName = text(embedData.author_name), embedTitle = text(embedData.title);
    if (!authorURL || !authorName || !embedTitle || !embedTitle.endsWith(` by ${authorName}`)) throw new Error(`SoundCloud playlist track ${id} has incomplete oEmbed metadata`);
    const author = new URL(authorURL);
    const slug = author.pathname.split("/").filter(Boolean);
    if (author.protocol !== "https:" || author.hostname !== "soundcloud.com" || author.username || author.password || author.port || slug.length !== 1) {
      throw new Error(`SoundCloud playlist track ${id} has an invalid author URL`);
    }
    const title = embedTitle.slice(0, -(` by ${authorName}`).length);
    const guessedSlug = title.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (!guessedSlug) throw new Error(`SoundCloud playlist track ${id} has no safe public URL candidate`);
    const candidate = `https://soundcloud.com/${slug[0]}/${guessedSlug}`;
    const data = soundCloudPageRecord(await this.page(candidate, signal), "track");
    if (data.id !== id || canonical(data.permalink_url, "track") !== candidate) throw new Error(`SoundCloud playlist track ${id} did not match its public page`);
    publicItem(data, `SoundCloud playlist track ${id}`);
    return data;
  }

  async resolve(source: ParsedSource, signal?: AbortSignal): Promise<ResolvedPost> {
    if (source.provider !== "soundcloud") throw new Error("Expected a SoundCloud track or playlist");
    const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(90_000)]) : AbortSignal.timeout(90_000);
    const html = await this.page(source.canonicalUrl, bounded);
    if (source.kind === "track") return soundCloudPostFromPage(source, html);
    const playlist = soundCloudPageRecord(html, "playlist");
    const entries = playlist.tracks;
    const count = playlist.track_count;
    if (!Array.isArray(entries) || !Number.isSafeInteger(count) || typeof count !== "number" || count < 0 || count > MAX_SOUNDCLOUD_PLAYLIST_TRACKS || entries.length !== count) {
      throw new Error("SoundCloud playlist is incomplete or exceeds the complete-capture limit");
    }
    const stubs = entries.map((value, index) => ({ value: object(value), index })).filter(({ value }) => value && !text(value.title));
    if (stubs.length > MAX_NATIVE_COMPLETION_TRACKS) throw new Error(`SoundCloud playlist needs ${stubs.length} extra track reads; the native safe limit is ${MAX_NATIVE_COMPLETION_TRACKS}`);
    const completed = [...entries];
    for (let offset = 0; offset < stubs.length; offset += 4) {
      const batch = stubs.slice(offset, offset + 4);
      const resolved = await Promise.all(batch.map(async ({ value }) => {
        const id = positive(value?.id);
        if (!id || !Number.isSafeInteger(id)) throw new Error("SoundCloud playlist has an unavailable track ID");
        return this.completeTrack(id, bounded);
      }));
      batch.forEach(({ index }, at) => { completed[index] = resolved[at]; });
    }
    return soundCloudPostFromRecord(source, { ...playlist, tracks: completed });
  }
}
