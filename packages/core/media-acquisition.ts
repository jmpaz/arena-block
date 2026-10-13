import type { Fetcher } from "./providers/comments.ts";

export async function resolveMediaURL(value: string, fetcher: Fetcher = fetch, signal?: AbortSignal): Promise<string> {
  const url = new URL(value);
  if (url.hostname !== "video.bsky.app") return value;
  if (url.protocol !== "https:" || url.username || url.password || url.port) throw new Error("Invalid Bluesky video URL");
  const match = url.pathname.match(/^\/watch\/([^/]+)\/([a-zA-Z0-9]+)\/playlist\.m3u8$/);
  if (!match) return value;
  const did = decodeURIComponent(match[1]!);
  const cid = match[2]!;
  let documentURL: string;
  if (/^did:plc:[a-z2-7]{24}$/.test(did)) documentURL = `https://plc.directory/${did}`;
  else if (/^did:web:[a-zA-Z0-9.-]+$/.test(did)) {
    const host = did.slice("did:web:".length);
    if (!host.includes(".") || host.startsWith(".") || host.endsWith(".")) throw new Error("Invalid Bluesky video DID");
    documentURL = `https://${host}/.well-known/did.json`;
  } else throw new Error("Invalid Bluesky video DID");
  const response = await fetcher(documentURL, { headers: { accept: "application/json", "user-agent": "arena-block/0.1" }, signal });
  if (!response.ok) throw new Error(`Bluesky video identity lookup returned ${response.status}`);
  const document = await response.json() as { id?: unknown; service?: Array<{ id?: unknown; type?: unknown; serviceEndpoint?: unknown }> };
  if (!document || typeof document !== "object" || document.id !== did) throw new Error("Bluesky video identity document does not match its source");
  const service = (Array.isArray(document.service) ? document.service : []).find(item => item && (item.id === "#atproto_pds" || item.id === `${did}#atproto_pds`) && item.type === "AtprotoPersonalDataServer");
  if (typeof service?.serviceEndpoint !== "string") throw new Error("Bluesky video identity has no personal data server");
  const server = new URL(service.serviceEndpoint);
  if (server.protocol !== "https:" || server.username || server.password || server.search || server.hash || server.pathname !== "/") throw new Error("Invalid Bluesky personal data server URL");
  const blob = new URL("/xrpc/com.atproto.sync.getBlob", server);
  blob.searchParams.set("did", did);
  blob.searchParams.set("cid", cid);
  return blob.href;
}

export type MediaSources = { url: string; audioURL?: string };

function xmlAttribute(source: string, name: string): string | undefined {
  return source.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i"))?.[1];
}

export function redditMediaSources(manifest: string, manifestURL: string): MediaSources {
  if (manifest.length > 2 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(manifest)) throw new Error("Invalid Reddit DASH manifest");
  const candidates: Array<{ kind: "video" | "audio"; url: string; bandwidth: number }> = [];
  for (const adaptation of manifest.matchAll(/<AdaptationSet\b([^>]*)>([\s\S]*?)<\/AdaptationSet>/gi)) {
    for (const representation of adaptation[2]!.matchAll(/<Representation\b([^>]*)>([\s\S]*?)<\/Representation>/gi)) {
      const attributes = representation[1]!;
      const mime = xmlAttribute(attributes, "mimeType") ?? xmlAttribute(adaptation[1]!, "mimeType");
      const codec = xmlAttribute(attributes, "codecs") ?? xmlAttribute(adaptation[1]!, "codecs") ?? "";
      const kind = mime === "video/mp4" && /^avc[13]\./i.test(codec) ? "video"
        : mime === "audio/mp4" && /^mp4a\./i.test(codec) ? "audio" : undefined;
      const base = representation[2]!.match(/<BaseURL(?:\s[^>]*)?>([^<]*)<\/BaseURL>/i)?.[1]?.trim().replaceAll("&amp;", "&");
      if (!kind || !base || /&(?:#|[a-z]+;)/i.test(base)) continue;
      const url = new URL(base, manifestURL);
      if (url.protocol !== "https:" || url.hostname !== "v.redd.it" || url.port || url.username || url.password) throw new Error("Invalid Reddit DASH media URL");
      const bandwidth = Number(xmlAttribute(attributes, "bandwidth") ?? "0");
      if (!Number.isFinite(bandwidth) || bandwidth < 0) throw new Error("Invalid Reddit DASH bandwidth");
      candidates.push({ kind, url: url.href, bandwidth });
    }
  }
  const best = (kind: "video" | "audio") => candidates.filter(item => item.kind === kind).sort((a, b) => b.bandwidth - a.bandwidth)[0];
  const video = best("video");
  if (!video) throw new Error("Reddit DASH manifest has no supported video");
  const audio = best("audio");
  if (!audio && /(?:audio\/|contentType\s*=\s*["']audio["'])/i.test(manifest)) throw new Error("Reddit DASH audio has no supported representation");
  return { url: video.url, ...(audio ? { audioURL: audio.url } : {}) };
}

export async function resolveMediaSources(value: string, fetcher: Fetcher = fetch, signal?: AbortSignal): Promise<MediaSources> {
  const url = new URL(value);
  if (url.hostname === "v.redd.it" && /^\/[a-zA-Z0-9]+\/HLSPlaylist\.m3u8$/.test(url.pathname)) {
    if (url.protocol !== "https:" || url.port || url.username || url.password) throw new Error("Invalid Reddit video URL");
    const manifestURL = new URL("DASHPlaylist.mpd", url);
    manifestURL.search = "";
    const response = await fetcher(manifestURL.href, { headers: { "user-agent": "arena-block/0.1" }, signal });
    if (!response.ok) throw new Error(`Reddit DASH manifest returned ${response.status}`);
    return redditMediaSources(await response.text(), manifestURL.href);
  }
  return { url: await resolveMediaURL(value, fetcher, signal) };
}
