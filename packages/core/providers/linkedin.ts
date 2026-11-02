import type { ResolvedPost } from "../types.ts";
import { parseSource, type ParsedSource } from "../url.ts";
import type { SocialProvider } from "./provider.ts";

type Json = Record<string, unknown>;
const MAX_PAGE_CHARS = 2_000_000;
function object(value: unknown): Json | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
}
function publicMedia(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password && !url.port
      && (url.hostname === "licdn.com" || url.hostname.endsWith(".licdn.com"))) return url.href;
  } catch { /* invalid media URL */ }
  return undefined;
}

/** Only capture a public VideoObject whose identity and required media are present. */
export function linkedInPostFromPage(source: Extract<ParsedSource, { provider: "linkedin" }>, html: string): ResolvedPost {
  if (html.length > MAX_PAGE_CHARS) throw new Error("LinkedIn page exceeded the metadata limit");
  const records: Json[] = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (!/\btype\s*=\s*(["'])application\/ld\+json\1/i.test(match[1]!)) continue;
    let value: unknown;
    try { value = JSON.parse(match[2]!); } catch { throw new Error("LinkedIn structured data is invalid"); }
    for (const entry of Array.isArray(value) ? value : [value]) {
      const record = object(entry);
      if (record?.["@type"] === "VideoObject") records.push(record);
    }
  }
  if (records.length !== 1) throw new Error("LinkedIn post is unavailable or its media type is not supported; use the original link");
  const record = records[0]!;
  let identity: ParsedSource;
  try { identity = parseSource(String(record["@id"])); }
  catch { throw new Error("LinkedIn page has no valid post identity"); }
  if (identity.provider !== "linkedin" || identity.id !== source.id) throw new Error("LinkedIn returned a different post");
  const embed = typeof record.embedUrl === "string" ? record.embedUrl : "";
  const urn = /^https:\/\/www\.linkedin\.com\/embed\/feed\/update\/urn:li:activity:(\d+)(?:\?.*)?$/.exec(embed);
  if (!urn || urn[1] !== source.id) throw new Error("LinkedIn video identity does not match the post");
  const creator = object(record.creator);
  const name = typeof creator?.name === "string" ? creator.name.trim() : "";
  let handle = "";
  try {
    const author = new URL(String(creator?.url));
    const path = /^\/(?:company|in)\/([a-zA-Z0-9_-]+)\/?$/.exec(author.pathname);
    if (author.protocol === "https:" && !author.username && !author.password && !author.port
      && (author.hostname === "linkedin.com" || author.hostname.endsWith(".linkedin.com")) && path) handle = path[1]!;
  } catch { /* fail below */ }
  const content = publicMedia(record.contentUrl), poster = publicMedia(record.thumbnailUrl);
  if (!name || !handle || typeof record.description !== "string" || !content || !poster)
    throw new Error("LinkedIn post has incomplete author, text, video or poster metadata; use the original link");
  const rawDate = typeof record.datePublished === "string" ? record.datePublished : "";
  const date = new Date(rawDate);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(rawDate) || !Number.isFinite(date.getTime()))
    throw new Error("LinkedIn post has no valid publication date");
  const duration = typeof record.duration === "string" ? /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(record.duration) : null;
  const seconds = duration ? Number(duration[1] ?? 0) * 3600 + Number(duration[2] ?? 0) * 60 + Number(duration[3] ?? 0) : 0;
  return {
    provider: "linkedin", id: source.id, canonicalUrl: identity.canonicalUrl,
    author: { handle, name }, text: record.description, postedAt: date.toISOString(),
    media: [{ ref: "0.0", kind: "video", url: content, posterUrl: poster, alt: "", ...(seconds > 0 ? { durationSeconds: seconds } : {}) }],
  };
}

export class LinkedInProvider implements SocialProvider {
  constructor(private readonly fetcher: (input: string, init?: RequestInit) => Promise<Response> = fetch) {}
  async resolve(source: ParsedSource, signal?: AbortSignal): Promise<ResolvedPost> {
    if (source.provider !== "linkedin") throw new Error("Expected a LinkedIn post");
    const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
    const response = await this.fetcher(source.canonicalUrl, { signal: bounded, redirect: "manual", headers: { accept: "text/html" } });
    if (!response.ok || response.url && response.url !== source.canonicalUrl) throw new Error(`LinkedIn source page is unavailable or redirected (HTTP ${response.status}); use the original link`);
    if (!(response.headers.get("content-type") ?? "").toLowerCase().includes("text/html")) throw new Error("LinkedIn did not return a public HTML post");
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > MAX_PAGE_CHARS) throw new Error("LinkedIn page exceeded the metadata limit");
    return linkedInPostFromPage(source, await response.text());
  }
}
