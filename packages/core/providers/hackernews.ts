import { z } from "zod";
import type { ResolvedPost } from "../types.ts";
import type { ParsedSource } from "../url.ts";
import { commentMarkdown, commentTitle, fetchJson, type Fetcher } from "./comments.ts";
import type { SocialProvider } from "./provider.ts";

const itemSchema = z.object({
  id: z.number().int().positive(),
  type: z.string().optional(),
  deleted: z.boolean().optional(),
  dead: z.boolean().optional(),
  by: z.string().min(1).optional(),
  time: z.number().int().nonnegative().max(8_640_000_000_000).optional(),
  text: z.string().optional(),
  parent: z.number().int().positive().optional(),
  title: z.string().min(1).optional(),
});

export class HackerNewsProvider implements SocialProvider {
  constructor(private readonly fetcher: Fetcher = fetch) {}

  async resolve(source: ParsedSource, signal?: AbortSignal): Promise<ResolvedPost> {
    if (source.provider !== "hackernews") throw new Error("HackerNewsProvider received a non-Hacker News source");
    const load = async (id: string) => {
      const item = itemSchema.parse(await fetchJson(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, this.fetcher, signal));
      if (String(item.id) !== id) throw new Error(`Hacker News returned the wrong item for ${id}`);
      return item;
    };
    const comment = await load(source.id);
    if (comment.deleted || comment.dead) throw new Error("Hacker News comment is deleted or dead");
    if (comment.type !== "comment") throw new Error("Expected a Hacker News comment, not a story or other item");
    if (!comment.by || !comment.text?.trim() || comment.time === undefined) throw new Error("Hacker News comment is missing author, text, or timestamp");
    let item = comment;
    const visited = new Set([source.id]);
    for (let depth = 0; depth < 100; depth++) {
      if (!item.parent) throw new Error("Hacker News comment has no reachable story");
      const id = String(item.parent);
      if (visited.has(id)) throw new Error("Hacker News comment ancestry contains a cycle");
      visited.add(id);
      item = await load(id);
      if (item.type === "comment" || (!item.type && item.parent)) continue;
      if (!item.title || item.deleted || item.dead) throw new Error("Hacker News story title is unavailable");
      return {
        provider: "hackernews",
        id: source.id,
        canonicalUrl: source.canonicalUrl,
        author: { handle: comment.by },
        text: commentMarkdown(comment.text),
        postedAt: new Date(comment.time * 1000).toISOString(),
        storyTitle: commentTitle(item.title),
        media: [],
      };
    }
    throw new Error("Hacker News comment ancestry exceeds 100 parents");
  }
}
