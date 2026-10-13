import { z } from "zod";
import type { ResolvedPost } from "../types.ts";
import type { ParsedSource } from "../url.ts";
import { fetchJson, type Fetcher } from "./comments.ts";
import type { SocialProvider } from "./provider.ts";

const commentSchema = z.object({
  short_id: z.string(),
  created_at: z.iso.datetime({ offset: true }),
  is_deleted: z.boolean(),
  is_moderated: z.boolean(),
  comment_plain: z.string().min(1),
  commenting_user: z.string().min(1),
  url: z.url(),
});
const storySchema = z.object({ short_id: z.string(), title: z.string().min(1) });

export class LobstersProvider implements SocialProvider {
  constructor(private readonly fetcher: Fetcher = fetch) {}

  async resolve(source: ParsedSource, signal?: AbortSignal): Promise<ResolvedPost> {
    if (source.provider !== "lobsters") throw new Error("LobstersProvider received a non-Lobsters source");
    const comment = commentSchema.parse(await fetchJson(`https://lobste.rs/c/${source.id}.json`, this.fetcher, signal));
    if (comment.short_id !== source.id) throw new Error("Lobsters returned the wrong comment");
    if (comment.is_deleted || comment.is_moderated) throw new Error("Lobsters comment is deleted or moderated");
    const url = new URL(comment.url);
    const storyId = /^\/s\/([a-z0-9]+)(?:\/|$)/.exec(url.pathname)?.[1];
    if (url.hostname !== "lobste.rs" || !storyId) throw new Error("Lobsters comment has no valid story URL");
    const story = storySchema.parse(await fetchJson(`https://lobste.rs/s/${storyId}.json`, this.fetcher, signal));
    if (story.short_id !== storyId) throw new Error("Lobsters returned the wrong story");
    return {
      provider: "lobsters",
      id: source.id,
      canonicalUrl: source.canonicalUrl,
      author: { handle: comment.commenting_user },
      text: comment.comment_plain,
      postedAt: new Date(comment.created_at).toISOString(),
      storyTitle: story.title,
      media: [],
    };
  }
}
