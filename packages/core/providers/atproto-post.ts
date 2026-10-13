import { resolvedPostSchema, type MediaAsset, type ResolvedPost } from "../types.ts";
import { atprotoActorPath, parseSource } from "../url.ts";

export type Json = Record<string, unknown>;
export type AtprotoApp = { provider: "bluesky" | "delve"; namespace: "app.bsky" | "town.delve"; origin: string; service: string; label: string };
export const BLUESKY: AtprotoApp = { provider: "bluesky", namespace: "app.bsky", origin: "https://bsky.app", service: "https://public.api.bsky.app", label: "Bluesky" };
export const DELVE: AtprotoApp = { provider: "delve", namespace: "town.delve", origin: "https://delve.town", service: "https://api.delve.town", label: "Delvetown" };
export const object = (value: unknown): Json | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
export const string = (value: unknown): string | undefined => typeof value === "string" && value.length ? value : undefined;
const positive = (value: unknown): number | undefined => typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
const characterBytes = (point: number) => point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
export function utf8Length(value: string): number {
  let length = 0;
  for (const character of value) length += characterBytes(character.codePointAt(0)!);
  return length;
}

export function publicUrl(value: unknown): string | undefined {
  try {
    const url = new URL(string(value) ?? "");
    return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}

function referenceUrl(value: unknown): string | undefined {
  try {
    if (typeof value !== "string" || value.trim() !== value || /[\u0000-\u001F\u007F]/.test(value)) return undefined;
    if (typeof value === "string" && value.startsWith("at://")) return parseSource(value).canonicalUrl;
    const url = new URL(string(value) ?? "");
    return ["https:", "http:", "mailto:", "at:"].includes(url.protocol) && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}

function dimensions(value: unknown) {
  const aspect = object(value);
  const width = positive(aspect?.width), height = positive(aspect?.height);
  return { ...(width ? { width } : {}), ...(height ? { height } : {}) };
}

function media(embed: Json, app: AtprotoApp): MediaAsset[] {
  const type = string(embed.$type);
  if (type === `${app.namespace}.embed.recordWithMedia#view`) return media(object(embed.media) ?? {}, app);
  if (type === `${app.namespace}.embed.images#view` || type === `${app.namespace}.embed.gallery#view`) {
    const gallery = type === `${app.namespace}.embed.gallery#view`;
    const items = gallery ? embed.items : embed.images;
    if (!Array.isArray(items)) throw new Error(`${app.label} image embed has no items`);
    return items.map(value => {
      const item = object(value);
      if (!item || (gallery && item.$type !== `${app.namespace}.embed.gallery#viewImage`)) throw new Error(`${app.label} gallery contains an unsupported item`);
      const url = publicUrl(item.fullsize);
      if (!url) throw new Error(`${app.label} image embed has no public full-size URL`);
      return { ref: "0.0", kind: "image", url, alt: typeof item.alt === "string" ? item.alt : "", ...dimensions(item.aspectRatio) };
    });
  }
  if (type === `${app.namespace}.embed.video#view`) {
    const url = publicUrl(embed.playlist);
    if (!url) throw new Error(`${app.label} video embed has no public playlist URL`);
    const posterUrl = publicUrl(embed.thumbnail);
    return [{ ref: "0.0", kind: "video", url, alt: typeof embed.alt === "string" ? embed.alt : "", ...dimensions(embed.aspectRatio), ...(posterUrl ? { posterUrl } : {}) }];
  }
  if (type === `${app.namespace}.embed.external#view` || type === `${app.namespace}.embed.record#view`) return [];
  throw new Error(`${app.label} returned an unsupported embed: ${type ?? "missing type"}`);
}

function external(embed: Json, app: AtprotoApp): ResolvedPost["external"] {
  if (embed.$type === `${app.namespace}.embed.recordWithMedia#view`) return external(object(embed.media) ?? {}, app);
  if (embed.$type !== `${app.namespace}.embed.external#view`) return undefined;
  const card = object(embed.external), url = referenceUrl(card?.uri);
  if (!card || !url || typeof card.title !== "string" || typeof card.description !== "string") throw new Error(`${app.label} external embed is incomplete or has an unsupported URL`);
  const thumbnailUrl = publicUrl(card.thumb);
  return { url, title: card.title, description: card.description, ...(thumbnailUrl ? { thumbnailUrl } : {}) };
}

export function atprotoPostFromView(post: Json, app: AtprotoApp, depth = 0): ResolvedPost {
  if (depth > 8) throw new Error(`${app.label} quote nesting exceeds eight levels`);
  const author = object(post.author), record = object(post.record) ?? object(post.value);
  const uri = string(post.uri), cid = string(post.cid), did = string(author?.did);
  const match = uri && /^at:\/\/(did:[^/]+)\/([^/]+)\/([^/]+)$/.exec(uri);
  if (!match || match[2] !== `${app.namespace}.feed.post` || did !== match[1] || !cid || record?.$type !== `${app.namespace}.feed.post`
    || typeof record.text !== "string" || !string(record.createdAt) || !Number.isFinite(Date.parse(record.createdAt as string))) {
    throw new Error(`${app.label} returned an incomplete post or a different record type`);
  }
  const handle = string(author?.handle) ?? did!;
  const embeds = post.embed ? [post.embed] : Array.isArray(post.embeds) ? post.embeds : [];
  if (embeds.length > 1) throw new Error(`${app.label} returned multiple unsupported post embeds`);
  const embed = object(embeds[0]);
  if (record.embed && !embed) throw new Error(`${app.label} did not return the post's embed view`);
  const facets = Array.isArray(record.facets) && record.facets.length ? record.facets : undefined;
  if (record.facets !== undefined && !Array.isArray(record.facets)) throw new Error(`${app.label} rich-text facets are malformed`);
  const card = embed && external(embed, app);
  let quote: ResolvedPost | undefined;
  let embeddedRecord: ResolvedPost["embeddedRecord"];
  const quoted = embed?.$type === `${app.namespace}.embed.recordWithMedia#view` ? object(object(embed.record)?.record)
    : embed?.$type === `${app.namespace}.embed.record#view` ? object(embed.record) : undefined;
  if (embed && [ `${app.namespace}.embed.recordWithMedia#view`, `${app.namespace}.embed.record#view` ].includes(String(embed.$type))) {
    const quotedUri = string(quoted?.uri);
    if (!quoted || !quotedUri) throw new Error(`${app.label} quoted record has no identity`);
    const quoteType = string(quoted.$type);
    const refEmbed = embed.$type === `${app.namespace}.embed.recordWithMedia#view` ? object(object(record.embed)?.record) : object(record.embed);
    const strongRef = object(refEmbed?.record);
    if (strongRef && strongRef.uri !== quotedUri) throw new Error(`${app.label} quote reference changed`);
    if (quoteType === `${app.namespace}.embed.record#viewRecord` && object(quoted.value)?.$type === `${app.namespace}.feed.post`) {
      if (strongRef?.uri !== quotedUri || strongRef?.cid !== quoted.cid) throw new Error(`${app.label} quote reference changed`);
      quote = atprotoPostFromView(quoted, app, depth + 1);
    } else {
      const status = quoteType === `${app.namespace}.embed.record#viewNotFound` ? "not-found"
        : quoteType === `${app.namespace}.embed.record#viewBlocked` ? "blocked"
        : quoteType === `${app.namespace}.embed.record#viewDetached` ? "detached" : "unsupported";
      embeddedRecord = { uri: quotedUri, status, ...(quoteType ? { type: quoteType } : {}) };
    }
  }
  return resolvedPostSchema.parse({
    provider: app.provider, id: match[3]!, canonicalUrl: `${app.origin}/profile/${atprotoActorPath(match[1]!)}/post/${match[3]}`,
    author: { handle, ...(string(author?.displayName) ? { name: string(author?.displayName) } : {}) },
    text: record.text, postedAt: record.createdAt as string,
    media: embed ? media(embed, app) : [],
    atproto: { uri: uri!, cid, authorDid: did!, record, ...(record.reply ? { reply: record.reply as NonNullable<ResolvedPost["atproto"]>["reply"] } : {}) },
    ...(facets ? { facets: facets as NonNullable<ResolvedPost["facets"]> } : {}),
    ...(card ? { external: card } : {}), ...(quote ? { quote } : {}), ...(embeddedRecord ? { embeddedRecord } : {}),
  });
}

const escapeLabel = (value: string) => value.replace(/[\\[\]]/g, "\\$&");
const escapeFacetLabel = (value: string) => value.replace(/[\\`*_\[\]<>!&]/g, "\\$&");
const destination = (url: string) => `<${url.replace(/[\\<>\s]/g, value => encodeURIComponent(value))}>`;

function urlDisplayLabel(label: string, target: string): boolean {
  if (!label || /\s/.test(label)) return false;
  const shortened = /(?:\.{3}|\u2026)$/.test(label);
  const prefix = shortened ? label.replace(/(?:\.{3}|\u2026)$/, "") : label;
  const explicitScheme = /^https?:\/\//i.test(prefix);
  if (!explicitScheme && !/^[^\s/@:?#<>]+\.[^\s/@:?#<>]+(?:[/:?#]|$)/u.test(prefix)) return false;
  const authority = prefix.replace(/^https?:\/\//i, "").split(/[/:?#]/)[0]!;
  if (!explicitScheme && /^[0-9.]+$/.test(authority) && !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(authority)) return false;
  try {
    const full = new URL(target);
    if (!["https:", "http:"].includes(full.protocol)) return false;
    const display = new URL(explicitScheme ? prefix : `${full.protocol}//${prefix}`);
    if (display.username || display.password || display.protocol !== full.protocol) return false;
    const comparable = (value: string) => value.replace(/%[0-9a-f]{2}/gi, part => part.toUpperCase());
    const fullUrl = comparable(full.href), displayUrl = comparable(display.href);
    const displays = [fullUrl, fullUrl.replace(/^(https?:\/\/)www\./, "$1")];
    if (!shortened) return displays.includes(displayUrl);
    const authorityOnly = !/[/?#]/.test(prefix.replace(/^https?:\/\//i, ""));
    const observedPrefix = authorityOnly ? displayUrl.replace(/\/$/, "") : displayUrl;
    return observedPrefix.length > full.protocol.length + 2 && displays.some(value => value.startsWith(observedPrefix));
  } catch { return false; }
}

function facetHyperlink(label: string, url: string): string {
  return label.split(/(\r?\n[ \t]*\r?\n(?:[ \t]*\r?\n)*)/).map((part, index) =>
    index % 2 || !part ? part : `[${escapeFacetLabel(part)}](${destination(url)})`).join("");
}

export function atprotoMarkdown(post: ResolvedPost): string {
  let text = post.article ?? post.text;
  const app = post.provider === "delve" ? DELVE : post.provider === "bluesky" ? BLUESKY : undefined;
  if (app && post.facets !== undefined && !Array.isArray(post.facets)) throw new Error("AT Protocol rich-text facets are malformed");
  if (app && post.facets?.length && post.article === undefined) {
    if (post.atproto && post.atproto.record.$type !== `${app.namespace}.feed.post`) throw new Error("AT Protocol facets require a supported post record");
    for (const facet of post.facets) {
      if (!facet?.index || !Array.isArray(facet.features)
        || facet.features.some(feature => !feature || typeof feature.$type !== "string" || !feature.$type)) {
        throw new Error("AT Protocol rich-text facets are malformed");
      }
    }
    const offsets = new Map<number, number>([[0, 0]]);
    let byteLength = 0, position = 0;
    for (const character of text) {
      const point = character.codePointAt(0)!;
      byteLength += characterBytes(point);
      position += character.length; offsets.set(byteLength, position);
    }
    const pieces: string[] = [];
    let end = 0;
    for (const facet of [...post.facets].sort((a, b) => a.index.byteStart - b.index.byteStart)) {
      const start = facet.index.byteStart, next = facet.index.byteEnd;
      if (!Number.isInteger(start) || !Number.isInteger(next) || next < start || !offsets.has(start) || !offsets.has(next)) throw new Error("Invalid or overlapping AT Protocol rich-text facets");
      if (next === start) continue;
      if (start < end) throw new Error("Invalid or overlapping AT Protocol rich-text facets");
      const before = text.slice(offsets.get(end), offsets.get(start)), label = text.slice(offsets.get(start), offsets.get(next));
      const features = facet.features.filter(feature => [ `${app.namespace}.richtext.facet#link`, `${app.namespace}.richtext.facet#mention` ].includes(feature.$type));
      const urls = features.map(feature => feature.$type === `${app.namespace}.richtext.facet#link` ? referenceUrl(feature.uri)
        : typeof feature.did === "string" && /^did:[a-z0-9]+:(?:[A-Za-z0-9._:-]|%[0-9A-Fa-f]{2})+$/.test(feature.did)
          ? `${app.origin}/profile/${atprotoActorPath(feature.did)}` : undefined);
      if (urls.some(url => !url)) throw new Error("AT Protocol facet has an unsupported or unsafe destination");
      if (new Set(urls).size > 1) throw new Error("AT Protocol facet has conflicting destinations");
      const url = urls[0];
      const displayLabel = url && features.some(feature => feature.$type === `${app.namespace}.richtext.facet#link`) && urlDisplayLabel(label, url) ? url : label;
      pieces.push(before, url ? facetHyperlink(displayLabel, url) : label);
      end = next;
    }
    pieces.push(text.slice(offsets.get(end)));
    text = pieces.join("");
  }
  const card = post.external;
  const linked = card ? [`[${escapeLabel(card.title || card.url)}](${destination(card.url)})`, card.description].filter(Boolean).join("\n\n") : "";
  const embedded = post.embeddedRecord;
  const placeholder = embedded ? `*[Embedded record ${embedded.status}: ${escapeLabel(embedded.uri)}]*` : "";
  return [text, linked, placeholder].filter(Boolean).join("\n\n");
}
