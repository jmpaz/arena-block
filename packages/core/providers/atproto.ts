import type { ResolvedPost } from "../types.ts";
import type { ParsedSource } from "../url.ts";
import type { SocialProvider } from "./provider.ts";
import { BLUESKY, atprotoPostFromView, utf8Length, type AtprotoApp } from "./atproto-post.ts";

type AtprotoSource = Extract<ParsedSource, { provider: "bluesky" | "delve" }>;

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

function postFromView(post: Json, _source: AtprotoSource, app: AtprotoApp = BLUESKY): ResolvedPost {
  return atprotoPostFromView(post, app);
}

type ThreadNode = { post: Json; parent?: unknown; replies?: unknown[] };

// A conversation count or a sibling author reply cannot identify the OP chain.
// Keep the strict tree checks, but allow stronger provider evidence to resolve it.
class ThreadNeedsAuthorEvidence extends Error {}

type AuthorThreadEntry = { post: Json; index: number; count: number };
type AuthorThreadCoverage = { scope: "author-chain"; basis: "appview-op-thread"; reportedPosts: number;
  replyGaps: Array<{ uri: string; reported?: number; returned: number; unavailable: number }> };

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

export function linearAuthorThread(raw: unknown, source: AtprotoSource, selectedUri?: string, app: AtprotoApp = BLUESKY): { posts: ResolvedPost[]; seedUri: string; parentUris: Map<string, string> } {
  const { seed, oldest } = oldestAuthorNode(raw);
  const seedUri = selectedUri ?? postUri(seed);
  const did = string(object(seed.post.author)?.did)!;
  const ordered: ThreadNode[] = [oldest];
  const seen = new Set([postUri(ordered[0]!)]);
  while (true) {
    const current = ordered.at(-1)!;
    const replies = current.replies ?? [];
    const returned = number(current.post.replyCount);
    if (returned === undefined || returned > replies.length) {
      throw new ThreadNeedsAuthorEvidence("Bluesky thread replies are incomplete; choose posts explicitly or turn thread expansion off");
    }
    if (replies.some(reply => !threadNode(reply))) {
      throw new Error("Bluesky thread contains an unavailable reply; choose posts explicitly or turn thread expansion off");
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
    const expected = object(object(object(current.post.record)?.reply)?.root) ?? { uri: current.post.uri, cid: current.post.cid };
    const root = object(object(object(child.post.record)?.reply)?.root);
    if (root?.uri !== expected.uri || root?.cid !== expected.cid) throw new Error(`${app.label} thread root reference changed; choose posts explicitly or turn thread expansion off`);
    if (seen.has(postUri(child))) throw new Error("Bluesky thread contains a reply cycle; choose posts explicitly");
    if (ordered.length >= 20) throw new Error("Bluesky thread exceeds 20 posts; choose posts explicitly");
    ordered.push(child); seen.add(postUri(child));
  }
  if (!seen.has(seedUri)) throw new Error("Bluesky thread did not retain the selected post; choose posts explicitly");
  const parentUris = new Map(ordered.flatMap(node => {
    const parent = string(parentRef(node)?.uri);
    return parent ? [[postUri(node), parent] as const] : [];
  }));
  return { posts: ordered.map(node => postFromView(node.post, source, app)), seedUri, parentUris };
}

export class AtprotoProvider implements SocialProvider {
  private readonly service: string;
  private readonly fetcher: typeof fetch;

  constructor(service = BLUESKY.service, fetcher: typeof fetch = fetch, private readonly app: AtprotoApp = BLUESKY) {
    this.service = service;
    this.fetcher = fetcher;
  }

  async discoverLinear(source: AtprotoSource, signal?: AbortSignal) {
    if (source.provider !== this.app.provider) throw new Error(`Expected a ${this.app.label} source`);
    if (this.app.provider === "delve") {
      try { return await this.discover(source, signal); }
      catch (error) {
        if (error instanceof Error) throw new Error(error.message.replaceAll("Bluesky", this.app.label), { cause: error });
        throw error;
      }
    }
    return this.discover(source, signal);
  }

  private async discover(source: AtprotoSource, signal?: AbortSignal) {
    const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000);
    let requests = 0;
    const readJson = async (method: string, params: Record<string, string>) => {
      if (bounded.aborted) throw bounded.reason ?? new Error("The operation was aborted");
      if (++requests > 20) throw new Error("Bluesky author thread exceeds the bounded read limit; add posts explicitly");
      const endpoint = new URL(`/xrpc/${method}`, this.service);
      for (const [key, value] of Object.entries(params)) endpoint.searchParams.set(key, value);
      const response = await this.fetcher(endpoint, { signal: bounded, redirect: "error", credentials: "omit" });
      if (bounded.aborted) throw bounded.reason ?? new Error("The operation was aborted");
      if (!response.ok || response.redirected) throw new Error(`${this.app.label} thread discovery returned ${response.status}; choose posts explicitly or turn thread expansion off`);
      const body = await response.text();
      if (bounded.aborted) throw bounded.reason ?? new Error("The operation was aborted");
      if (utf8Length(body) > 2 * 1024 * 1024) throw new Error(`${this.app.label} thread response exceeds 2 MiB; choose posts explicitly`);
      return JSON.parse(body);
    };
    const read = (uri: string) => readJson(`${this.app.namespace}.feed.getPostThread`, { uri, depth: "20", parentHeight: "20" });
    const actor = await this.actor(source.handle, bounded);
    const initial = await read(`at://${actor}/${this.app.namespace}.feed.post/${source.id}`);
    const { seed, oldest } = oldestAuthorNode(initial);
    const seedUri = postUri(seed);
    if (!this.matchesSource(seed.post, source, actor)) throw new Error("Bluesky returned a different selected post; choose posts explicitly");
    const rootUri = postUri(oldest);
    const result = rootUri === seedUri ? initial : await read(rootUri);
    if (postUri(threadNode(object(result)?.thread) ?? { post: {} }) !== rootUri) throw new Error("Bluesky returned a different thread root; choose posts explicitly");
    try {
      const linear = linearAuthorThread(result, source, seedUri, this.app);
      const selected = linear.posts.find(post => post.atproto?.uri === seedUri);
      if (selected?.atproto?.cid !== seed.post.cid) throw new Error(`${this.app.label} selected post changed between thread reads; try again`);
      return linear;
    } catch (error) {
      if (!(error instanceof ThreadNeedsAuthorEvidence) || this.app.provider !== "bluesky") throw error;
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
            // Diagnostics are separate from ResolvedPost/BlockPlan: an older
            // daemon must retain the exact established plan schema and hash.
            const coverage: AuthorThreadCoverage = { scope: "author-chain", basis: "appview-op-thread",
              reportedPosts: root.count, replyGaps: conversationGaps(result, ordered) };
            return { posts: ordered.map(post => postFromView(post, source)), seedUri, parentUris, coverage };
          }
        }
        cursor = string(page.cursor);
        if (cursor && cursors.has(cursor)) throw new Error("Bluesky author feed repeated its cursor; add posts explicitly");
        if (cursor) cursors.add(cursor);
      } while (cursor);
      throw new Error("Bluesky could not verify every author-thread post; add posts explicitly or turn thread expansion off");
    }
  }

  private matchesSource(post: Json, source: AtprotoSource, actor: string): boolean {
    if (actor.startsWith("did:")) return post.uri === `at://${actor}/${this.app.namespace}.feed.post/${source.id}`;
    return string(post.uri)?.split("/").at(-1) === source.id
      && string(object(post.author)?.handle)?.toLowerCase() === actor.toLowerCase();
  }

  private async actor(identifier: string, signal?: AbortSignal): Promise<string> {
    if (this.app.provider === "bluesky" || identifier.startsWith("did:")) return identifier;
    const endpoint = new URL("/xrpc/com.atproto.identity.resolveHandle", this.service);
    endpoint.searchParams.set("handle", identifier);
    const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
    if (bounded.aborted) throw bounded.reason ?? new Error("The operation was aborted");
    const response = await this.fetcher(endpoint, { signal: bounded, redirect: "error", credentials: "omit" });
    if (bounded.aborted) throw bounded.reason ?? new Error("The operation was aborted");
    if (!response.ok || response.redirected) throw new Error(`${this.app.label} could not resolve the source handle`);
    const body = await response.text();
    if (bounded.aborted) throw bounded.reason ?? new Error("The operation was aborted");
    if (utf8Length(body) > 8192) throw new Error("AT Protocol identity response exceeds 8 KiB");
    const did = string(object(JSON.parse(body))?.did);
    if (!did || !/^did:(?:plc:[a-z2-7]{24}|web:[^/\s]+)$/.test(did)) throw new Error("AT Protocol handle resolution returned an invalid DID");
    return did;
  }

  async resolve(source: ParsedSource, signal?: AbortSignal): Promise<ResolvedPost> {
    if (source.provider !== this.app.provider || !(source.provider === "bluesky" || source.provider === "delve")) throw new Error(`Expected a ${this.app.label} source`);
    const actor = await this.actor(source.handle, signal);
    const uri = `at://${actor}/${this.app.namespace}.feed.post/${source.id}`;
    const endpoint = new URL(`/xrpc/${this.app.namespace}.feed.getPostThread`, this.service);
    for (const [key, value] of Object.entries({ uri, depth: "0", parentHeight: "0" })) endpoint.searchParams.set(key, value);
    const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
    if (bounded.aborted) throw bounded.reason ?? new Error("The operation was aborted");
    const response = await this.fetcher(endpoint, { signal: bounded, redirect: "error", credentials: "omit" });
    if (bounded.aborted) throw bounded.reason ?? new Error("The operation was aborted");
    if (!response.ok || response.redirected) throw new Error(`${this.app.label} returned ${response.status} for ${source.canonicalUrl}`);
    const body = await response.text();
    if (bounded.aborted) throw bounded.reason ?? new Error("The operation was aborted");
    if (utf8Length(body) > 2 * 1024 * 1024) throw new Error(`${this.app.label} post response exceeds 2 MiB`);
    const post = object(object(object(JSON.parse(body))?.thread)?.post);
    if (!post || !this.matchesSource(post, source, actor)) throw new Error(`${this.app.label} returned an unavailable or different post`);
    return atprotoPostFromView(post, this.app);
  }
}
