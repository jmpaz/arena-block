import { z } from "zod";
import TurndownService from "turndown";
import { parseSource } from "./url.ts";
import type { MediaAsset, ResolvedPost } from "./types.ts";

const id = z.string().regex(/^[a-z0-9]+$/);
const source = z.object({ id, author: z.string().min(1).max(100), permalink: z.string().max(2048), postedAt: z.iso.datetime() }).strict();
const asset = z.object({ id, kind: z.literal("image"), url: z.url(), alt: z.string().max(2000),
  sourceRole: z.enum(["original", "preview"]), sourcePlacement: z.literal("body").optional() }).strict();
const body = z.object({ status: z.enum(["complete", "context-only"]), html: z.string().max(500_000) }).strict();
export const redditPublicPageCaptureSchema = z.object({
  schema: z.literal("arena-block/reddit-public-page-capture"), version: z.literal(1), sourceUrl: z.url(), observedAt: z.iso.datetime(),
  transport: z.literal("ephemeral-public-webview"),
  post: source.extend({ title: z.string().min(1).max(10000), postType: z.string().min(1).max(60),
    body, media: z.array(asset).max(100), externalUrl: z.url().optional(),
    evidence: z.object({ root: z.literal("shreddit-post"), fullContent: z.boolean() }).strict() }).strict(),
  comment: source.extend({ postId: id, body, media: z.array(asset).max(100),
    evidence: z.object({ root: z.literal("shreddit-comment"), bodyId: z.string().regex(/^t1_[a-z0-9]+-post-rtjson-content$/) }).strict() }).strict().optional(),
}).strict().superRefine((capture, context) => {
  try {
    const parsed = parseSource(capture.sourceUrl), post = parseSource(new URL(capture.post.permalink, "https://www.reddit.com").href);
    if (parsed.provider !== "reddit" || parsed.short || post.provider !== "reddit" || post.short || post.commentId ||
        parsed.id !== capture.post.id || post.id !== capture.post.id || parsed.commentId !== capture.comment?.id) throw new Error("Mismatched Reddit public page source");
    if (capture.comment) {
      if (capture.post.body.status !== "context-only" || capture.post.body.html || capture.post.media.length || capture.post.evidence.fullContent || capture.comment.body.status !== "complete") throw new Error("Reddit comment parent must retain metadata only");
      const comment = parseSource(new URL(capture.comment.permalink, "https://www.reddit.com").href);
      if (comment.provider !== "reddit" || comment.short || comment.id !== capture.post.id || comment.commentId !== capture.comment.id ||
          capture.comment.postId !== capture.post.id || capture.comment.evidence.bodyId !== `t1_${capture.comment.id}-post-rtjson-content`) throw new Error("Mismatched selected Reddit public comment");
    }
    if (!capture.comment && (capture.post.body.status !== "complete" || !capture.post.evidence.fullContent)) throw new Error("Reddit post does not retain its complete public body");
    if (!capture.comment && !["text", "self", "image", "multi_media", "link"].includes(capture.post.postType)) throw new Error("Unsupported Reddit public post type");
    if (Date.parse(capture.observedAt) > Date.now() + 300_000) throw new Error("Reddit observation is in the future");
    for (const entry of [capture.post, ...(capture.comment ? [capture.comment] : [])]) {
      if (["[deleted]", "[removed]"].includes(entry.author)) throw new Error("Reddit author is unavailable");
      if (/<\s*(?:script|style|iframe|object|embed|video|audio|picture|math|svg|canvas)\b/i.test(entry.body.html)) throw new Error("Unsupported Reddit public body media or executable HTML");
      const seen = new Set<string>();
      for (const media of entry.media) {
        const image = publicRedditImage(media.url);
        if (image?.id !== media.id || image.role !== media.sourceRole || seen.has(media.id)) throw new Error("Mismatched or duplicate Reddit public image identity/role");
        seen.add(media.id);
      }
    }
    if (capture.post.externalUrl) {
      const url = new URL(capture.post.externalUrl);
      if (url.protocol !== "https:" || url.username || url.password || url.port) throw new Error("Unsafe Reddit external link");
    }
  } catch (error) { context.addIssue({ code: "custom", message: error instanceof Error ? error.message : String(error) }); }
});
export type RedditPublicPageCapture = z.infer<typeof redditPublicPageCaptureSchema>;

/** Preserve the exact observed image URL; never manufacture an original from a preview. */
export function publicRedditImage(value: string): { id: string; role: "original" | "preview" } | undefined {
  try {
    const url = new URL(value.replaceAll("&amp;", "&"));
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash || !["i.redd.it", "preview.redd.it", "cf.preview.redd.it"].includes(url.hostname)) return;
    const match = /^\/([a-z0-9]+)\.(?:png|jpe?g|webp)$/i.exec(url.pathname)
      ?? /-v0-([a-z0-9]+)\.(?:png|jpe?g|webp)$/i.exec(url.pathname);
    if (!match) return;
    return { id: match[1]!, role: url.hostname === "i.redd.it" ? "original" : "preview" };
  } catch { return; }
}
export function redditPublicPagePost(value: RedditPublicPageCapture): ResolvedPost {
  const capture = redditPublicPageCaptureSchema.parse(value), selected = capture.comment ?? capture.post;
  const canonicalUrl = new URL(selected.permalink, "https://www.reddit.com").href;
  const converter = new TurndownService({ headingStyle: "atx", bulletListMarker: "-", codeBlockStyle: "fenced" });
  const urls = new Set(selected.media.map(item => item.url));
  converter.addRule("reddit-public-image", { filter: "img", replacement(_content, node) {
    const url = node.getAttribute("src")?.replaceAll("&amp;", "&");
    if (!url || !urls.has(url)) throw new Error("Reddit public body image has no retained media record");
    return `\n\n${url}\n\n`;
  } });
  converter.addRule("reddit-public-link", { filter: "a", replacement(content, node) {
    const raw = node.getAttribute("href");
    if (node.querySelector("img")) return content;
    if (!raw) return content;
    const url = new URL(raw, canonicalUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return content;
    return `[${content || converter.escape(url.href)}](<${url.href}>)`;
  } });
  const text = [converter.turndown(selected.body.html).trim(), !capture.comment && capture.post.externalUrl ? capture.post.externalUrl : ""].filter(Boolean).join("\n\n");
  if (!text && !selected.media.length) throw new Error("Reddit public source has no complete writing or media");
  return { provider: "reddit", id: selected.id, canonicalUrl, author: { handle: `${capture.comment ? "/" : ""}u/${selected.author}` },
    text, postedAt: selected.postedAt, ...(capture.comment ? { storyTitle: capture.post.title } : { postTitle: capture.post.title }),
    media: selected.media.map(item => ({ ...item, ref: "0.0" } as MediaAsset)), redditCapture: capture };
}
