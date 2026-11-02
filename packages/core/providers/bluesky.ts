import type {} from "@atcute/bluesky";
import { Client, ok, simpleFetchHandler } from "@atcute/client";
import type { ResourceUri } from "@atcute/lexicons";
import { resolvedPostSchema, type MediaAsset, type ResolvedPost } from "../types.ts";
import type { ParsedSource } from "../url.ts";
import type { SocialProvider } from "./provider.ts";

type Json = Record<string, unknown>;

function object(value: unknown): Json | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function safePoster(value: unknown): string | undefined {
  const raw = string(value);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}

function mediaFromEmbed(embed: Json | undefined): MediaAsset[] {
  if (!embed) return [];
  const type = string(embed.$type) ?? "";
  if (type.endsWith("recordWithMedia#view")) return mediaFromEmbed(object(embed.media));
  if (type.endsWith("images#view")) {
    return (Array.isArray(embed.images) ? embed.images : []).flatMap((value) => {
      const image = object(value);
      const url = string(image?.fullsize) ?? string(image?.thumb);
      if (!image || !url) return [];
      const aspect = object(image.aspectRatio);
      return [{
        ref: "0.0",
        kind: "image" as const,
        url,
        ...(number(aspect?.width) ? { width: number(aspect?.width) } : {}),
        ...(number(aspect?.height) ? { height: number(aspect?.height) } : {}),
        alt: string(image.alt) ?? "",
      }];
    });
  }
  if (type.endsWith("video#view")) {
    const url = string(embed.playlist);
    if (!url) return [];
    const aspect = object(embed.aspectRatio);
    return [{
      ref: "0.0",
      kind: "video",
      url,
      ...(safePoster(embed.thumbnail) ? { posterUrl: safePoster(embed.thumbnail) } : {}),
      ...(number(aspect?.width) ? { width: number(aspect?.width) } : {}),
      ...(number(aspect?.height) ? { height: number(aspect?.height) } : {}),
      alt: string(embed.alt) ?? "",
    }];
  }
  return [];
}

function quotedRecord(embed: Json | undefined): Json | undefined {
  if (!embed) return undefined;
  const type = string(embed.$type) ?? "";
  if (type.endsWith("recordWithMedia#view")) return object(embed.record)?.record as Json | undefined;
  if (type.endsWith("record#view")) return object(embed.record);
  return undefined;
}

function postFromView(post: Json, fallback: Extract<ParsedSource, { provider: "bluesky" }>): ResolvedPost {
  const author = object(post.author);
  const record = object(post.record) ?? object(post.value) ?? {};
  const uri = string(post.uri) ?? `at://${fallback.handle}/app.bsky.feed.post/${fallback.id}`;
  const id = uri.split("/").at(-1) ?? fallback.id;
  const handle = string(author?.handle) ?? fallback.handle;
  const embed = object(post.embed) ?? (Array.isArray(post.embeds) ? object(post.embeds[0]) : undefined);
  const quoteRecord = quotedRecord(embed);
  const facets = record.$type === "app.bsky.feed.post" ? record.facets : undefined;
  if (facets !== undefined && !Array.isArray(facets)) throw new Error("Bluesky rich-text facets are malformed");
  const withFacets = Array.isArray(facets) && facets.length > 0;
  const cid = string(post.cid), did = string(author?.did);
  if (withFacets && (!cid || !did || uri !== `at://${did}/app.bsky.feed.post/${id}`)) throw new Error("Bluesky facet source is missing its record identity");
  // Normalize derived fields before a plan is hashed; keep the raw record below.
  return resolvedPostSchema.parse({
    provider: "bluesky",
    id,
    canonicalUrl: `https://bsky.app/profile/${handle}/post/${id}`,
    author: {
      handle,
      ...(string(author?.displayName) ? { name: string(author?.displayName) } : {}),
    },
    text: string(record.text) ?? "",
    ...(string(record.createdAt) ?? string(post.indexedAt) ? { postedAt: string(record.createdAt) ?? string(post.indexedAt) } : {}),
    media: mediaFromEmbed(embed),
    ...(withFacets ? { facets: facets as NonNullable<ResolvedPost["facets"]>, atproto: {
      uri, cid: cid!, authorDid: did!, record, ...(record.reply ? { reply: record.reply as NonNullable<ResolvedPost["atproto"]>["reply"] } : {}),
    } } : {}),
    ...(quoteRecord ? { quote: postFromView(quoteRecord, fallback) } : {}),
  });
}

type ThreadNode = { post: Json; parent?: unknown; replies?: unknown[] };

// Use author-feed positions to identify the OP chain when the conversation response is incomplete.
class ThreadNeedsAuthorEvidence extends Error {}

