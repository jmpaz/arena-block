import { parseSource } from "./url.ts";
import { articleMarkdown } from "../packages/core/providers/x-article.ts";

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => v && typeof v === "object" && !Array.isArray(v) ? v as Json : {};
const str = (v: unknown): string => typeof v === "string" ? v : "";
const list = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const finite = (v: unknown): number | undefined => typeof v === "number" && Number.isFinite(v) ? v : undefined;
export interface ThreadDescription { text: string; basis: "pixels" | "source-alt"; evidence?: string }
export interface ThreadMedia { url: string; kind: "image" | "video"; alt: string; description?: ThreadDescription }
export interface ThreadSegment { text: string; url?: string }
export interface ThreadPost {
  id: string; cid?: string; url: string; author: { handle: string; name?: string; did?: string }; postedAt?: string;
  text: string; segments: ThreadSegment[]; article?: string; external?: { url: string; title: string; description: string }; media: ThreadMedia[];
  status: "available" | "deleted" | "blocked" | "unavailable";
}
export interface ThreadEdge { from: string; to: string; kind: "reply" | "quote" | "ancestor" }
export interface ThreadCoverage {
  complete: false; scope: string; limits: string[]; errors: string[];
  capturedPosts: number; availablePosts: number; mediaWithoutDescriptions: number;
}
export interface ThreadCapture {
  sourceUrl: string; provider: "x" | "bluesky"; capturedAt: string;
  posts: ThreadPost[]; edges: ThreadEdge[]; coverage: ThreadCoverage;
  originals: { url: string; payload: unknown }[];
}
export interface ThreadCaptureOptions {
  fetch?: typeof fetch; signal?: AbortSignal; maxPosts?: number; depth?: number; parentHeight?: number;
  xManifest?: string[]; blueskyScope?: "chain" | "tree"; selectedAuthors?: string[]; maxRequests?: number; descriptions?: Record<string, ThreadDescription>;
}

function safeUrl(value: string): string | undefined {
  try { const u = new URL(value); return ["https:", "http:"].includes(u.protocol) && !u.username && !u.password ? u.href : undefined; } catch { return undefined; }
}
function source(value: string) {
  if (!value.startsWith("at://")) {
    const u = new URL(value);
    if (u.protocol !== "https:" || u.username || u.password || u.port) throw new Error("Thread sources must use HTTPS without credentials or custom ports");
  }
  const parsed = parseSource(value);
  if (parsed.provider !== "x" && parsed.provider !== "bluesky") throw new Error("Thread capture supports x.com and Bluesky post permalinks only");
  if (parsed.provider === "x" && !/^[A-Za-z0-9_]{1,50}$/.test(parsed.handle)) throw new Error("Invalid x.com handle");
  return parsed;
}
function bound(value: number | undefined, fallback: number, max: number, min = 0): number {
  const n = value ?? fallback;
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Expected an integer between ${min} and ${max}`);
  return n;
}
/** ATProto facet offsets are UTF-8 bytes, not JavaScript UTF-16 indices. Invalid or overlapping facets remain plain text. */
export function threadTextSegments(text: string, facets: unknown): ThreadSegment[] {
  const bytes = new TextEncoder().encode(text), decoder = new TextDecoder("utf-8", { fatal: true });
  const segments: ThreadSegment[] = []; let cursor = 0;
  for (const f of list(facets).map(obj).sort((a, b) => Number(obj(a.index).byteStart) - Number(obj(b.index).byteStart))) {
    const index = obj(f.index), start = finite(index.byteStart), end = finite(index.byteEnd);
    if (start === undefined || end === undefined || !Number.isInteger(start) || !Number.isInteger(end) || start < cursor || end <= start || end > bytes.length) continue;
    try {
      const before = decoder.decode(bytes.slice(cursor, start)), snippet = decoder.decode(bytes.slice(start, end));
      let url: string | undefined;
      for (const feature of list(f.features).map(obj)) {
        const type = str(feature.$type);
        if (type.endsWith("#link")) url = safeUrl(str(feature.uri));
        if (type.endsWith("#mention") && /^did:[A-Za-z0-9:._%-]+$/.test(str(feature.did))) url = `https://bsky.app/profile/${str(feature.did)}`;
        if (type.endsWith("#tag") && str(feature.tag)) url = `https://bsky.app/hashtag/${encodeURIComponent(str(feature.tag))}`;
        if (url) break;
      }
      if (before) segments.push({ text: before }); segments.push({ text: snippet, ...(url ? { url } : {}) }); cursor = end;
    } catch { /* Never split a multibyte code point. */ }
  }
  const rest = decoder.decode(bytes.slice(cursor)); if (rest) segments.push({ text: rest });
  return segments;
}

