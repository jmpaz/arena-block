import { z } from "zod";
import { redditPostSchema, redditCommentSchema, redditSourceKey, redditCapturesSchema, validateRedditCapture, redditReadNeedsBrowser, type RedditBrowserCapture } from "../reddit-record.ts";
import { redditPublicPagePost } from "../reddit-public-page.ts";
import type { MediaAsset, ResolvedPost } from "../types.ts";
import { parseSource, type ParsedSource } from "../url.ts";
import type { Fetcher } from "./comments.ts";
import type { SocialProvider } from "./provider.ts";

function parsePostData(value: unknown): z.infer<typeof redditPostSchema> {
  if (value && typeof value === "object" && !Array.isArray(value) &&
      typeof (value as { selftext?: unknown }).selftext !== "string") {
    throw new Error("Reddit post response omitted a usable selftext field; full content cannot be verified");
  }
  return redditPostSchema.parse(value);
}
function webUrl(value: string): string {
  const url = new URL(value.replaceAll("&amp;", "&"));
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Invalid Reddit media URL");
  return url.href;
}
// Body references are assets, not pages to crawl. Keep the exact observed/source
// URL and accept only Reddit's image hosts with a matching image identity.
function redditImage(value: string): { id: string; url: string } | undefined {
  try {
    const url = new URL(value.replaceAll("&amp;", "&"));
    const match = /^\/([a-z0-9]+)\.(?:png|jpe?g|webp|gif)$/i.exec(url.pathname);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash ||
        !["i.redd.it", "preview.redd.it"].includes(url.hostname) || !match) return;
    return { id: match[1]!, url: url.href };
  } catch { return; }
}
function dimensions(source?: { x?: number; y?: number }) {
  return { ...(source?.x && Number.isInteger(source.x) && source.x > 0 ? { width: source.x } : {}),
    ...(source?.y && Number.isInteger(source.y) && source.y > 0 ? { height: source.y } : {}) };
}
function bodyImages(post: { selftext: string; media_metadata?: z.infer<typeof redditPostSchema>["media_metadata"] }, attachments: MediaAsset[]) {
  const media: MediaAsset[] = [], issues: NonNullable<ResolvedPost["mediaIssues"]> = [];
  const seen = new Set(attachments.flatMap(item => item.id ? [item.id] : redditImage(item.url)?.id ? [redditImage(item.url)!.id] : []));
  const references = /!\[([^\]]*)\]\(([^\s)]+)(?:\s+"[^"]*")?\)|https?:\/\/[^\s<>()]+/g;
  for (const match of post.selftext.matchAll(references)) {
    const explicit = match[2] !== undefined;
    const value = explicit ? match[2]! : match[0].replace(/[.,;]+$/, "");
    let id: string | undefined, observed: ReturnType<typeof redditImage>;
    if (explicit && /^[a-z0-9]+$/.test(value)) id = value;
    else {
      let url: URL;
      try { url = new URL(value.replaceAll("&amp;", "&")); } catch {
        if (explicit) issues.push({ sourcePlacement: "body", status: "unsupported", url: value });
        continue;
      }
      if (!["i.redd.it", "preview.redd.it"].includes(url.hostname)) {
        if (explicit) issues.push({ sourcePlacement: "body", status: "unsupported", url: value });
        continue;
      }
      observed = redditImage(value);
      if (!observed) { issues.push({ sourcePlacement: "body", status: "unsafe_url", url: value }); continue; }
      id = observed.id;
    }
    if (seen.has(id!)) continue;
    seen.add(id!);
    const entry = post.media_metadata?.[id!];
    if (entry && (entry.status !== "valid" || !entry.s || (entry.e === "Image" && !entry.s.u))) {
      issues.push({ sourcePlacement: "body", status: "unavailable", id }); continue;
    }
    if (entry && entry.e !== "Image") {
      issues.push({ sourcePlacement: "body", status: "unsupported", id }); continue;
    }
    if (!entry && !observed) {
      issues.push({ sourcePlacement: "body", status: "missing_metadata", id }); continue;
    }
    const image = entry ? entry.s?.u && redditImage(entry.s.u) : observed;
    if (!image || image.id !== id) {
      issues.push({ sourcePlacement: "body", status: "unsafe_url", id, ...(entry?.s?.u ? { url: entry.s.u } : {}) }); continue;
    }
    media.push({ ref: "0.0", id, kind: "image", url: image.url, sourcePlacement: "body", ...dimensions(entry?.s), alt: explicit && match[1] !== "img" ? match[1]! : "" });
  }
  return { media, issues };
}
function postFromData(value: unknown, depth = 0, archivedAfterStatus?: number): ResolvedPost {
  if (depth > 4) throw new Error("Reddit cross-post nesting is too deep");
  const post = parsePostData(value);
  if (post.removed_by_category || ["[removed]", "[deleted]"].includes(post.selftext)) {
    const marker = post.removed_by_category ?? post.selftext;
    throw new Error(archivedAfterStatus === undefined
      ? `Reddit's live response marks this post ${marker}; no block was created`
      : `Reddit's live read returned HTTP ${archivedAfterStatus}; its archived snapshot marks this post ${marker}. Current content cannot be verified; no block was created`);
  }
  const canonicalUrl = new URL(post.permalink, "https://www.reddit.com").href;
  const source = parseSource(canonicalUrl);
  if (source.provider !== "reddit" || source.id !== post.id) throw new Error("Reddit returned a mismatched permalink");
  const quote = post.crosspost_parent_list?.[0] ? postFromData(post.crosspost_parent_list[0], depth + 1, archivedAfterStatus) : undefined;
  const nativeVideo = post.secure_media?.reddit_video ?? post.media?.reddit_video;
  let media: MediaAsset[] = [];
  if (post.gallery_data) {
    media = post.gallery_data.items.map(item => {
      const entry = post.media_metadata?.[item.media_id];
      if (item.is_deleted || entry?.status !== "valid" || !entry.s) throw new Error(`Reddit gallery item ${item.media_id} is unavailable`);
      const video = entry.e === "AnimatedImage" && !!entry.s.mp4;
      const href = video ? entry.s.mp4 : entry.e === "AnimatedImage" ? entry.s.gif : entry.e === "Image" ? entry.s.u : undefined;
      if (!href) throw new Error(`Unsupported Reddit gallery item ${item.media_id}`);
      return { ref: "0.0", id: item.media_id, kind: video ? "video" : "image", url: webUrl(href), ...(entry.s.x ? { width: entry.s.x } : {}), ...(entry.s.y ? { height: entry.s.y } : {}), alt: item.caption ?? "" };
    });
  } else if (nativeVideo) {
    const video = nativeVideo;
    const href = video.hls_url || (!video.has_audio ? video.fallback_url : undefined);
    if (!href) throw new Error("Reddit video has no stream preserving its audio");
    media = [{ ref: "0.0", kind: "video", url: webUrl(href), width: video.width, height: video.height, alt: "" }];
  } else if (post.url && (post.post_hint === "image" || /^https:\/\/i\.redd\.it\//.test(post.url))) {
    const image = redditImage(post.url);
    const preview = image && post.preview?.images.find(item => item.id === image.id)?.source;
    media = [{ ref: "0.0", ...(image ? { id: image.id } : {}), kind: "image", url: webUrl(post.url),
      ...dimensions(preview ? { x: preview.width, y: preview.height } : undefined), alt: "" }];
  } else if (quote) media = quote.media.map(item => ({ ...item }));
  const body = bodyImages(post, media);
  media.push(...body.media);
  const captions = post.gallery_data?.items.flatMap((item, index) => item.caption ? [`${index + 1}. ${item.caption}`] : []) ?? [];
  const external = !post.is_self && !media.length && !quote && post.url && !/https:\/\/(?:www\.)?reddit\.com\//.test(post.url) ? post.url : "";
  return {
    provider: "reddit", id: post.id, canonicalUrl, postTitle: post.title,
    author: { handle: `u/${post.author}` },
    text: [post.selftext, ...captions, external].filter(Boolean).join("\n\n"),
    postedAt: new Date(post.created_utc * 1000).toISOString(), media,
    ...(body.issues.length ? { mediaIssues: body.issues } : {}),
    ...(quote ? { quote } : {}),
  };
}
function commentFromData(value: unknown, parent: { id: string; title: string }, source: Extract<ParsedSource, { provider: "reddit" }>): ResolvedPost {
  const comment = redditCommentSchema.parse(value);
  if (comment.id !== source.commentId || comment.link_id !== `t3_${source.id}`) throw new Error("Reddit returned a different comment or parent post");
  if (comment.removed || comment.removed_by_category || ["[deleted]", "[removed]"].includes(comment.body.trim()) || comment.author === "[deleted]") throw new Error("Reddit comment is deleted or removed");
  const canonicalUrl = new URL(comment.permalink, "https://www.reddit.com").href;
  const canonical = parseSource(canonicalUrl);
  if (canonical.provider !== "reddit" || canonical.id !== source.id || canonical.commentId !== comment.id) throw new Error("Reddit returned a mismatched comment permalink");
  if (parent.id !== source.id) throw new Error("Reddit returned a different parent post");
  if (comment.media != null) throw new Error("Reddit comment media is unsupported; full capture was not created");
  if (/https:\/\/(?:external-preview|v)\.redd\.it\//i.test(comment.body)) throw new Error("Reddit comment media is unsupported; full capture was not created");
  const assets = Object.values(comment.media_metadata ?? {});
  if (assets.some(asset => asset.status !== "valid")) throw new Error("Reddit comment media is unavailable; full capture was not created");
  const body = bodyImages({ selftext: comment.body, media_metadata: comment.media_metadata }, []);
  if (body.issues.length) throw new Error("Reddit comment media is unsupported; full capture was not created");
  const referenced = new Set(body.media.flatMap(asset => asset.id ? [asset.id] : []));
  if (Object.keys(comment.media_metadata ?? {}).some(id => !referenced.has(id))) throw new Error("Reddit comment media is unsupported; full capture was not created");
  return { provider: "reddit", id: comment.id, canonicalUrl, author: { handle: `/u/${comment.author}` },
    text: comment.body, postedAt: new Date(comment.created_utc * 1000).toISOString(), storyTitle: parent.title,
    media: body.media, ...(body.issues.length ? { mediaIssues: body.issues } : {}) };
}

export class RedditProvider implements SocialProvider {
  private readonly captures: RedditBrowserCapture[];
  constructor(private readonly fetcher: Fetcher = fetch, captures: RedditBrowserCapture[] = [],
    private readonly acquirePublicPage?: (source: Extract<ParsedSource, { provider: "reddit" }>, signal: AbortSignal) => Promise<unknown>) {
    this.captures = redditCapturesSchema.parse(captures);
  }
  private captured(value: unknown, source: Extract<ParsedSource, { provider: "reddit" }>): ResolvedPost {
    const capture = validateRedditCapture(value);
    if (redditSourceKey(capture.sourceUrl) !== redditSourceKey(source.canonicalUrl)) throw new Error("Reddit public acquisition returned another source");
    if (capture.schema === "arena-block/reddit-public-page-capture") return redditPublicPagePost(capture);
    const post = capture.comment ? commentFromData(capture.comment, capture.post, source) : postFromData(capture.post);
    return { ...post, redditCapture: capture };
  }
  private async completeGallery(value: unknown, options: { signal: AbortSignal }, depth = 0): Promise<unknown> {
    if (depth > 4) throw new Error("Reddit cross-post nesting is too deep");
    const post = parsePostData(value);
    const missing = post.gallery_data?.items.filter(item => !item.is_deleted && post.media_metadata?.[item.media_id]?.status === "unprocessed") ?? [];
    if (missing.length) {
      const response = await this.fetcher(`https://vxreddit.com/comments/${post.id}`, {
        ...options, redirect: "error", headers: { "user-agent": "arena-block/0.1 (Discordbot compatible preview)", accept: "text/html" },
      });
      if (!response.ok) throw new Error(`Reddit gallery preview returned ${response.status}`);
      const images: string[] = [];
      let canonical = "";
      await new HTMLRewriter().on("meta", { element(element) {
        if (element.getAttribute("property") === "og:image") images.push(element.getAttribute("content") ?? "");
        if (element.getAttribute("property") === "og:url") canonical = element.getAttribute("content") ?? "";
      } }).transform(response).text();
      const source = parseSource(canonical);
      if (source.provider !== "reddit" || source.id !== post.id) throw new Error("Reddit gallery preview returned a different post");
      for (const item of missing) {
        const image = images.find(href => {
          const parsed = new URL(href);
          return parsed.hostname === "i.redd.it" && parsed.pathname.split("/").at(-1)?.split(".")[0] === item.media_id;
        });
        if (!image) throw new Error(`Reddit gallery item ${item.media_id} is unavailable`);
        post.media_metadata![item.media_id] = { status: "valid", e: "Image", s: { u: webUrl(image) } };
      }
    }
    if (post.crosspost_parent_list) post.crosspost_parent_list = await Promise.all(post.crosspost_parent_list.map(parent => this.completeGallery(parent, options, depth + 1)));
    return post;
  }
  private async lookup(fullname: string, signal: AbortSignal): Promise<unknown> {
    const options = { headers: { accept: "application/json", "user-agent": "arena-block/0.1" }, signal, redirect: "error" as const };
    const direct = await this.fetcher(`https://www.reddit.com/api/info.json?id=${fullname}&raw_json=1`, options);
    if (direct.ok && direct.headers.get("content-type")?.includes("application/json")) {
      return z.object({ data: z.object({ children: z.array(z.object({ data: z.unknown() })) }) }).parse(await direct.json()).data.children[0]?.data;
    }
    if ([403, 429].includes(direct.status)) {
      throw new Error(`Reddit's live metadata read returned HTTP ${direct.status}; current content cannot be verified. No archive or block creation was attempted. Open the post or comment in your browser and use Read Reddit tab or share from Safari to Capture.`);
    }
    if (direct.status !== 503) throw new Error(`Reddit's live metadata read returned HTTP ${direct.status} without usable content; current content cannot be verified`);
    const kind = fullname.startsWith("t1_") ? "comments" : "posts";
    const response = await this.fetcher(`https://arctic-shift.photon-reddit.com/api/${kind}/ids?ids=${fullname.slice(3)}`, options);
    if (!response.ok) throw new Error(`Reddit archive returned ${response.status}`);
    const value = z.object({ data: z.array(z.unknown()) }).parse(await response.json()).data[0];
    if (!value) throw new Error(`Reddit ${kind} entry is not available in the archive yet`);
    return value;
  }
  private async resolveComment(source: Extract<ParsedSource, { provider: "reddit" }>, signal: AbortSignal): Promise<ResolvedPost> {
    const comment = redditCommentSchema.parse(await this.lookup(`t1_${source.commentId}`, signal));
    const parent = z.object({ id: z.string(), title: z.string().min(1) }).parse(await this.lookup(comment.link_id, signal));
    return commentFromData(comment, parent, source);
  }
  async resolve(input: ParsedSource, signal?: AbortSignal): Promise<ResolvedPost> {
    if (input.provider !== "reddit") throw new Error("Expected a Reddit source");
    const capture = this.captures.find(item => !input.short && redditSourceKey(item.sourceUrl) === redditSourceKey(input.canonicalUrl));
    if (capture) {
      return this.captured(capture, input);
    }
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000);
    const options = { headers: { accept: "application/json", "user-agent": "arena-block/0.1" }, signal: requestSignal, redirect: "manual" as const };
    let source = input;
    for (let redirects = 0; source.short; redirects++) {
      if (redirects >= 5) throw new Error("Too many Reddit share-link redirects");
      const response = await this.fetcher(source.canonicalUrl, { ...options, method: "HEAD" });
      const location = response.headers.get("location");
      if (response.status < 300 || response.status >= 400 || !location) throw new Error("Reddit did not expand the share link");
      const next = parseSource(new URL(location, source.canonicalUrl).href);
      if (next.provider !== "reddit") throw new Error("Reddit share link redirected outside Reddit");
      source = next;
    }
    if (source.commentId) {
      try { return await this.resolveComment(source, requestSignal); }
      catch (error) {
        if (!this.acquirePublicPage || !redditReadNeedsBrowser(error) || !String(error).includes("HTTP 403")) throw error;
        return this.captured(await this.acquirePublicPage(source, requestSignal), source);
      }
    }
    const direct = await this.fetcher(`https://www.reddit.com/comments/${source.id}.json?raw_json=1`, options);
    let value: unknown;
    let archivedAfterStatus: number | undefined;
    if (direct.ok && direct.headers.get("content-type")?.includes("application/json")) {
      const listing = z.array(z.object({ data: z.object({ children: z.array(z.object({ data: z.unknown() })) }) })).parse(await direct.json());
      value = listing[0]?.data.children[0]?.data;
    } else {
      if ([403, 429].includes(direct.status)) {
        if (direct.status === 403 && this.acquirePublicPage) return this.captured(await this.acquirePublicPage(source, requestSignal), source);
        throw new Error(`Reddit's live post read returned HTTP ${direct.status}; current content cannot be verified. No archive or block creation was attempted. Open the post or comment in your browser and use Read Reddit tab or share from Safari to Capture.`);
      }
      if (direct.status !== 503) throw new Error(`Reddit's live post read returned HTTP ${direct.status} without a usable post; current content cannot be verified`);
      const archived = await this.fetcher(`https://arctic-shift.photon-reddit.com/api/posts/ids?ids=${source.id}`, options);
      if (!archived.ok) throw new Error(`Reddit archive returned ${archived.status}`);
      value = z.object({ data: z.array(z.unknown()) }).parse(await archived.json()).data[0];
      archivedAfterStatus = direct.status;
      if (!value) throw new Error("Reddit post is not available in the archive yet");
    }
    const post = postFromData(await this.completeGallery(value, options), 0, archivedAfterStatus);
    if (post.id !== source.id) throw new Error("Reddit returned a different post");
    return post;
  }
}