type AuthorThreadEntry = { post: Json; index: number; count: number };
type AuthorThreadCoverage = { scope: "author-chain"; basis: "appview-op-thread"; reportedPosts: number;
  replyGaps: Array<{ uri: string; reported?: number; returned: number; unavailable: number }> };
type ThreadDiscoveryOptions = { retainConversationCoverage?: boolean };

function threadNode(value: unknown): ThreadNode | undefined {
  const node = object(value);
  const post = object(node?.post);
  return post ? { post, parent: node?.parent, replies: Array.isArray(node?.replies) ? node.replies : [] } : undefined;
}

function postUri(node: ThreadNode): string {
  const uri = string(node.post.uri);
  if (!uri) throw new Error("Bluesky thread returned a post without an AT URI; choose posts explicitly");
  return uri;
}

function parentRef(node: ThreadNode): Json | undefined {
  return object(object(object(node.post.record)?.reply)?.parent);
}

function conversationGaps(raw: unknown, selected: Json[]): AuthorThreadCoverage["replyGaps"] {
  const selectedUris = new Set(selected.map(post => string(post.uri)));
  const pending = [object(raw)?.thread];
  const gaps: AuthorThreadCoverage["replyGaps"] = [];
  while (pending.length) {
    const node = threadNode(pending.pop());
    if (!node) continue;
    pending.push(...(node.replies ?? []));
    if (!selectedUris.has(string(node.post.uri))) continue;
    const replies = node.replies ?? [], reported = number(node.post.replyCount);
    const unavailable = replies.filter(reply => !threadNode(reply)).length;
    if (reported === undefined || reported > replies.length || unavailable) {
      gaps.push({ uri: postUri(node), ...(reported === undefined ? {} : { reported }),
        returned: replies.length - unavailable, unavailable });
    }
  }
  return gaps;
}

/** Select only a verified, contiguous, same-DID linear chain. Never choose a fork. */
function oldestAuthorNode(raw: unknown): { seed: ThreadNode; oldest: ThreadNode } {
  const seed = threadNode(object(raw)?.thread);
  if (!seed) throw new Error("Bluesky thread is unavailable; choose posts explicitly or turn thread expansion off");
  const did = string(object(seed.post.author)?.did);
  if (!did) throw new Error("Bluesky thread lacks a stable author ID; choose posts explicitly or turn thread expansion off");
  let cursor = seed;
  let count = 1;
  while (parentRef(cursor)) {
    const parent = threadNode(cursor.parent);
    if (!parent) throw new Error("Bluesky thread has an unavailable parent; choose posts explicitly or turn thread expansion off");
    const declared = parentRef(cursor)!;
    if (!string(declared.cid) || !string(parent.post.cid) || string(declared.uri) !== postUri(parent) || string(declared.cid) !== string(parent.post.cid)) {
      throw new Error("Bluesky thread parent reference changed; choose posts explicitly or turn thread expansion off");
    }
    if (string(object(parent.post.author)?.did) !== did) break;
    cursor = parent;
    if (++count > 20) throw new Error("Bluesky thread exceeds 20 posts; choose posts explicitly");
  }
  return { seed, oldest: cursor };
}

export function linearAuthorThread(raw: unknown, source: Extract<ParsedSource, { provider: "bluesky" }>, selectedUri?: string, options: ThreadDiscoveryOptions = {}): { posts: ResolvedPost[]; seedUri: string; parentUris: Map<string, string> } {
  const { seed, oldest } = oldestAuthorNode(raw);
  const seedUri = selectedUri ?? postUri(seed);
  const did = string(object(seed.post.author)?.did)!;
  const ordered: ThreadNode[] = [oldest];
  const replyGaps: NonNullable<ResolvedPost["threadCoverage"]>["replyGaps"] = [];
  const seen = new Set([postUri(ordered[0]!)]);
  while (true) {
    const current = ordered.at(-1)!;
    const replies = current.replies ?? [];
    const returned = number(current.post.replyCount);
    const unavailable = replies.filter(reply => !threadNode(reply));
    if (options.retainConversationCoverage) {
      if (unavailable.some(reply => string(object(reply)?.uri)?.startsWith(`at://${did}/`))) {
        throw new Error("A connected author post is unavailable. Add the posts you want to include, or turn Import thread off.");
      }
      if (returned === undefined || returned > replies.length || unavailable.length) {
        replyGaps.push({ uri: postUri(current), ...(returned === undefined ? {} : { reported: returned }),
          returned: replies.filter(threadNode).length, unavailable: unavailable.length });
      }
    } else {
      if (returned === undefined || returned > replies.length) {
        throw new ThreadNeedsAuthorEvidence("Bluesky thread replies are incomplete; choose posts explicitly or turn thread expansion off");
      }
      if (unavailable.length) throw new Error("Bluesky thread contains an unavailable reply; choose posts explicitly or turn thread expansion off");
    }
    const sameAuthor = replies.map(threadNode).filter((child): child is ThreadNode =>
      Boolean(child && string(object(child.post.author)?.did) === did));
    if (sameAuthor.length > 1) throw new ThreadNeedsAuthorEvidence("Bluesky thread forks into multiple author replies; choose posts explicitly");
    const child = sameAuthor[0];
    if (!child) break;
    const parent = parentRef(child);
    if (!string(parent?.cid) || !string(current.post.cid) || string(parent?.uri) !== postUri(current) || string(parent?.cid) !== string(current.post.cid)) {
      throw new Error("Bluesky thread reply reference changed; choose posts explicitly or turn thread expansion off");
    }
    if (seen.has(postUri(child))) throw new Error("Bluesky thread contains a reply cycle; choose posts explicitly");
    if (ordered.length >= 20) throw new Error("Bluesky thread exceeds 20 posts; choose posts explicitly");
    ordered.push(child); seen.add(postUri(child));
  }
  if (!seen.has(seedUri)) throw new Error("Bluesky thread did not retain the selected post; choose posts explicitly");
  const parentUris = new Map(ordered.flatMap(node => {
    const parent = string(parentRef(node)?.uri);
    return parent ? [[postUri(node), parent] as const] : [];
  }));
  return { posts: ordered.map((node, index) => ({ ...postFromView(node.post, source),
    ...(options.retainConversationCoverage && index === 0 ? { threadCoverage: { scope: "author-chain" as const, replyGaps } } : {}) })), seedUri, parentUris };
}

