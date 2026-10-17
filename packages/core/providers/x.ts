import { compositionPolicySchema, MAX_EXPANDED_SOURCE_POSTS, MAX_QUOTE_DEPTH, type MediaAsset, type QuoteCoverage, type ResolvedPost } from "../types.ts";
import type { ParsedSource } from "../url.ts";
import type { SocialProvider, SourceResolutionPolicy } from "./provider.ts";
import { renderedQuoteDepth } from "../quote-policy.ts";
import { articleMarkdown } from "./x-article.ts";
import type { Fetcher } from "./comments.ts";

type Json = Record<string, unknown>;

function object(value: unknown): Json | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function publicPoster(value: unknown): string | undefined {
  const raw = string(value);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}

function mediaFromTweet(tweet: Json): MediaAsset[] {
  const media = object(tweet.media);
  const all = Array.isArray(media?.all)
    ? media.all
    : [media?.photos, media?.videos, media?.animated_gifs].flatMap((value) =>
        Array.isArray(value) ? value : [],
      );
  return all.flatMap((value) => {
    const item = object(value);
    if (!item) return [];
    const type = string(item.type) ?? "photo";
    const variants: Json[] = Array.isArray(item.variants)
      ? item.variants.flatMap((variant): Json[] => {
          const parsed = object(variant);
          return parsed ? [parsed] : [];
        })
      : [];
    const bestVariant = variants
      .filter((variant) => string(variant.url)?.includes(".mp4"))
      .sort((a, b) => (number(b.bitrate) ?? 0) - (number(a.bitrate) ?? 0))[0];
    const url =
      (type === "video" || type === "gif"
        ? string(bestVariant?.url) ?? string(item.url)
        : string(item.url)) ?? string(item.thumbnail_url);
    if (!url) return [];
    const size = object(item.original_info) ?? object(item.size);
    const durationSeconds = number(item.duration) ?? (number(item.duration_ms) === undefined ? undefined : number(item.duration_ms)! / 1000);
    return [{
      ref: "0.0",
      kind: type === "photo" ? "image" as const : "video" as const,
      url,
      ...(string(item.id) || string(item.id_str) ? { id: string(item.id) ?? string(item.id_str) } : {}),
      ...(number(item.width) ?? number(size?.width) ? { width: number(item.width) ?? number(size?.width) } : {}),
      ...(number(item.height) ?? number(size?.height) ? { height: number(item.height) ?? number(size?.height) } : {}),
      ...(type !== "photo" && durationSeconds && durationSeconds > 0 ? { durationSeconds } : {}),
      ...(type !== "photo" && publicPoster(item.thumbnail_url) ? { posterUrl: publicPoster(item.thumbnail_url) } : {}),
      alt: string(item.alt) ?? string(item.altText) ?? string(item.ext_alt_text) ?? "",
    }];
  });
}

function withoutArticleLink(text: string, articleId: string | undefined): string {
  const link = articleId && /^\d+$/.test(articleId) ? `https://x.com/i/article/${articleId}` : undefined;
  const trimmed = text.trimEnd();
  return (link && trimmed.endsWith(link) ? trimmed.slice(0, -link.length) : trimmed).trim();
}

function replyAddressPrefix(tweet: Json, expandedText: string): string | undefined {
  const raw = object(tweet.raw_text), rawText = string(raw?.text), range = raw?.display_text_range;
  if (!rawText || !Array.isArray(range) || range.length !== 2 || !Number.isSafeInteger(range[0])
    || !Number.isSafeInteger(range[1]) || range[0] <= 0 || range[1] < range[0]
    || range[1] > rawText.length || !Array.isArray(raw?.facets)) return undefined;
  const end = range[0] as number, prefix = rawText.slice(0, end);
  if (!expandedText.startsWith(prefix)) return undefined;
  const facets = raw.facets.map(object);
  if (facets.some(facet => !facet || !Array.isArray(facet.indices) || facet.indices.length !== 2
    || !Number.isSafeInteger(facet.indices[0]) || !Number.isSafeInteger(facet.indices[1]))) return undefined;
  const leading = facets.filter(facet => (facet!.indices as number[])[0]! < end)
    .sort((a, b) => (a!.indices as number[])[0]! - (b!.indices as number[])[0]!);
  if (!leading.length) return undefined;
  let cursor = 0;
  for (const facet of leading) {
    const [start, stop] = facet!.indices as [number, number];
    if (facet!.type !== "mention" || start < cursor || stop > end || stop <= start
      || !/^\s*$/u.test(rawText.slice(cursor, start))
      || !/^@[A-Za-z0-9_]+$/u.test(rawText.slice(start, stop))) return undefined;
    cursor = stop;
  }
  return /^\s*$/u.test(rawText.slice(cursor, end)) ? prefix : undefined;
}

