import { z } from "zod";
import { MAX_QUOTE_DEPTH, type ResolvedPost } from "../types.ts";
import type { ParentContext } from "../parent-context.ts";
import type { ParsedSource } from "../url.ts";
import { parseSource } from "../url.ts";
import { fetchJson, storyBody, type Fetcher } from "./comments.ts";
import type { SocialProvider } from "./provider.ts";

const commentSchema = z.object({
  short_id: z.string().regex(/^[a-z0-9]+$/), created_at: z.iso.datetime({ offset: true }).optional(),
  is_deleted: z.boolean(), is_moderated: z.boolean(), comment_plain: z.string().optional(),
  commenting_user: z.string().optional(), url: z.url(), parent_comment: z.string().regex(/^[a-z0-9]+$/).nullable().optional(),
});
const storySchema = z.object({ short_id: z.string(), title: z.string().min(1), comments: z.array(z.unknown()).max(20_000).optional() });
const submissionSchema = storySchema.extend({
  created_at: z.iso.datetime({ offset: true }), submitter_user: z.string().min(1),
  description_plain: z.string(), url: z.string(), short_id_url: z.url(), comments_url: z.url(),
});
const permalink = (id: string) => `https://lobste.rs/c/${id}`;
function storyIdentity(address: string): string {
  const url = new URL(address), id = /^\/s\/([a-z0-9]+)(?:\/|$)/.exec(url.pathname)?.[1];
  if (url.protocol !== "https:" || url.hostname !== "lobste.rs" || url.username || url.password || url.port || !id) throw new Error("Lobsters comment has no valid story URL");
  return id;
}

export class LobstersProvider implements SocialProvider {
  constructor(private readonly fetcher: Fetcher = fetch) {}

  async resolve(source: ParsedSource, signal?: AbortSignal): Promise<ResolvedPost> {
    if (source.provider !== "lobsters") throw new Error("LobstersProvider received a non-Lobsters source");
    if (source.kind === "story") {
      const story = submissionSchema.parse(await fetchJson(`https://lobste.rs/s/${source.id}.json`, this.fetcher, signal));
      if (story.short_id !== source.id || [story.short_id_url, story.comments_url].some(url => {
        const returned = parseSource(url);
        return returned.provider !== "lobsters" || returned.kind !== "story" || returned.id !== source.id;
      })) throw new Error("Lobsters returned the wrong story");
      return { provider: "lobsters", id: source.id, canonicalUrl: source.canonicalUrl,
        author: { handle: story.submitter_user }, postTitle: story.title,
        text: storyBody(story.description_plain, story.url || undefined, story.submitter_user, `https://lobste.rs/u/${encodeURIComponent(story.submitter_user)}`),
        postedAt: new Date(story.created_at).toISOString(), media: [] };
    }
    const comment = commentSchema.parse(await fetchJson(`${permalink(source.id)}.json`, this.fetcher, signal));
    if (comment.short_id !== source.id) throw new Error("Lobsters returned the wrong comment");
    if (comment.is_deleted || comment.is_moderated) throw new Error("Lobsters comment is deleted or moderated");
    if (!comment.commenting_user || !comment.comment_plain?.trim() || !comment.created_at) throw new Error("Lobsters comment is missing author, text, or timestamp");
    const returned = parseSource(comment.url);
    if (returned.provider !== "lobsters" || returned.kind === "story" || returned.id !== source.id) throw new Error("Lobsters comment has no valid story URL");
    const storyId = storyIdentity(comment.url);
    const context: ParentContext = { parents: [], stopped: "unavailable" };
    let story: z.infer<typeof storySchema> | undefined;
    try {
      story = storySchema.parse(await fetchJson(`https://lobste.rs/s/${storyId}.json`, this.fetcher, signal));
      if (story.short_id !== storyId) throw new Error("Lobsters returned the wrong story");
    } catch (error) { signal?.throwIfAborted(); story = undefined; }
    if (story) context.submission = { id: storyId, canonicalUrl: `https://lobste.rs/s/${storyId}`, title: story.title };
    let item = comment;
    const visited = new Set([source.id]);
    for (let depth = 0; depth <= MAX_QUOTE_DEPTH; depth++) {
      const id = item.parent_comment;
      if (id === null) { context.stopped = "submission"; break; }
      if (!id) break; // Missing pointer is incomplete evidence, not a root.
      const boundary = { id, canonicalUrl: permalink(id) };
      context.boundary = boundary;
      if (visited.has(id)) { context.stopped = "cycle"; break; }
      if (depth === MAX_QUOTE_DEPTH) { context.stopped = "depth_limit"; break; }
      visited.add(id);
      try {
        const retained = story?.comments?.filter(value => value && typeof value === "object" && (value as { short_id?: string }).short_id === id);
        if (retained && retained.length > 1) throw new Error("Repeated Lobsters parent identity");
        item = commentSchema.parse(retained?.[0] ?? await fetchJson(`${permalink(id)}.json`, this.fetcher, signal));
        if (item.short_id !== id || storyIdentity(item.url) !== storyId) { context.stopped = "invalid_reference"; break; }
      } catch (error) { signal?.throwIfAborted(); context.stopped = "unavailable"; break; }
      const available = !item.is_deleted && !item.is_moderated && item.commenting_user && item.comment_plain?.trim() && item.created_at;
      context.parents.push({ ...boundary, status: item.is_deleted ? "deleted" : available ? "available" : "unavailable",
        ...(available ? { author: { handle: item.commenting_user! }, text: item.comment_plain!, postedAt: new Date(item.created_at!).toISOString() } : {}) });
      delete context.boundary;
    }
    return {
      provider: "lobsters", id: source.id, canonicalUrl: source.canonicalUrl,
      author: { handle: comment.commenting_user }, text: comment.comment_plain,
      postedAt: new Date(comment.created_at).toISOString(), ...(story ? { storyTitle: story.title } : {}),
      parentContext: context, media: [],
    };
  }
}