export class BlueskyProvider implements SocialProvider {
  private readonly rpc: Client;
  private readonly service: string;
  private readonly fetcher: typeof fetch;

  constructor(service = "https://public.api.bsky.app", fetcher: typeof fetch = fetch, private readonly discovery: ThreadDiscoveryOptions = {}) {
    this.service = service;
    this.fetcher = fetcher;
    this.rpc = new Client({ handler: simpleFetchHandler({ service, fetch: fetcher }) });
  }

  async discoverLinear(source: Extract<ParsedSource, { provider: "bluesky" }>, signal?: AbortSignal) {
    const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000);
    let requests = 0;
    const readJson = async (method: string, params: Record<string, string>) => {
      if (bounded.aborted) throw bounded.reason;
      if (++requests > 20) throw new Error("Bluesky author thread exceeds the bounded read limit; add posts explicitly");
      const endpoint = new URL(`/xrpc/${method}`, this.service);
      for (const [key, value] of Object.entries(params)) endpoint.searchParams.set(key, value);
      const response = await this.fetcher(endpoint, { signal: bounded, redirect: "error", credentials: "omit" });
      if (bounded.aborted) throw bounded.reason;
      if (!response.ok || response.redirected) throw new Error(`Bluesky thread discovery returned ${response.status}; choose posts explicitly or turn thread expansion off`);
      const body = await response.text();
      if (bounded.aborted) throw bounded.reason;
      if (body.length > 2 * 1024 * 1024) throw new Error("Bluesky thread response exceeds 2 MiB; choose posts explicitly");
      return JSON.parse(body);
    };
    const read = (uri: string) => readJson("app.bsky.feed.getPostThread", { uri, depth: "20", parentHeight: "20" });
    const initial = await read(`at://${source.handle}/app.bsky.feed.post/${source.id}`);
    const { seed, oldest } = oldestAuthorNode(initial);
    const seedUri = postUri(seed);
    if (seedUri.split("/").at(-1) !== source.id) throw new Error("Bluesky returned a different selected post; choose posts explicitly");
    const rootUri = postUri(oldest);
    const result = rootUri === seedUri ? initial : await read(rootUri);
    if (postUri(threadNode(object(result)?.thread) ?? { post: {} }) !== rootUri) throw new Error("Bluesky returned a different thread root; choose posts explicitly");
    try {
      return linearAuthorThread(result, source, seedUri, this.discovery);
    } catch (error) {
      if (!(error instanceof ThreadNeedsAuthorEvidence)) throw error;
      // getPostThread is a bounded conversation view, without a cursor. Its
      // replyCount includes other authors and omitted replies. getAuthorFeed
      // identifies the contiguous OP thread explicitly, with a count and each
      // post's 1-based position. Never infer a branch from text, time, or length.
      const did = string(object(seed.post.author)?.did)!;
      const entries = new Map<string, AuthorThreadEntry>();
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = object(await readJson("app.bsky.feed.getAuthorFeed", {
          actor: did, filter: "posts_with_replies", limit: "100", includePins: "false",
          ...(cursor ? { cursor } : {}),
        }));
        if (!page || !Array.isArray(page.feed)) throw new Error("Bluesky returned no author-thread evidence; add posts explicitly");
        for (const value of page.feed) {
          const item = object(value), post = object(item?.post);
          if (!post || string(object(post.author)?.did) !== did) continue;
          const uri = string(post.uri);
          if (!uri?.startsWith(`at://${did}/app.bsky.feed.post/`)) throw new Error("Bluesky author-thread identity changed; add posts explicitly");
          const index = number(item?.opThreadPostIndex), count = number(item?.opThreadPostCount);
          if (index === undefined && count === undefined) continue;
          if (!index || !count || !Number.isInteger(index) || !Number.isInteger(count) || index > count) {
            throw new Error("Bluesky author-thread positions are inconsistent; add posts explicitly");
          }
          const previous = entries.get(uri);
          if (previous && (previous.index !== index || previous.count !== count || string(previous.post.cid) !== string(post.cid))) {
            throw new Error("Bluesky author-thread evidence changed between reads; try again");
          }
          entries.set(uri, { post, index, count });
        }
        const root = entries.get(rootUri);
        if (root) {
          if (root.index !== 1 || !string(root.post.cid) || string(root.post.cid) !== string(oldest.post.cid)) {
            throw new Error("Bluesky author-thread root changed; try again");
          }
          if (root.count > 20) throw new Error("Bluesky thread exceeds 20 posts; choose posts explicitly");
          const ordered = [root.post];
          for (let index = 2; index <= root.count; index++) {
            const parent = ordered.at(-1)!;
            const children = [...entries.values()].filter(entry => entry.index === index
              && string(parentRef({ post: entry.post })?.uri) === string(parent.uri));
            if (children.length > 1) throw new Error("Bluesky author-thread evidence identifies multiple continuations; add posts explicitly");
            const child = children[0];
            if (!child) break; // The next cursor may contain the missing position.
            if (child.count !== root.count) throw new Error("Bluesky author-thread counts are inconsistent; try again");
            const declared = parentRef({ post: child.post });
            if (!string(child.post.cid) || !string(declared?.cid) || string(declared?.cid) !== string(parent.cid)) {
              throw new Error("Bluesky thread reply reference changed; choose posts explicitly or turn thread expansion off");
            }
            const declaredRoot = object(object(object(child.post.record)?.reply)?.root);
            if (string(declaredRoot?.uri) !== rootUri || string(declaredRoot?.cid) !== string(root.post.cid)) {
              throw new Error("Bluesky author-thread root reference changed; add posts explicitly");
            }
            ordered.push(child.post);
          }
          if (ordered.length === root.count) {
            if ([...entries.values()].some(entry => entry.index === root.count + 1
              && string(parentRef({ post: entry.post })?.uri) === string(ordered.at(-1)!.uri))) {
              throw new Error("Bluesky author-thread counts are inconsistent; try again");
            }
            const selected = ordered.find(post => string(post.uri) === seedUri);
            if (!selected || string(selected.cid) !== string(seed.post.cid)) {
              throw new Error("Bluesky author thread did not retain the selected post; add posts explicitly");
            }
            const parentUris = new Map(ordered.flatMap(post => {
              const parent = string(parentRef({ post })?.uri);
              return parent ? [[string(post.uri)!, parent] as const] : [];
            }));
            const coverage: AuthorThreadCoverage = { scope: "author-chain", basis: "appview-op-thread",
              reportedPosts: root.count, replyGaps: conversationGaps(result, ordered) };
            return { posts: ordered.map((post, index) => ({ ...postFromView(post, source),
              ...(this.discovery.retainConversationCoverage && index === 0 ? { threadCoverage: { scope: "author-chain" as const, replyGaps: coverage.replyGaps } } : {}) })),
              seedUri, parentUris, coverage };
          }
        }
        cursor = string(page.cursor);
        if (cursor && cursors.has(cursor)) throw new Error("Bluesky author feed repeated its cursor; add posts explicitly");
        if (cursor) cursors.add(cursor);
      } while (cursor);
      throw new Error("Bluesky could not verify every author-thread post; add posts explicitly or turn thread expansion off");
    }
  }

  async resolve(source: ParsedSource, signal?: AbortSignal): Promise<ResolvedPost> {
    if (source.provider !== "bluesky") throw new Error("BlueskyProvider received a non-Bluesky source");
    const uri = `at://${source.handle}/app.bsky.feed.post/${source.id}` as ResourceUri;
    const response = await ok(this.rpc.get("app.bsky.feed.getPostThread", {
      params: { uri, depth: 0, parentHeight: 0 },
      ...(signal ? { signal } : {}),
    }));
    const thread = object((response as Json).thread);
    const post = object(thread?.post);
    if (!post) throw new Error(`Bluesky returned no post for ${source.canonicalUrl}`);
    return postFromView(post, source);
  }
}