function postFromTweet(tweet: Json, fallback: Extract<ParsedSource, { provider: "x" }>): ResolvedPost {
  const author = object(tweet.author);
  const handle = string(author?.screen_name) ?? string(author?.screenName) ?? fallback.handle;
  const id = string(tweet.id) ?? string(tweet.id_str) ?? fallback.id;
  const canonicalUrl = `https://x.com/${handle}/status/${id}`;
  const article = object(tweet.article);
  const text = string(tweet.text) ?? string(object(tweet.raw_text)?.text) ?? "";
  const reply = object(tweet.replying_to);
  const replyId = string(tweet.replying_to_status) ?? string(reply?.status) ?? string(tweet.in_reply_to_status_id_str)
    ?? string(tweet.in_reply_to_status_id);
  const replyAuthor = string(tweet.replying_to) ?? string(reply?.screen_name) ?? string(tweet.in_reply_to_screen_name);
  const displayReplyPrefix = replyId && /^\d+$/.test(replyId) ? replyAddressPrefix(tweet, text) : undefined;
  return {
    provider: "x",
    id,
    canonicalUrl,
    author: {
      handle,
      ...(string(author?.name) ? { name: string(author?.name) } : {}),
    },
    text: article ? withoutArticleLink(text, string(article.id)) : text,
    ...(replyId && /^\d+$/.test(replyId) ? { replyTo: { id: replyId, ...(replyAuthor ? { authorHandle: replyAuthor } : {}) } } : {}),
    ...(displayReplyPrefix ? { replyAddressPrefix: displayReplyPrefix } : {}),
    ...(article ? { article: articleMarkdown(article) } : {}),
    ...(string(tweet.created_at) ?? string(tweet.date) ? { postedAt: string(tweet.created_at) ?? string(tweet.date) } : {}),
    media: mediaFromTweet(tweet),
  };
}

function abort(signal?: AbortSignal): void { if (signal?.aborted) throw signal.reason ?? new Error("The operation was aborted"); }
function quoteReference(tweet: Json): { hasQuote: boolean; authorKnown?: boolean; embedded?: Json; source?: Extract<ParsedSource, { provider: "x" }> } {
  const embedded = object(tweet.quote);
  const id = string(embedded?.id) ?? string(embedded?.id_str) ?? string(tweet.quote_id) ?? string(tweet.quoted_status_id_str);
  const hasQuote = Boolean(embedded || id || tweet.is_quote_status === true);
  if (!id || !/^\d+$/.test(id)) return { hasQuote, ...(embedded ? { embedded } : {}) };
  const author = object(embedded?.author), supplied = string(author?.screen_name) ?? string(author?.screenName);
  const authorKnown = Boolean(supplied && /^[A-Za-z0-9_]+$/.test(supplied));
  const handle = authorKnown ? supplied! : "i";
  return { hasQuote, authorKnown, ...(embedded ? { embedded } : {}), source: { provider: "x", id, handle, canonicalUrl: `https://x.com/${handle}/status/${id}` } };
}

class SourceReadError extends Error { constructor(message: string, readonly status?: number) { super(message); } }
function tombstoneReason(value: Json): string {
  const reason = string(value.reason);
  return reason && ["deleted", "private", "suspended", "blocked", "unavailable"].includes(reason) ? reason : "unavailable";
}

