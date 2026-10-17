import { z } from "zod";
import { MAX_EXPANDED_SOURCE_POSTS, type ResolvedPost } from "../types.ts";
import { substackPublicJSON } from "../substack-public.ts";

const identity = z.object({ id: z.number().int().positive(), user_id: z.number().int().positive(), handle: z.string().nullable().optional(),
  ancestor_path: z.string(), children_count: z.number().int().nonnegative().optional(), post_id: z.number().nullable().optional(), type: z.string().optional() });
type Comment = z.infer<typeof identity>;
const noteURL = (id: string | number) => `https://substack.com/note/c-${id}`;
function ancestors(comment: Comment): string[] {
  if (!/^(?:[1-9]\d*(?:\.[1-9]\d*)*)?$/.test(comment.ancestor_path)) throw new Error("Substack reply ancestor path is malformed");
  const ids = comment.ancestor_path ? comment.ancestor_path.split(".") : [];
  if (ids.length >= MAX_EXPANDED_SOURCE_POSTS || new Set(ids).size !== ids.length || ids.includes(String(comment.id))) throw new Error("Substack reply ancestry is cyclic or exceeds the source limit");
  return ids;
}
function parent(comment: Comment) { return ancestors(comment).at(-1); }
export async function discoverSubstackThread(seedId: string, resolve: (url: string, signal: AbortSignal) => Promise<ResolvedPost>, fetcher: typeof fetch, signal?: AbortSignal): Promise<{ posts: ResolvedPost[]; seedId: string }> {
  const bounded = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(60_000)]);
  const evidenceUrls: string[] = [], budget = { bytes: 0, maximum: 8 * 1024 * 1024 };
  const read = async (url: string) => {
    if (evidenceUrls.length >= 64) throw new Error("Substack thread exceeds 64 bounded discovery pages; add exact Note permalinks");
    evidenceUrls.push(url); return substackPublicJSON(url, fetcher, bounded, budget);
  };
  const endpoint = `https://substack.com/api/v1/reader/comment/${seedId}`;
  const root = z.object({ item: z.object({ comment: identity, parentComments: z.array(identity).max(32) }) }).parse(await read(endpoint)).item;
  if (String(root.comment.id) !== seedId || root.comment.post_id != null || root.comment.type !== "feed") throw new Error("Substack discovery did not return the requested Note identity");
  const known = new Map<string, Comment>(), evidence = new Map<string, string>();
  const add = (comment: Comment, url: string) => {
    ancestors(comment);
    if (comment.post_id != null || comment.type && comment.type !== "feed") throw new Error("Substack discovery returned an article comment rather than a Note");
    const key = String(comment.id), previous = known.get(key);
    if (previous && (previous.user_id !== comment.user_id || previous.ancestor_path !== comment.ancestor_path)) throw new Error("Substack discovery returned conflicting reply identities");
    if (previous?.handle && comment.handle && previous.handle !== comment.handle
      || previous?.children_count !== undefined && comment.children_count !== undefined && previous.children_count !== comment.children_count) throw new Error("Substack reply author or count changed during discovery");
    const observed = Object.fromEntries(Object.entries(comment).filter(([, value]) => value !== undefined)) as Partial<Comment>;
    known.set(key, { ...previous, ...observed, id: comment.id, user_id: comment.user_id, ancestor_path: comment.ancestor_path,
      ...(previous?.handle && !comment.handle ? { handle: previous.handle } : {}),
      ...(previous?.children_count !== undefined && comment.children_count === undefined ? { children_count: previous.children_count } : {}),
    }); evidence.set(key, url);
    if (known.size > 2000) throw new Error("Substack conversation exceeds 2000 bounded reply identities");
    for (const entry of known.values()) {
      const path = ancestors(entry);
      for (const [index, id] of path.entries()) {
        const ancestor = known.get(id);
        if (ancestor && ancestors(ancestor).join(".") !== path.slice(0, index).join(".")) throw new Error("Substack reply ancestor prefixes disagree");
      }
    }
  };
  for (const comment of [...root.parentComments, root.comment]) add(comment, endpoint);
  const chain: Comment[] = [root.comment];
  for (const id of ancestors(root.comment).reverse()) {
    const ancestor = known.get(id);
    if (!ancestor) throw new Error("Substack reply ancestor is unavailable; no complete author chain was inferred");
    if (ancestor.user_id !== root.comment.user_id) break;
    if (parent(chain[0]!) !== id) throw new Error("Substack reply parent ordering disagrees with its ancestor path");
    chain.unshift(ancestor);
  }
  const visited = new Set<string>();
  let index = 0, current = chain[0]!;
  while (true) {
    if (bounded.aborted) throw new Error("Substack thread discovery cancelled");
    const id = String(current.id);
    if (visited.has(id)) throw new Error("Substack reply discovery cycled");
    visited.add(id);
    let cursor: string | undefined; const cursors = new Set<string>(), children = new Map<string, Comment>(), returned = new Set<string>();
    do {
      const url = new URL(`https://substack.com/api/v1/reader/comment/${id}/replies`);
      if (cursor) url.searchParams.set("cursor", cursor);
      const page = z.object({ rootComment: identity, commentBranches: z.array(z.object({ comment: identity,
        descendantComments: z.array(z.object({ type: z.string(), comment: identity.nullable().optional() })).max(2000),
      })).max(2000), nextCursor: z.string().max(2048).nullable(), moreBranches: z.union([z.boolean(), z.number().int().nonnegative()]) }).parse(await read(url.href));
      if (String(page.rootComment.id) !== id || page.rootComment.user_id !== current.user_id || page.rootComment.ancestor_path !== current.ancestor_path) throw new Error("Substack reply page root disagrees with its requested Note");
      add(page.rootComment, url.href); current = known.get(id)!;
      for (const branch of page.commentBranches) {
        const values = [branch.comment, ...branch.descendantComments.map(entry => {
          if (entry.type !== "comment" || !entry.comment) throw new Error("Substack reply page contains unavailable descendants; no complete author chain was inferred");
          return entry.comment;
        })];
        for (const child of values) {
          if (!ancestors(child).includes(id)) throw new Error("Substack discovery returned an unrelated conversation");
          add(child, url.href);
          returned.add(String(child.id));
          if (parent(child) === id) children.set(String(child.id), child);
        }
      }
      cursor = page.nextCursor ?? undefined;
      if (page.moreBranches && !cursor) throw new Error("Substack reply pagination is incomplete");
      if (cursor && cursors.has(cursor)) throw new Error("Substack reply cursor repeated");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    if (current.children_count !== undefined && returned.size < current.children_count) throw new Error("Substack reply pages do not cover the reported replies; no complete author chain was inferred");
    const owned = [...children.values()].filter(child => child.user_id === root.comment.user_id);
    if (owned.length > 1) throw new Error("Substack author replies branch; choose exact Note permalinks in the intended order");
    if (!owned.length) {
      if (chain[index + 1] || current.children_count && !children.size) throw new Error("Substack reply page omitted an expected continuation; no complete author chain was inferred");
      break;
    }
    if (chain[index + 1]) {
      if (chain[index + 1]!.id !== owned[0]!.id) throw new Error("Substack seed ancestry disagrees with the discovered author continuation");
    } else {
      if (chain.length >= MAX_EXPANDED_SOURCE_POSTS) throw new Error("Substack author chain exceeds 32 sources; choose a smaller exact source set");
      chain.push(owned[0]!);
    }
    index++; current = owned[0]!;
  }
  const observedAt = new Date().toISOString(), posts: ResolvedPost[] = [];
  let observedHandle: string | undefined, observedProfile: string | undefined;
  for (const chainComment of chain) {
    const comment = known.get(String(chainComment.id))!;
    if (bounded.aborted) throw new Error("Substack thread discovery cancelled");
    const id = String(comment.id), post = await resolve(noteURL(id), bounded);
    if (post.provider !== "substack" || post.id !== id || comment.handle && post.author.handle !== comment.handle) throw new Error("Substack thread body and reply identity disagree");
    const profile = post.substackCapture?.note.author.profileUrl;
    if (observedHandle && observedHandle !== post.author.handle || observedProfile && profile && observedProfile !== profile) throw new Error("Substack author-chain body snapshots disagree on their author");
    observedHandle = post.author.handle; observedProfile ??= profile;
    const parentId = parent(comment);
    posts.push({ ...post, ...(parentId ? { replyTo: { id: parentId, ...(known.get(parentId)?.handle ? { authorHandle: known.get(parentId)!.handle! } : {}) } } : {}),
      substackRelation: { version: 1, userId: comment.user_id, ancestorIds: ancestors(comment), reportedReplies: comment.children_count ?? 0, observedAt, evidenceUrl: evidence.get(id)! } });
  }
  posts[0] = { ...posts[0]!, substackThread: { version: 1, scope: "same-author-linear", seedId, rootId: String(chain[0]!.id), pagesRead: evidenceUrls.length, complete: true, observedAt, evidenceUrls } };
  return { posts, seedId };
}
