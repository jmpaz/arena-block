/// <reference path="../polyfills.d.ts" />
import { createDocument } from "@mixmark-io/domino";
import TurndownService from "turndown";
import { z } from "zod";
import { substackPublicJSON } from "../substack-public.ts";
import { substackArticleRecordSchema } from "../substack-article-record.ts";
import type { ParsedSource } from "../url.ts";
import type { MediaAsset, ResolvedPost } from "../types.ts";

const postSchema = z.object({ id: z.number().int().positive(), publication_id: z.number().int().positive(), slug: z.string(),
  canonical_url: z.url(), title: z.string().min(1), subtitle: z.string().nullable().optional(), body_html: z.string().nullable(),
  audience: z.string(), is_published: z.boolean(), post_date: z.iso.datetime({ offset: true }),
  is_geoblocked: z.boolean().optional(), is_editor_preview: z.boolean().optional(), free_unlock_required: z.boolean().optional(),
  publishedBylines: z.array(z.object({ id: z.number().int().positive(), name: z.string().min(1), handle: z.string().regex(/^[a-zA-Z0-9_]+$/).nullable().optional() })).min(1),
  video_upload_id: z.string().nullable().optional(), podcast_url: z.string().nullable().optional(),
});
const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
export function substackOriginalImage(value: string, base: string): string {
  let url = new URL(value, base);
  // The original is literally present in Substack's fetch URL, not guessed by resizing a preview.
  if ((url.hostname === "substackcdn.com" || url.hostname.endsWith(".substackcdn.com")) && url.pathname.startsWith("/image/fetch/")) {
    const original = url.pathname.match(/\/(https?(?::|%3A)(?:\/\/|%2F%2F).*)$/i)?.[1];
    if (!original) throw new Error("Substack resized image did not expose its original source");
    url = new URL(decodeURIComponent(original));
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port
    || !(url.hostname === "substack-post-media.s3.amazonaws.com" || url.hostname === "substackcdn.com" || url.hostname.endsWith(".substackcdn.com"))) throw new Error("Substack article image has no supported observed original URL");
  return url.href;
}
export function substackArticleBody(html: string, base: string): { markdown: string; media: MediaAsset[] } {
  const doc = createDocument(html), media: MediaAsset[] = [];
  for (const mention of Array.from(doc.querySelectorAll('[data-component-name="MentionToDOM"]'))) {
    if (mention.textContent?.trim()) continue;
    const attrs = z.object({ name: z.string().min(1), url: z.string().nullable().optional() }).parse(JSON.parse(mention.getAttribute("data-attrs") ?? "{}"));
    const label = doc.createTextNode(attrs.name);
    if (attrs.url) {
      const address = new URL(attrs.url, base);
      if (address.protocol !== "https:" || address.username || address.password) throw new Error("Substack article mention has an unsafe source link");
      const link = doc.createElement("a"); link.setAttribute("href", address.href); link.appendChild(label); mention.appendChild(link);
    } else mention.appendChild(label);
  }
  for (const element of Array.from(doc.querySelectorAll("script,style,button"))) element.remove();
  if (Array.from(doc.querySelectorAll("svg")).some(svg => svg.getAttribute("aria-hidden") !== "true")) throw new Error("Substack article has an unsupported inline visual; it cannot be silently omitted");
  for (const svg of Array.from(doc.querySelectorAll("svg"))) svg.remove();
  if (doc.querySelector("video,audio,iframe,object,embed,[data-component-name='Video'],[data-component-name='Audio'],[data-component-name='VideoPlaceholder'],[data-component-name='AudioPlaceholder']")) throw new Error("Substack article contains an unsupported player; its media must be acquired explicitly before capture");
  for (const element of Array.from(doc.querySelectorAll("[data-component-name]"))) {
    const name = element.getAttribute("data-component-name")!;
    if (!element.textContent?.trim() && !element.querySelector("img") && name !== "MentionToDOM") throw new Error(`Substack article component ${name} has no supported complete projection`);
  }
  for (const image of Array.from(doc.querySelectorAll("img"))) {
    let attrs: Record<string, unknown> = {};
    try { attrs = JSON.parse(image.getAttribute("data-attrs") ?? "{}"); } catch { /* The observed src/href remains available. */ }
    const candidates = [typeof attrs.src === "string" ? attrs.src : undefined, image.getAttribute("src"), image.closest("a")?.getAttribute("href")].filter((value): value is string => !!value);
    let url: string | undefined;
    for (const candidate of candidates) { try { url = substackOriginalImage(candidate, base); break; } catch { /* Try the observed original hyperlink, never guess a resource. */ } }
    if (!url) throw new Error("Substack article image has no supported observed original source");
    const alt = image.getAttribute("alt") ?? "";
    const dimension = (name: string) => { const v = Number(image.getAttribute(name) ?? attrs[name]); return Number.isSafeInteger(v) && v > 0 ? v : undefined; };
    media.push({ kind: "image", ref: "0.0", url, alt, sourceRole: "original", sourcePlacement: "body", ...(dimension("width") ? { width: dimension("width") } : {}), ...(dimension("height") ? { height: dimension("height") } : {}) });
    image.setAttribute("src", url); image.removeAttribute("srcset");
  }
  const markdown = new TurndownService({ headingStyle: "atx", bulletListMarker: "-", codeBlockStyle: "fenced" });
  markdown.addRule("link", { filter: "a", replacement(content, node) {
    if (!content.trim()) return "";
    try { const url = new URL((node as HTMLElement).getAttribute("href") ?? "", base);
      return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? `[${content}](<${url.href}>)` : content;
    } catch { return content; }
  } });
  markdown.addRule("strike", { filter: ["s", "del"], replacement: content => `~~${content}~~` });
  return { markdown: markdown.turndown(doc.body.innerHTML), media };
}
export async function resolveSubstackArticle(source: Extract<ParsedSource, { kind: "article" }>, fetcher: typeof fetch, signal?: AbortSignal): Promise<ResolvedPost> {
  const generic = (): ResolvedPost => ({ provider: "web", id: source.canonicalUrl, canonicalUrl: source.canonicalUrl,
    author: { handle: new URL(source.canonicalUrl).hostname }, text: "", postTitle: new URL(source.canonicalUrl).hostname, media: [] });
  let value: unknown;
  try { value = await substackPublicJSON(`${new URL(source.canonicalUrl).origin}/api/v1/posts/${source.slug}`, fetcher, signal); }
  catch (error) {
    if (signal?.aborted) throw error;
    if (!source.publicationHost) return generic();
    throw error;
  }
  const parsed = postSchema.safeParse(value);
  if (!parsed.success) {
    const object = value && typeof value === "object" ? value as Record<string, unknown> : {};
    if (!source.publicationHost && !("publication_id" in object && "canonical_url" in object && "publishedBylines" in object)) return generic();
    throw new Error("Substack article endpoint did not establish a complete public article contract");
  }
  const post = parsed.data, canonical = new URL(post.canonical_url), expected = new URL(source.canonicalUrl);
  if (canonical.protocol !== "https:" || canonical.username || canonical.password || canonical.port || post.slug !== source.slug || canonical.origin !== expected.origin || canonical.pathname !== expected.pathname.replace(/\/$/, "") || canonical.search || canonical.hash) throw new Error("Substack article identity or publication domain disagrees with the requested source");
  if (post.audience !== "everyone" || !post.is_published || post.is_geoblocked || post.is_editor_preview || post.free_unlock_required || !post.body_html?.trim()) throw new Error("Substack article is not a complete freely public body; no paywall or access bypass is attempted");
  if (post.video_upload_id || post.podcast_url) throw new Error("Substack article has native video/audio awaiting explicit acquisition");
  const authors = post.publishedBylines.map(byline => ({ id: byline.id, name: byline.name, handle: byline.handle ?? `user-${byline.id}`,
    profileUrl: byline.handle ? `https://substack.com/@${byline.handle}` : `https://substack.com/profile/${byline.id}` }));
  const record = substackArticleRecordSchema.parse({ version: 1, id: post.id, publicationId: post.publication_id, url: canonical.href,
    slug: post.slug, title: post.title, subtitle: post.subtitle ?? "", authors, observedAt: new Date().toISOString(), method: "public-api", audience: "everyone", bodyHtml: post.body_html });
  const body = substackArticleBody(record.bodyHtml, record.url);
  const byline = authors.map(author => `<a href="${escape(author.profileUrl)}">${escape(author.name)}</a>`).join(", ");
  const header = substackArticleBody(`<h1>${escape(record.title)}</h1>${record.subtitle ? `<p><em>${escape(record.subtitle)}</em></p>` : ""}<p>By ${byline}</p>`, record.url).markdown;
  return { provider: "substack", id: `article:${post.id}`, canonicalUrl: record.url, author: { handle: authors[0]!.handle, name: authors.map(author => author.name).join(", ") },
    text: "", article: `${header}\n\n${body.markdown}\n\n*[Substack article source](<${record.url}>)*`, substackArticle: record,
    postTitle: record.title, postedAt: post.post_date, media: body.media };
}
