import { z } from "zod";
import { MAX_QUOTE_DEPTH, type ResolvedPost } from "../types.ts";
import type { ParentContext, ParentEntry } from "../parent-context.ts";
import type { ParsedSource } from "../url.ts";
import { commentMarkdown, commentTitle, fetchJson, type Fetcher } from "./comments.ts";
import type { SocialProvider } from "./provider.ts";

const itemSchema = z.object({
  id: z.number().int().positive(), type: z.string().optional(),
  deleted: z.boolean().optional(), dead: z.boolean().optional(), by: z.string().min(1).optional(),
  time: z.number().int().nonnegative().max(8_640_000_000_000).optional(), text: z.string().optional(),
  parent: z.number().int().positive().optional(), title: z.string().min(1).optional(),
});
const permalink = (id: string) => `https://news.ycombinator.com/item?id=${id}`;

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
    const parents: ParentEntry[] = [];
    const context: ParentContext = { parents, stopped: "invalid_reference" };
    let item = comment, storyTitle: string | undefined;
    const visited = new Set([source.id]);
    // Keep the existing bounded story-title walk, retaining only eight comments.
    // A missing ancestor never erases an otherwise complete selected comment.
    for (let depth = 0; depth < 100; depth++) {
      if (!item.parent) break;
      const id = String(item.parent), boundary = { id, canonicalUrl: permalink(id) };
      if (visited.has(id)) { context.stopped = "cycle"; context.boundary = boundary; break; }
      visited.add(id);
      try { item = await load(id); }
      catch (error) {
        signal?.throwIfAborted();
        if (context.stopped !== "depth_limit") {
          context.stopped = error instanceof Error && error.message.includes("wrong item") ? "invalid_reference" : "unavailable";
          context.boundary = boundary;
        }
        break;
      }
      if (item.type === "story" || item.type === "poll") {
        if (item.title && !item.deleted && !item.dead) {
          storyTitle = commentTitle(item.title);
          context.submission = { ...boundary, title: storyTitle };
        }
        if (context.stopped !== "depth_limit") {
          context.stopped = "submission"; context.boundary = boundary;
        }
        break;
      }
      if (item.type !== "comment" && !(item.type === undefined && item.parent)) {
        if (context.stopped !== "depth_limit") { context.stopped = "invalid_reference"; context.boundary = boundary; }
        break;
      }
      if (parents.length === MAX_QUOTE_DEPTH) {
        if (context.stopped !== "depth_limit") { context.stopped = "depth_limit"; context.boundary = boundary; }
        continue;
      }
      const available = !item.deleted && !item.dead && item.by && item.text?.trim() && item.time !== undefined;
      parents.push({ ...boundary, status: item.deleted ? "deleted" : available ? "available" : "unavailable",
        ...(available ? { author: { handle: item.by! }, text: commentMarkdown(item.text!), postedAt: new Date(item.time! * 1000).toISOString() } : {}) });
    }
    return {
      provider: "hackernews", id: source.id, canonicalUrl: source.canonicalUrl,
      author: { handle: comment.by }, text: commentMarkdown(comment.text),
      postedAt: new Date(comment.time * 1000).toISOString(), ...(storyTitle ? { storyTitle } : {}),
      parentContext: context, media: [],
    };
  }
}
