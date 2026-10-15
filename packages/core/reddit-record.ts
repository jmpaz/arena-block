import { z } from "zod";
import { parseSource } from "./url.ts";

const videoContainer = z.object({ reddit_video: z.object({
  hls_url: z.string().optional(), fallback_url: z.string().optional(), has_audio: z.boolean().optional(), width: z.number(), height: z.number(),
}).optional() }).nullish();
export const redditPostSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+$/), title: z.string().min(1), author: z.string().min(1), permalink: z.string(),
  selftext: z.string(), created_utc: z.number().finite(),
  removed_by_category: z.string().nullish(), subreddit_type: z.string().optional(), quarantined: z.boolean().optional(), quarantine: z.boolean().optional(),
  url: z.string().optional(), is_self: z.boolean().optional(),
  post_hint: z.string().optional(),
  preview: z.object({ images: z.array(z.object({ id: z.string(), source: z.object({ width: z.number(), height: z.number() }) })) }).optional(),
  gallery_data: z.object({ items: z.array(z.object({ media_id: z.string(), caption: z.string().optional(), is_deleted: z.boolean().optional() })).min(1).max(100) }).nullish(),
  media_metadata: z.record(z.string(), z.object({
    status: z.string(), e: z.string().optional(),
    s: z.object({ u: z.string().optional(), gif: z.string().optional(), mp4: z.string().optional(), x: z.number().optional(), y: z.number().optional() }).optional(),
  })).nullish(),
  secure_media: videoContainer,
  media: videoContainer,
  crosspost_parent_list: z.array(z.unknown()).max(1).optional(),
});

export const redditCommentSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+$/), link_id: z.string().regex(/^t3_[a-z0-9]+$/),
  author: z.string().min(1), body: z.string().min(1), permalink: z.string(), created_utc: z.number().finite(),
  removed: z.boolean().optional(), removed_by_category: z.string().nullish(),
  media_metadata: redditPostSchema.shape.media_metadata,
  media: z.unknown().nullish(),
});

export const REDDIT_CAPTURE_MAX_BYTES = 2 * 1024 * 1024;

function bounded(value: unknown): void {
  let nodes = 0;
  const walk = (item: unknown, depth: number) => {
    if (++nodes > 20_000 || depth > 32) throw new Error("Reddit capture exceeds its record bounds");
    if (item && typeof item === "object") for (const child of Object.values(item)) walk(child, depth + 1);
  };
  walk(value, 0);
  const json = JSON.stringify(value);
  if (typeof json !== "string") throw new Error("Expected a Reddit capture object");
  let bytes = 0;
  for (const character of json) {
    const point = character.codePointAt(0)!;
    bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
    if (bytes > REDDIT_CAPTURE_MAX_BYTES) throw new Error("Reddit capture exceeds 2 MiB");
  }
}
function publicPost(value: unknown, depth = 0): z.infer<typeof redditPostSchema> {
  if (depth > 4) throw new Error("Reddit cross-post nesting is too deep");
  const post = redditPostSchema.parse(value);
  if (!["public", "restricted"].includes(post.subreddit_type ?? "") || post.quarantined || post.quarantine) {
    throw new Error("A Reddit browser capture must identify a public, non-quarantined community");
  }
  if (Object.keys(post.media_metadata ?? {}).length > 100) throw new Error("Too many Reddit media records");
  if (post.crosspost_parent_list) post.crosspost_parent_list = post.crosspost_parent_list.map(parent => publicPost(parent, depth + 1));
  return post;
}
export function redditSourceKey(value: string): string {
  const source = parseSource(value);
  if (source.provider !== "reddit" || source.short) throw new Error("Open the Reddit post or selected comment before capturing it");
  return `${source.id}:${source.commentId ?? ""}`;
}
function browserPostSchema(depth: number): z.ZodType<z.infer<typeof redditPostSchema>> {
  return redditPostSchema.extend({ crosspost_parent_list: depth === 4
    ? z.tuple([]).optional() : z.array(browserPostSchema(depth + 1)).max(1).optional() });
}
const envelope = z.object({
  schema: z.literal("arena-block/reddit-browser-capture"), version: z.literal(1),
  sourceUrl: z.url(), observedAt: z.iso.datetime(),
  post: browserPostSchema(0), comment: redditCommentSchema.optional(),
}).strict();
export type RedditBrowserCapture = z.infer<typeof envelope>;
function validateCapture(input: RedditBrowserCapture) {
  bounded(input);
  const post = publicPost(input.post);
  const comment = input.comment;
  if (comment?.media != null) throw new Error("Reddit comment media container is unsupported");
  const key = redditSourceKey(input.sourceUrl);
  if (redditSourceKey(new URL(post.permalink, "https://www.reddit.com").href) !== `${post.id}:` ||
      key !== `${post.id}:${comment?.id ?? ""}` ||
      (comment && (comment.link_id !== `t3_${post.id}` ||
        redditSourceKey(new URL(comment.permalink, "https://www.reddit.com").href) !== key))) {
    throw new Error("Reddit browser capture contains mismatched post or comment identities");
  }
  if (Date.parse(input.observedAt) > Date.now() + 5 * 60_000) throw new Error("Reddit observation time is in the future");
}
export const redditBrowserCaptureSchema = envelope.superRefine((input, context) => {
  try { validateCapture(input); }
  catch (error) { context.addIssue({ code: "custom", message: error instanceof Error ? error.message : String(error) }); }
});
export function normalizeRedditCapture(value: unknown): RedditBrowserCapture {
  bounded(value);
  const input = redditBrowserCaptureSchema.parse(value);
  return { ...input, sourceUrl: parseSource(input.sourceUrl).canonicalUrl };
}
export const redditCapturesSchema = redditBrowserCaptureSchema.array().max(20).default([]).superRefine((captures, context) => {
  const keys = captures.map(capture => redditSourceKey(capture.sourceUrl));
  if (new Set(keys).size !== keys.length) context.addIssue({ code: "custom", message: "Duplicate Reddit browser captures" });
  try { bounded(captures); } catch (error) { context.addIssue({ code: "custom", message: String(error) }); }
});
export function bindRedditCaptures(refs: string[], captures: RedditBrowserCapture[]) {
  const normalized = redditCapturesSchema.parse(captures);
  const keys = new Set(refs.flatMap(ref => { try { return [redditSourceKey(ref)]; } catch { return []; } }));
  if (normalized.some(capture => !keys.has(redditSourceKey(capture.sourceUrl)))) throw new Error("A Reddit browser capture does not match a selected source");
  return normalized;
}

export function redditReadNeedsBrowser(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /^Reddit's live (?:post|metadata) read returned HTTP \d+/.test(message);
}
export function requireRetainedRedditCaptures(plan: { sources: { redditCapture?: RedditBrowserCapture }[] }, captures: RedditBrowserCapture[]) {
  for (const capture of captures) {
    const expected = redditBrowserCaptureSchema.parse(capture);
    const retained = plan.sources.find(source => source.redditCapture && redditSourceKey(source.redditCapture.sourceUrl) === redditSourceKey(expected.sourceUrl))?.redditCapture;
    if (!retained || JSON.stringify(retained) !== JSON.stringify(expected)) throw new Error("The local helper did not retain the Reddit browser record. Install matching helper and receiver versions before continuing.");
  }
}