export class XProvider implements SocialProvider {
  private readonly cache = new Map<string, { tweet: Json; expiresAt: number }>();
  constructor(private readonly apiBase = "https://api.fxtwitter.com", private readonly fetcher: Fetcher = fetch) {}

  clearCache(): void { this.cache.clear(); }

  /** Import a provider-observed same-author linear chain from any member. */
  async discoverLinear(source: ParsedSource, signal?: AbortSignal,
                       policy: Partial<SourceResolutionPolicy> = {}): Promise<{ posts: ResolvedPost[]; seedId: string }> {
    if (source.provider !== "x") throw new Error("x.com thread import needs an x.com post");
    const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000);
    let response: Response;
    try {
      response = await this.fetcher(`${this.apiBase}/2/thread/${source.id}`, {
        headers: { accept: "application/json", "user-agent": "arena-block/0.1" },
        signal: bounded, redirect: "error", credentials: "omit",
      });
    } catch {
      abort(bounded);
      throw new SourceReadError("x.com thread discovery could not reach the public source");
    }
    abort(bounded);
    if (response.redirected) throw new SourceReadError("x.com thread read unexpectedly redirected");
    if (response.status === 429) throw new SourceReadError("x.com thread discovery is rate limited (HTTP 429); retry later", 429);
    if (response.status === 401 || response.status === 403) throw new SourceReadError(`x.com thread discovery was denied by the public source (HTTP ${response.status}); the thread may require access`, response.status);
    if (response.status === 404 || response.status === 410) throw new SourceReadError(`x.com thread source is unavailable (HTTP ${response.status}); it may have been removed`, response.status);
    if (!response.ok) throw new SourceReadError(`x.com thread discovery failed (HTTP ${response.status})`, response.status);
    const text = await response.text(); abort(bounded);
    if (text.length > 8 * 1024 * 1024) throw new SourceReadError("x.com thread response exceeds the bounded read limit");
    let payload: Json | undefined;
    try { payload = object(JSON.parse(text)); }
    catch { throw new SourceReadError("x.com thread discovery returned invalid JSON"); }
    const code = number(payload?.code);
    if (code === 429) throw new SourceReadError("x.com thread discovery is rate limited (source status 429); retry later", code);
    const status = object(payload?.status);
    if (status?.type === "tombstone") throw new SourceReadError(`x.com requested post is ${tombstoneReason(status)}`);
    if (code === 401 || code === 403) throw new SourceReadError(`x.com thread discovery was denied by the public source (source status ${code}); the thread may require access`, code);
    if (code === 404 || code === 410) throw new SourceReadError(`x.com thread source is unavailable (source status ${code}); it may have been removed`, code);
    if (code !== 200) throw new SourceReadError(`x.com thread discovery returned source status ${code ?? "missing"}`, code);
    if (!status) throw new SourceReadError("x.com thread discovery returned no requested post");
    if (string(status.id) !== source.id) throw new SourceReadError(`x.com thread discovery returned a different source post (requested ${source.id}, received ${string(status.id) ?? "none"})`);
    const chain = payload?.thread;
    if (!Array.isArray(chain)) throw new SourceReadError("x.com thread discovery returned no thread array");
    if (!chain.length) throw new SourceReadError("x.com thread discovery returned an empty thread");
    const cursor = object(payload?.cursor);
    if (payload?.truncated === true || payload?.has_more === true || string(cursor?.bottom) || string(cursor?.next))
      throw new SourceReadError("x.com thread discovery returned a paginated or truncated thread; a complete import is unavailable");
    const tweets = chain.map(object);
    if (tweets.some(tweet => !tweet)) throw new SourceReadError("x.com thread contains an unreadable post; add posts explicitly");
    const tombstone = tweets.find(tweet => tweet?.type === "tombstone");
    if (tombstone) throw new SourceReadError(`x.com thread contains a ${tombstoneReason(tombstone)} post (${string(tombstone.id) ?? "unknown id"}); complete import is unavailable`);
    if (chain.length > MAX_EXPANDED_SOURCE_POSTS)
      throw new SourceReadError(`x.com thread has ${chain.length} posts, above the ${MAX_EXPANDED_SOURCE_POSTS}-post import limit`);
    const firstAuthor = object(tweets[0]!.author);
    const authorID = string(firstAuthor?.id);
    const authorHandle = string(firstAuthor?.screen_name)?.toLowerCase();
    if (!authorID && !authorHandle) throw new SourceReadError("x.com thread author identity is missing");
    const seen = new Set<string>();
    for (const [index, tweet] of tweets.entries()) {
      const id = string(tweet!.id) ?? string(tweet!.id_str);
      const author = object(tweet!.author);
      const sameAuthor = authorID && string(author?.id) ? string(author?.id) === authorID
        : string(author?.screen_name)?.toLowerCase() === authorHandle;
      const parent = object(tweet!.replying_to);
      const parentID = string(parent?.status) ?? string(tweet!.replying_to_status);
      if (!id || !/^\d+$/.test(id) || seen.has(id) || !string(author?.screen_name)) {
        throw new SourceReadError("x.com thread identity or order is inconsistent; select posts explicitly");
      }
      if (!sameAuthor) throw new SourceReadError(`x.com thread contains a post by another author (${id}); select the desired branch explicitly`);
      seen.add(id);
      if (index > 0 && parentID !== (string(tweets[index - 1]!.id) ?? string(tweets[index - 1]!.id_str))) {
        throw new SourceReadError("x.com thread branches or skips a reply; select the desired posts explicitly");
      }
      if (index === 0 && parentID && (string(parent?.screen_name)?.toLowerCase() === authorHandle || !parent?.screen_name)) {
        throw new SourceReadError("x.com thread begins after an unobserved same-author parent; add posts explicitly");
      }
    }
    if (!seen.has(source.id)) throw new SourceReadError("The requested x.com post is missing from its thread");
    const member = tweets.find(tweet => (string(tweet?.id) ?? string(tweet?.id_str)) === source.id)!;
    const memberAuthor = object(member.author), statusAuthor = object(status.author);
    const memberAuthorId = string(memberAuthor?.id), statusAuthorId = string(statusAuthor?.id);
    if (statusAuthorId && memberAuthorId && statusAuthorId !== memberAuthorId)
      throw new SourceReadError("x.com thread discovery returned a source author mismatch");
    for (const tweet of tweets) {
      const id = string(tweet!.id) ?? string(tweet!.id_str)!;
      if (this.cache.size >= 128) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(id, { tweet: tweet!, expiresAt: Date.now() + 5 * 60_000 });
    }
    const posts = await Promise.all(tweets.map(tweet => this.resolve({ provider: "x", id: string(tweet!.id) ?? string(tweet!.id_str)!,
      handle: string(object(tweet!.author)?.screen_name)!, canonicalUrl: `https://x.com/${string(object(tweet!.author)?.screen_name)!}/status/${string(tweet!.id) ?? string(tweet!.id_str)!}` }, bounded, policy)));
    return { posts, seedId: source.id };
  }

  private async read(source: Extract<ParsedSource, { provider: "x" }>, signal: AbortSignal): Promise<Json> {
    abort(signal);
    const old = this.cache.get(source.id);
    if (old && old.expiresAt > Date.now()) return old.tweet;
    const response = await this.fetcher(`${this.apiBase}/${encodeURIComponent(source.handle)}/status/${source.id}`, {
      headers: { accept: "application/json", "user-agent": "arena-block/0.1" }, signal, redirect: "error", credentials: "omit",
    });
    abort(signal);
    if (!response.ok) throw new SourceReadError(`FxTwitter returned ${response.status} for ${source.canonicalUrl}`, response.status);
    if (response.redirected) throw new SourceReadError("FxTwitter source read unexpectedly redirected");
    const text = await response.text();
    abort(signal);
    if (text.length > 2 * 1024 * 1024) throw new SourceReadError("FxTwitter source response exceeds 2 MiB characters");
    const payload = object(JSON.parse(text)), tweet = object(payload?.tweet);
    const code = number(payload?.code);
    if (code !== undefined && code !== 200) throw new SourceReadError(`FxTwitter returned source status ${code} for ${source.canonicalUrl}`, code);
    if (!tweet) throw new SourceReadError(`FxTwitter returned no tweet for ${source.canonicalUrl}`);
    if ((string(tweet.id) ?? string(tweet.id_str)) !== source.id) throw new SourceReadError("FxTwitter returned a different source post");
    if (this.cache.size >= 128) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(source.id, { tweet, expiresAt: Date.now() + 5 * 60_000 });
    return tweet;
  }

  async resolve(source: ParsedSource, signal?: AbortSignal, policy: Partial<SourceResolutionPolicy> = {}): Promise<ResolvedPost> {
    if (source.provider !== "x") throw new Error("XProvider received a non-x.com source");
    const acquisitionDepth = renderedQuoteDepth(compositionPolicySchema.parse(policy));
    const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000);
    let tweet = await this.read(source, bounded);
    const root = postFromTweet(tweet, source), sourceIds = [root.id], visited = new Set(sourceIds);
    let parent = root, actualDepth = 0, hasQuotes = false;
    let stopped: QuoteCoverage["stopped"] = "end", incomplete: "unavailable" | "deleted" | undefined;
    while (true) {
      abort(bounded);
      const reference = quoteReference(tweet);
      if (!reference.hasQuote) break;
      hasQuotes = true;
      const next = reference.source;
      const boundary = next ? { id: next.id, canonicalUrl: next.canonicalUrl } : {};
      if (!next) { parent.quoteBoundary = { ...boundary, status: "invalid_reference" }; stopped = "invalid_reference"; break; }
      if (visited.has(next.id)) { parent.quoteBoundary = { ...boundary, status: "cycle" }; stopped = "cycle"; break; }
      if (actualDepth >= acquisitionDepth) { parent.quoteBoundary = { ...boundary, status: "depth_limit" }; stopped = "depth_limit"; break; }
      let snapshot: ResolvedPost["quoteSnapshot"];
      try {
        tweet = await this.read(next, bounded);
        const author = object(tweet.author), supplied = string(author?.screen_name) ?? string(author?.screenName);
        if (!reference.authorKnown && (!supplied || !/^[A-Za-z0-9_]+$/.test(supplied))) throw new SourceReadError("Quoted source has no observed author identity");
      }
      catch (error) {
        abort(bounded);
        const status = error instanceof SourceReadError && [404, 410].includes(error.status ?? 0) ? "deleted" : "unavailable";
        const embedded = reference.embedded;
        if (!embedded || !reference.authorKnown || (typeof embedded.text !== "string" && !object(embedded.article) && !object(embedded.media))) {
          parent.quoteBoundary = { ...boundary, status }; stopped = status; break;
        }
        // Keep the embedded quote and record the failed read of its own URL.
        tweet = embedded; snapshot = { basis: "embedded", hydration: status }; incomplete = status;
      }
      const quoted = postFromTweet(tweet, next);
      if (snapshot) quoted.quoteSnapshot = snapshot;
      parent.quote = quoted; parent = quoted; actualDepth += 1;
      visited.add(quoted.id); sourceIds.push(quoted.id);
    }
    abort(bounded);
    if (hasQuotes) root.quoteCoverage = { maxDepth: MAX_QUOTE_DEPTH, actualDepth,
      acquisitionDepth, mayExpand: stopped === "depth_limit" && acquisitionDepth < MAX_QUOTE_DEPTH,
      maxReached: stopped === "depth_limit" && acquisitionDepth === MAX_QUOTE_DEPTH,
      truncated: stopped !== "end" || Boolean(incomplete), stopped: stopped === "end" && incomplete ? incomplete : stopped, sourceIds };
    return root;
  }
}