/** Draft only: fixed public API origins, no authentication, redirect following, media downloads, or writes. */
export async function captureThread(sourceUrl: string, options: ThreadCaptureOptions = {}): Promise<ThreadCapture> {
  const parsed = source(sourceUrl), maxPosts = bound(options.maxPosts, 100, 1000, 1);
  const maxRequests = bound(options.maxRequests, 20, 100, 1);
  const depth = bound(options.depth, 6, 1000), parentHeight = bound(options.parentHeight, 80, 1000);
  const capture: ThreadCapture = { sourceUrl: parsed.canonicalUrl, provider: parsed.provider, capturedAt: new Date().toISOString(), posts: [], edges: [], originals: [], coverage: { complete: false, scope: parsed.provider === "x" ? "Explicit x.com manifest plus reachable ancestor and embedded quote pointers" : "Public Bluesky reply tree and ancestor chain returned by getPostThread", limits: [], errors: [], capturedPosts: 0, availablePosts: 0, mediaWithoutDescriptions: 0 } };
  const limits = new Set<string>(), seen = new Set<string>();
  let requests = 0;
  const abort = () => options.signal?.throwIfAborted();
  const json = async (url: string): Promise<unknown> => {
    abort();
    if (requests >= maxRequests) { limits.add(`Public request cap ${maxRequests} reached`); throw new Error("Public request cap reached"); }
    requests++;
    const deadline = AbortSignal.timeout(30_000);
    const response = await (options.fetch ?? fetch)(url, { headers: { accept: "application/json" }, redirect: "error", credentials: "omit", signal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline });
    abort();
    if (response.redirected || (response.url && new URL(response.url).origin !== new URL(url).origin)) throw new Error("Unexpected public API redirect");
    if (!response.ok) throw new Error(`Public API returned HTTP ${response.status}`);
    const payload: unknown = await response.json(); abort(); capture.originals.push({ url, payload }); return payload;
  };
  const media = (url: string, kind: ThreadMedia["kind"], alt: string): ThreadMedia[] => {
    const safe = safeUrl(url); if (!safe) { limits.add("Unsafe or missing media URL omitted"); return []; }
    const description = options.descriptions?.[url];
    if (description?.basis === "pixels" && !description.evidence) throw new Error("Pixel descriptions require an evidence path or reference");
    return [{ url: safe, kind, alt, ...(description?.text ? { description } : {}) }];
  };
  const add = (post: ThreadPost): boolean => {
    abort(); if (seen.has(post.id)) return false;
    if (capture.posts.length >= maxPosts) { limits.add(`Post cap ${maxPosts} reached`); return false; }
    seen.add(post.id); capture.posts.push(post); return true;
  };
  const edge = (from: string | undefined, to: string, kind: ThreadEdge["kind"]) => {
    if (from && !capture.edges.some(e => e.from === from && e.to === to && e.kind === kind)) capture.edges.push({ from, to, kind });
  };
  const placeholder = (id: string, url: string, status: ThreadPost["status"]) => add({ id, url, author: { handle: "unknown" }, text: "", segments: [], media: [], status });

  if (parsed.provider === "x") {
    limits.add("FxTwitter cannot enumerate downward replies; full x.com thread completeness is unverified, even with a manifest");
    const queue = [parsed.canonicalUrl, ...(options.xManifest ?? [])].map(url => ({ url, quoteDepth: 0 }));
    // Validate every source before initiating any request.
    for (const { url } of queue) if (source(url).provider !== "x") throw new Error("x.com manifests must contain x.com post permalinks");
    const queued = new Set<string>();
    const quoteActive = new Set<string>();
    const parseTweet = (tweet: Json, fallbackUrl: string, quoteDepth = 0, standalone = false): string => {
      const fallback = source(fallbackUrl); if (fallback.provider !== "x") throw new Error("Invalid x.com source");
      const author = obj(tweet.author), handle = str(author.screen_name) || str(author.screenName) || fallback.handle;
      const id = str(tweet.id) || str(tweet.id_str) || fallback.id;
      const url = /^[A-Za-z0-9_]+$/.test(handle) && /^\d+$/.test(id) ? `https://x.com/${handle}/status/${id}` : fallback.canonicalUrl;
      const text = str(tweet.text) || str(obj(tweet.raw_text).text);
      const m = obj(tweet.media), all = list(m.all).length ? list(m.all) : [...list(m.photos), ...list(m.videos), ...list(m.animated_gifs)];
      const assets = all.flatMap(v => { const item = obj(v), kind = ["video", "gif"].includes(str(item.type)) ? "video" : "image";
        const variant = list(item.variants).map(obj).filter(v => safeUrl(str(v.url)) && str(v.url).includes(".mp4")).sort((a,b) => (finite(b.bitrate) ?? 0) - (finite(a.bitrate) ?? 0))[0];
        return media((kind === "video" ? str(variant?.url) : "") || str(item.url) || str(item.thumbnail_url), kind, str(item.alt) || str(item.altText) || str(item.ext_alt_text)); });
      const normalized: ThreadPost = { id, url, author: { handle, ...(str(author.name) ? { name: str(author.name) } : {}) }, ...(str(tweet.created_at) || str(tweet.date) ? { postedAt: str(tweet.created_at) || str(tweet.date) } : {}), text, segments: [{ text }], ...(Object.keys(obj(tweet.article)).length ? { article: articleMarkdown(obj(tweet.article)) } : {}), media: assets, status: "available" };
      if (standalone && seen.has(id)) capture.posts[capture.posts.findIndex(p => p.id === id)] = normalized;
      else add(normalized);
      if (quoteActive.has(id)) { limits.add("Cyclic embedded x.com quote omitted"); return id; }
      quoteActive.add(id);
      const parentId = str(tweet.replying_to_status) || str(tweet.in_reply_to_status_id_str) || str(tweet.in_reply_to_status_id);
      if (/^\d+$/.test(parentId)) {
        const parentHandle = str(tweet.replying_to) || str(tweet.in_reply_to_screen_name) || "i";
        edge(id, parentId, "ancestor"); queue.push({ url: `https://x.com/${/^[A-Za-z0-9_]+$/.test(parentHandle) ? parentHandle : "i"}/status/${parentId}`, quoteDepth: 0 });
      }
      const quote = obj(tweet.quote);
      if (Object.keys(quote).length) {
        if (quoteDepth >= depth) limits.add(`Quote depth ${depth} reached`);
        else if (!/^\d+$/.test(str(quote.id) || str(quote.id_str))) limits.add("Embedded x.com quote has no valid source ID; omitted");
        else { const quoteId = parseTweet(quote, fallbackUrl, quoteDepth + 1); edge(id, quoteId, "quote"); const handle = str(obj(quote.author).screen_name) || str(obj(quote.author).screenName) || "i"; queue.push({ url: `https://x.com/${/^[A-Za-z0-9_]+$/.test(handle) ? handle : "i"}/status/${quoteId}`, quoteDepth: quoteDepth + 1 }); }
      }
      quoteActive.delete(id);
      return id;
    };
    while (queue.length) {
      abort(); const { url, quoteDepth } = queue.shift()!, item = source(url); if (item.provider !== "x") continue;
      if (queued.has(item.id)) continue; queued.add(item.id);
      if (capture.posts.length >= maxPosts && !seen.has(item.id)) { limits.add(`Post cap ${maxPosts} reached`); continue; }
      try {
        const payload = obj(await json(`https://api.fxtwitter.com/${encodeURIComponent(item.handle)}/status/${item.id}`));
        if (!Object.keys(obj(payload.tweet)).length) throw new Error("Public API returned no tweet");
        parseTweet(obj(payload.tweet), item.canonicalUrl, quoteDepth, true);
      } catch (error) { abort(); capture.coverage.errors.push(`${item.canonicalUrl}: ${error instanceof Error ? error.message : String(error)}`); placeholder(item.id, item.canonicalUrl, "unavailable"); }
    }
  } else {
    const treeScope = options.blueskyScope !== "chain";
    if (!treeScope) capture.coverage.scope = "Public Bluesky selected source post plus its returned chronological ancestor chain and embedded quotes; sibling/downward replies excluded by explicit scope";
    const frontier: string[] = [];
    const deferredReplies: { value: unknown; from: string; level: number; parents: number }[] = [];
    const fetched = new Set<string>();
    const expanded = new Map<string, number>();
    const preferred = new Set((options.selectedAuthors ?? [parsed.handle]).map(h => h.replace(/^@/, "").toLowerCase()));
    limits.add(`Bluesky server-returned tree only; requested reply depth ${depth}, ancestor height ${parentHeight}; hidden, moderated, or unreturned replies cannot be verified`);
    const bskyUrl = (uri: string, handle?: string) => {
      const match = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/.exec(uri);
      return match ? `https://bsky.app/profile/${encodeURIComponent(handle || match[1]!)}/post/${encodeURIComponent(match[2]!)}` : parsed.canonicalUrl;
    };
    const parsePost = (p: Json, from?: string, kind: ThreadEdge["kind"] = "reply", quoteDepth = 0): string => {
      const record = obj(p.record ?? p.value), author = obj(p.author), id = str(p.uri);
      if (!id) { limits.add("Malformed Bluesky post with missing URI omitted"); return ""; }
      edge(from, id, kind);
      const handle = str(author.handle) || str(author.did) || "unknown", text = str(record.text);
      let embed = obj(p.embed ?? list(p.embeds)[0]);
      const quoteEmbed = str(embed.$type).endsWith("recordWithMedia#view") ? obj(embed.record) : embed;
      const quote = obj(quoteEmbed.record);
      if (str(embed.$type).endsWith("recordWithMedia#view")) embed = obj(embed.media);
      const external = obj(embed.external), externalUrl = safeUrl(str(external.uri));
      const assets = list(embed.images).flatMap(v => { const image = obj(v); return media(str(image.fullsize) || str(image.thumb), "image", str(image.alt)); });
      if (str(embed.$type).endsWith("video#view")) assets.push(...media(str(embed.playlist), "video", str(embed.alt)));
      if (!add({ id, ...(str(p.cid) ? { cid: str(p.cid) } : {}), url: bskyUrl(id, handle), author: { handle, ...(str(author.did) ? { did: str(author.did) } : {}), ...(str(author.displayName) ? { name: str(author.displayName) } : {}) }, ...(str(record.createdAt) ? { postedAt: str(record.createdAt) } : {}), text, segments: threadTextSegments(text, record.facets), ...(externalUrl ? { external: { url: externalUrl, title: str(external.title), description: str(external.description) } } : {}), media: assets, status: "available" })) return id;
      if (Object.keys(quote).length) {
        if (quoteDepth >= depth) limits.add(`Quote depth ${depth} reached`);
        else if (quote.value || quote.record) parsePost(quote, id, "quote", quoteDepth + 1);
        else { const qid = str(quote.uri); if (qid) { edge(id, qid, "quote"); placeholder(qid, bskyUrl(qid), str(quote.$type).includes("Blocked") ? "blocked" : "deleted"); limits.add("Unavailable quoted record"); } }
      }
      return id;
    };
    const visit = (value: unknown, from?: string, kind: ThreadEdge["kind"] = "reply", level = 0, parents = 0): void => {
      abort(); const node = obj(value), p = obj(node.post), id = str(p.uri) || str(node.uri);
      if (!id) { limits.add("Malformed or empty Bluesky thread node omitted"); return; }
      if (capture.posts.length >= maxPosts && !seen.has(id)) { limits.add(`Post cap ${maxPosts} reached`); return; }
      edge(from, id, kind);
      const remaining = depth - level;
      if ((expanded.get(id) ?? -1) >= remaining) return; expanded.set(id, remaining);
      if (!Object.keys(p).length) { placeholder(id, bskyUrl(id), str(node.$type).includes("blocked") ? "blocked" : "deleted"); limits.add("Deleted or blocked thread node"); return; }
      parsePost(p, from, kind);
      if (node.parent) { if (parents < parentHeight) visit(node.parent, id, "ancestor", level, parents + 1); else limits.add(`Ancestor height ${parentHeight} reached`); }
      const replies = list(node.replies).sort((a,b) => {
        const pa = obj(obj(a).post), pb = obj(obj(b).post);
        const preferredA = preferred.has(str(obj(pa.author).handle).toLowerCase()), preferredB = preferred.has(str(obj(pb.author).handle).toLowerCase());
        return Number(preferredB) - Number(preferredA) || str(obj(pa.record).createdAt).localeCompare(str(obj(pb.record).createdAt));
      }), replyCount = finite(p.replyCount) ?? 0;
      if (treeScope && replies.length && level < depth) for (const reply of replies) {
        const author = str(obj(obj(obj(reply).post).author).handle).toLowerCase();
        if (options.selectedAuthors?.length && author && !preferred.has(author)) deferredReplies.push({ value: reply, from: id, level: level + 1, parents });
        else visit(reply, id, "reply", level + 1, parents);
      }
      else if (treeScope && (replies.length || replyCount > 0)) limits.add(level >= depth ? `Reply depth ${depth} reached` : "Public API did not return all counted replies");
      if (treeScope && replyCount > replies.length) limits.add("Reply count exceeds returned children; coverage is incomplete");
      if (treeScope && kind !== "ancestor" && preferred.has(str(obj(p.author).handle).toLowerCase()) && replyCount > 0 && (level >= depth || replyCount > replies.length) && !fetched.has(id)) frontier.push(id);
    };
    const uri = `at://${parsed.handle}/app.bsky.feed.post/${parsed.id}`;
    const requestTree = async (target: string, initial: boolean) => {
      fetched.add(target);
      const endpoint = new URL("https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread");
      endpoint.searchParams.set("uri", target); endpoint.searchParams.set("depth", String(depth)); endpoint.searchParams.set("parentHeight", initial ? String(parentHeight) : "0");
      try { const payload = obj(await json(endpoint.href)); const returnedUri = str(obj(obj(payload.thread).post).uri); if (returnedUri) fetched.add(returnedUri); visit(payload.thread); }
      catch (error) { abort(); capture.coverage.errors.push(`${target}: ${error instanceof Error ? error.message : String(error)}`); if (initial) placeholder(uri, parsed.canonicalUrl, "unavailable"); }
    };
    await requestTree(uri, true);
    while (frontier.length && capture.posts.length < maxPosts && requests < maxRequests) {
      const target = frontier.shift()!; if (!fetched.has(target)) await requestTree(target, false);
    }
    for (const deferred of deferredReplies) visit(deferred.value, deferred.from, "reply", deferred.level, deferred.parents);
    if (frontier.some(uri => !fetched.has(uri))) limits.add(`Selected-author continuation frontier remains (${frontier.filter(uri => !fetched.has(uri)).length} pointers); public request or post cap prevented expansion`);
    capture.coverage.scope += `; prioritized authors: ${[...preferred].join(", ")}; bounded continuation reads: ${requests - 1}`;

  }
  capture.coverage.limits = [...limits]; capture.coverage.capturedPosts = capture.posts.length;
  capture.coverage.availablePosts = capture.posts.filter(p => p.status === "available").length;
  capture.coverage.mediaWithoutDescriptions = capture.posts.flatMap(p => p.media).filter(m => !m.description?.text).length;
  if (capture.coverage.mediaWithoutDescriptions) capture.coverage.limits.push(`${capture.coverage.mediaWithoutDescriptions} media assets have no reviewed visual description; source alt text is separately labeled`);
  return capture;
}

const html = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const md = (s: string) => html(s.replace(/([\\`*_{}\[\]()#+.!|>~-])/g, "\\$1"));
/** Preserve source Markdown emphasis, lists and line breaks, while neutralizing HTML and unsafe inline/reference links. */
function safeMarkdown(text: string): string {
  return html(text).replace(/!?\[([^\]\n]*)\]\(([^\n]*)\)/g, (match, label: string, destination: string) => {
    const url = safeUrl(destination.trim().replace(/^&lt;|&gt;$/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'"));
    return url ? `${match.startsWith("!") ? "!" : ""}[${label}](<${url}>)` : md(match);
  }).replace(/^([ \t>]*?)\[([^\]\n]+)\]:.*$/gm, match => md(match));
}
function formattedHtml(text: string): string {
  const fragments: string[] = [];
  const token = (value: string) => { const index = fragments.push(value) - 1; return `\u0000${index}\u0000`; };
  let escaped = html(text.replace(/\u0000/g, ""));
  escaped = escaped.replace(/`([^`\n]+)`/g, (_match, content: string) => token(`<code>${content}</code>`));
  escaped = escaped.replace(/\[([^\]\n]+)\]\(([^\n]*)\)/g, (match, label: string, destination: string) => {
    const url = safeUrl(destination.trim().replace(/^&lt;|&gt;$/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'"));
    return url ? token(`<a href="${html(url)}" rel="noreferrer noopener">${label}</a>`) : match;
  });
  escaped = escaped.replace(/https?:\/\/[^\s<\u0000]+/g, match => {
    const trailing = /[.,;!?]+$/.exec(match)?.[0] ?? "";
    const label = trailing ? match.slice(0, -trailing.length) : match;
    const url = safeUrl(label.replace(/&amp;/g, "&"));
    return url ? token(`<a href="${html(url)}" rel="noreferrer noopener">${label}</a>`) + trailing : match;
  });
  escaped = escaped.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>").replace(/__([^_\n]+)__/g, "<strong>$1</strong>").replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<em>$1</em>").replace(/(?<![\w_])_([^_\n]+)_(?![\w_])/g, "<em>$1</em>");
  return escaped.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => fragments[Number(index)] ?? "");
}
const link = (label: string, url: string) => safeUrl(url) ? `[${md(label)}](<${safeUrl(url)!}>)` : md(label);
export function threadCoverageReport(capture: ThreadCapture): string {
  return [`Coverage: incomplete / unverified (${capture.coverage.availablePosts}/${capture.coverage.capturedPosts} posts available).`, `Scope: ${capture.coverage.scope}.`, ...capture.coverage.limits.map(s => `Limit: ${s}`), ...capture.coverage.errors.map(s => `Error: ${s}`)].join("\n");
}
function displayPosts(capture: ThreadCapture): ThreadPost[] {
  const quoteIds = new Set(capture.edges.filter(e => e.kind === "quote").map(e => e.to));
  return capture.posts.filter(p => !quoteIds.has(p.id) || p.url === capture.sourceUrl || capture.edges.some(e => e.kind !== "quote" && e.to === p.id)).sort((a,b) => { const timeA = Date.parse(a.postedAt ?? ""), timeB = Date.parse(b.postedAt ?? ""); return Number.isFinite(timeA) && Number.isFinite(timeB) ? timeA - timeB : 0; });
}
export function renderThreadMarkdown(capture: ThreadCapture): string {
  const lines = ["# Thread capture", "", `Source: ${link(capture.sourceUrl, capture.sourceUrl)}`, `Captured: ${md(capture.capturedAt)}`, "", ...threadCoverageReport(capture).split("\n").map(line => `- ${md(line)}`), ""];
  const renderPost = (post: ThreadPost, visited: Set<string>, quoted: boolean): string[] => {
    if (visited.has(post.id)) return [link("Repeated quote — original post", post.url)];
    const path = new Set(visited).add(post.id);
      const body = [`${quoted ? "**" : "### "}${md(post.author.name || post.author.handle)}${quoted ? "**" : ""} \`@${post.author.handle.replace(/[`\\]/g, "")}\``, "", `${link("Original post", post.url)} · ${md(post.postedAt || "Date unavailable")}`, ""];
    const reply = capture.edges.find(e => e.to === post.id && e.kind === "reply") ?? capture.edges.find(e => e.from === post.id && e.kind === "ancestor");
    if (reply && !quoted) { const parent = capture.posts.find(p => p.id === (reply.kind === "reply" ? reply.from : reply.to)); body.push(parent ? `Reply to ${link(`@${parent.author.handle}`, parent.url)}` : "Reply parent unavailable", ""); }
    for (const e of capture.edges.filter(e => e.from === post.id && e.kind === "quote")) {
      const quote = capture.posts.find(p => p.id === e.to);
      body.push(...(quote ? renderPost(quote, path, true) : ["Quoted post unavailable"]).flatMap(line => line.split("\n").map(part => `> ${part}`)), "");
    }
    body.push(post.status === "available" ? post.segments.map(segment => segment.url ? link(segment.text, segment.url) : safeMarkdown(segment.text)).join("") : md(`[${post.status} — original content unavailable]`));
    if (post.external) body.push("", `Embedded link: ${link(post.external.title || post.external.url, post.external.url)}`, md(post.external.description));
    if (post.article) body.push("", safeMarkdown(post.article));
    for (const [n, m] of post.media.entries()) {
      body.push("", link(`${m.kind === "image" ? "Image" : "Video"} ${n + 1}`, m.url));
      if (m.kind === "image" && safeUrl(m.url)) body.push(`![${md(`Image ${n + 1}; ${m.alt || "no source alt text"}`)}](<${safeUrl(m.url)!}>)`);
      body.push(`Source alt text: ${m.alt ? md(m.alt) : "Not supplied"}`, "");
      body.push(m.description ? `Visual description (${m.description.basis === "pixels" ? "reviewed pixels" : "source alt text"}): ${md(m.description.text)}${m.description.evidence ? ` — Evidence: ${md(m.description.evidence)}` : ""}` : "Visual description: Pending image review; no visual claims made.");
    }
    return body;
  };
  for (const post of displayPosts(capture)) lines.push(...renderPost(post, new Set(), false), "", "---", "");
  return lines.join("\n") + "\n";
}
export function renderThreadHtml(capture: ThreadCapture, options: { inlineImages?: Record<string, string> } = {}): string {
  if (options.inlineImages) for (const image of Object.values(options.inlineImages)) if (!/^data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/]+={0,2}$/.test(image)) throw new Error("Inline thread images must be base64 JPEG or PNG data URLs");
  const imageSource = (url: string) => options.inlineImages ? options.inlineImages[url] : safeUrl(url);
  const anchor = (label: string, url: string) => safeUrl(url) ? `<a href="${html(safeUrl(url)!)}" rel="noreferrer noopener">${html(label)}</a>` : html(label);
  const renderPost = (p: ThreadPost, visited: Set<string>, quoted: boolean): string => {
    if (visited.has(p.id)) return `<p>${anchor("Repeated quote — original post", p.url)}</p>`;
    const path = new Set(visited).add(p.id);
    const quotes = capture.edges.filter(e => e.from === p.id && e.kind === "quote").map(e => {
      const quote = capture.posts.find(p => p.id === e.to); return `<blockquote>${quote ? renderPost(quote, path, true) : "Quoted post unavailable"}</blockquote>`;
    }).join("");
    const reply = capture.edges.find(e => e.to === p.id && e.kind === "reply") ?? capture.edges.find(e => e.from === p.id && e.kind === "ancestor");
    const parent = reply && capture.posts.find(p => p.id === (reply.kind === "reply" ? reply.from : reply.to));
    const relation = reply && !quoted ? `<p class="relation">${parent ? `Reply to ${anchor(`@${parent.author.handle}`, parent.url)}` : "Reply parent unavailable"}</p>` : "";
    return `<${quoted ? "section" : "article"}><h2>${html(p.author.name || p.author.handle)} <small>@${html(p.author.handle)}</small></h2><p>${anchor("Original post", p.url)} · ${html(p.postedAt || "Date unavailable")}</p>${relation}${quotes}<div class="text">${p.status === "available" ? p.segments.map(s => s.url ? anchor(s.text, s.url) : formattedHtml(s.text)).join("") : html(`[${p.status} — original content unavailable]`)}</div>${p.external ? `<aside><p>Embedded link: ${anchor(p.external.title || p.external.url, p.external.url)}</p><p>${html(p.external.description)}</p></aside>` : ""}${p.article ? `<div class="text article">${formattedHtml(p.article)}</div>` : ""}${p.media.map((m, n) => `<figure>${m.kind === "image" && imageSource(m.url) ? `<img src="${html(imageSource(m.url)!)}" alt="${html(m.alt || `Image ${n + 1}; no source alt text`)}" loading="lazy" referrerpolicy="no-referrer">` : anchor(`${m.kind === "image" ? "Image" : "Video"} ${n + 1}`, m.url)}<figcaption>${anchor(`Original ${m.kind} ${n + 1}`, m.url)}<p>Source alt text: ${html(m.alt || "Not supplied")}</p><p>${m.description ? `Visual description (${html(m.description.basis)}): ${html(m.description.text)}${m.description.evidence ? ` — Evidence: ${html(m.description.evidence)}` : ""}` : "Visual description: Pending image review; no visual claims made."}</p></figcaption></figure>`).join("")}</${quoted ? "section" : "article"}>`;
  };
  const posts = displayPosts(capture).map(p => renderPost(p, new Set(), false)).join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${options.inlineImages ? 'data:' : 'https: http:'}; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>Thread capture</title><style>body{font:17px/1.6 system-ui,sans-serif;max-width:820px;margin:auto;padding:32px;color:#252521;background:#faf9f6}article{border-top:1px solid #ccc;margin-top:32px;padding-top:20px}h2{font-size:22px}small,.relation,figcaption{color:#555;font-size:14px}.text,pre{white-space:pre-wrap;overflow-wrap:anywhere}img{max-width:100%;height:auto}figure{margin:24px 0}a{color:#174f79}pre{font-family:inherit}blockquote{margin:20px 0;padding:4px 16px;border-left:3px solid #a7b5b7;background:#f0f1ed}blockquote h2{font-size:18px}</style></head><body><h1>Thread capture</h1><p>${anchor(capture.sourceUrl, capture.sourceUrl)} · ${html(capture.capturedAt)}</p><pre>${html(threadCoverageReport(capture))}</pre>${posts}</body></html>`;
}
