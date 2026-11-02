import TurndownService from "turndown";
import { z } from "zod";
import { MAX_EXPANDED_SOURCE_POSTS, type MediaAsset, type ResolvedPost } from "../types.ts";
import { parseSource, type ParsedSource } from "../url.ts";
import type { Fetcher } from "./comments.ts";
import type { SocialProvider } from "./provider.ts";

type ForumSource = Extract<ParsedSource, { provider: "forum_magnum" }>;
const siteNames = { lesswrong: "LessWrong", alignment_forum: "Alignment Forum", ea_forum: "EA Forum" } as const;
function siteName(source: ForumSource): string { return siteNames[source.site]; }
const origins = {
  lesswrong: "https://www.lesswrong.com",
  alignment_forum: "https://www.alignmentforum.org",
  ea_forum: "https://forum.effectivealtruism.org",
} as const;
const id = z.string().regex(/^[A-Za-z0-9]+$/);
const user = z.object({ _id: id.optional(), username: z.string().min(1), displayName: z.string().nullish() }).nullish();
const postSchema = z.object({
  _id: id, title: z.string().min(1), pageUrl: z.string().url(), postedAt: z.string(),
  status: z.number(), draft: z.boolean().nullish(), isFuture: z.boolean().nullish(),
  shortform: z.boolean().nullish(), contents: z.object({ html: z.string().nullish() }).nullish(), user,
});
const commentSchema = z.object({
  _id: id, postId: id, parentCommentId: id.nullish(), pageUrl: z.string().url(),
  postedAt: z.string(), deleted: z.boolean(), deletedPublic: z.boolean(),
  directChildrenCount: z.number().int().nonnegative().nullish(),
  draft: z.boolean().nullish(), rejected: z.boolean().nullish(),
  contents: z.object({ html: z.string().nullish() }).nullish(), user,
});
type ForumPost = z.infer<typeof postSchema>;
type ForumComment = z.infer<typeof commentSchema>;
function commentAuthorId(comment: ForumComment): string {
  if (!comment.user?._id) throw new Error("The comment author identity is incomplete. Choose exact comment permalinks or turn thread expansion off.");
  return comment.user._id;
}

const postQuery = `query ForumPost($id: String!) {
  post(input: {selector: {_id: $id}}) { result {
    _id title pageUrl postedAt status draft isFuture shortform contents { html }
    user { _id username displayName }
  } }
}`;
const commentQuery = `query ForumComment($id: String!) {
  comment(input: {selector: {_id: $id}}) { result {
    _id postId parentCommentId pageUrl postedAt deleted deletedPublic draft rejected directChildrenCount
    contents { html } user { _id username displayName }
  } }
}`;
const repliesQuery = `query ForumReplies($terms: JSON) {
  comments(input: {terms: $terms}) { results {
    _id postId parentCommentId pageUrl postedAt deleted deletedPublic draft rejected directChildrenCount
    contents { html } user { _id username displayName }
  } }
}`;

function sourceLink(raw: string, base: string): string | undefined {
  try {
    const url = new URL(raw.replaceAll("&amp;", "&"), base);
    if (!(["https:", "http:"].includes(url.protocol)) || url.username || url.password || url.port ||
        ["localhost", "127.0.0.1", "::1"].includes(url.hostname)) return;
    return url.href;
  } catch { return; }
}

function publicUrl(raw: string, base: string): string | undefined {
  const url = sourceLink(raw, base);
  return url?.startsWith("https:") ? url : undefined;
}

function body(html: string, canonicalUrl: string): Pick<ResolvedPost, "text" | "media" | "mediaIssues"> {
  const media: MediaAsset[] = [];
  const issues: NonNullable<ResolvedPost["mediaIssues"]> = [];
  const seen = new Set<string>();
  const converter = new TurndownService({ headingStyle: "atx", bulletListMarker: "-", codeBlockStyle: "fenced" });
  converter.remove(["script", "style", "noscript", "form"]);
  converter.addRule("forumSvg", { filter: node => node.nodeName === "SVG", replacement: () => "" });
  const addMedia = (kind: MediaAsset["kind"], raw: string | null, alt: string): string => {
    const url = raw && publicUrl(raw, canonicalUrl);
    if (!url) {
      issues.push({ sourcePlacement: "body", status: "unsafe_url", ...(raw ? { url: raw } : {}) });
      return alt || "[unavailable media]";
    }
    if (!seen.has(url)) {
      seen.add(url);
      media.push({ ref: "0.0", kind, url, sourcePlacement: "body", alt });
    }
    return kind === "image" ? `![${converter.escape(alt)}](<${url}>)` : `[${kind === "video" ? "Video" : "Audio"}](<${url}>)`;
  };
  converter.addRule("forumImage", {
    filter: "img",
    replacement: (_content, node) => {
      const srcset = node.getAttribute("srcset")?.split(",").at(-1)?.trim().split(/\s+/)[0];
      return addMedia("image", node.getAttribute("src") || node.getAttribute("data-src") || srcset || null, node.getAttribute("alt") ?? "");
    },
  });
  converter.addRule("forumVideo", {
    filter: ["video", "audio"],
    replacement: (_content, node) => addMedia(node.nodeName === "VIDEO" ? "video" : "audio",
      node.getAttribute("src") || node.querySelector("source")?.getAttribute("src") || null, ""),
  });
  converter.addRule("forumIframe", {
    filter: "iframe",
    replacement: (_content, node) => {
      const raw = node.getAttribute("src");
      const url = raw && publicUrl(raw, canonicalUrl);
      if (!url) return "[unavailable embed]";
      issues.push({ sourcePlacement: "body", status: "unsupported", url });
      return `[Embedded media](<${url}>)`;
    },
  });
  converter.addRule("forumLink", {
    filter: "a",
    replacement: (content, node) => {
      const raw = node.getAttribute("href");
      if (!raw) return content;
      const url = sourceLink(raw, canonicalUrl);
      return url ? `[${content || converter.escape(url)}](<${url}>)` : content;
    },
  });
  converter.addRule("forumCaption", {
    filter: "figcaption",
    replacement: content => content.trim() ? `\n\n${content.trim()}\n\n` : "",
  });
  converter.addRule("forumStrike", { filter: ["s", "del"], replacement: content => `~~${content}~~` });
  const text = converter.turndown(html).trim();
  return { text, media, ...(issues.length ? { mediaIssues: issues } : {}) };
}

function verifiedPost(value: unknown, source: ForumSource): ForumPost {
  if (!value) throw new Error(`${siteName(source)} post is unavailable.`);
  const post = postSchema.parse(value);
  if (post._id !== source.id) throw new Error(`${siteName(source)} returned a different post.`);
  const permalink = parseSource(post.pageUrl);
  if (permalink.provider !== "forum_magnum" || permalink.site !== source.site || permalink.id !== source.id || permalink.commentId) {
    throw new Error(`${siteName(source)} returned a different post link.`);
  }
  if (post.status !== 2 || post.draft || post.isFuture || !post.user) throw new Error(`${siteName(source)} post is unavailable.`);
  if (!post.contents?.html?.trim() && post.shortform) throw new Error("This link opens a Shortform page. Copy the link to the Quick Take you want to capture.");
  if (!post.contents?.html?.trim()) throw new Error(`${siteName(source)} post text is unavailable.`);
  return post;
}

function verifiedComment(value: unknown, source: ForumSource, expectedId: string): ForumComment {
  if (!value) throw new Error(`${siteName(source)} comment is unavailable.`);
  const comment = commentSchema.parse(value);
  if (comment._id !== expectedId || comment.postId !== source.id) throw new Error(`${siteName(source)} returned a comment from a different post.`);
  const permalink = parseSource(comment.pageUrl);
  if (permalink.provider !== "forum_magnum" || permalink.site !== source.site || permalink.id !== source.id || permalink.commentId !== expectedId) {
    throw new Error(`${siteName(source)} returned a different comment link.`);
  }
  if (comment.deleted || comment.deletedPublic || comment.draft || comment.rejected || !comment.user || !comment.contents?.html?.trim()) {
    throw new Error(`${siteName(source)} comment is unavailable.`);
  }
  return comment;
}

function postResult(post: ForumPost): ResolvedPost {
  return {
    provider: "forum_magnum", id: post._id, canonicalUrl: post.pageUrl,
    author: { handle: post.user!.username, ...(post.user!.displayName ? { name: post.user!.displayName } : {}) },
    postTitle: post.title, postedAt: post.postedAt,
    ...body(post.contents!.html!, post.pageUrl),
  };
}

function commentResult(comment: ForumComment, post: ForumPost): ResolvedPost {
  return {
    provider: "forum_magnum", id: comment._id, canonicalUrl: comment.pageUrl,
    author: { handle: comment.user!.username, ...(comment.user!.displayName ? { name: comment.user!.displayName } : {}) },
    storyTitle: post.title, postedAt: comment.postedAt,
    ...(comment.parentCommentId ? { replyTo: { id: comment.parentCommentId } } : {}),
    ...body(comment.contents!.html!, comment.pageUrl),
  };
}

export class ForumMagnumProvider implements SocialProvider {
  constructor(private readonly fetcher: Fetcher = fetch) {}

  private async query(source: ForumSource, query: string, variables: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
    const response = await this.fetcher(`${origins[source.site]}/graphql`, {
      method: "POST", headers: { accept: "application/json", "content-type": "application/json", "user-agent": "arena-block/0.1" },
      body: JSON.stringify({ query, variables }), redirect: "error", credentials: "omit",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      throw new Error(`${siteName(source)} returned HTTP ${response.status}. Capture could not read this link.`);
    }
    if (!response.headers.get("content-type")?.includes("application/json")) throw new Error(`${siteName(source)} returned an unreadable response.`);
    const payload = await response.json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || payload.errors?.length) {
      throw new Error(`${siteName(source)} returned an unreadable response.`);
    }
    return payload.data;
  }

  private async post(source: ForumSource, signal?: AbortSignal): Promise<ForumPost> {
    return verifiedPost((await this.query(source, postQuery, { id: source.id }, signal))?.post?.result, source);
  }

  private async comment(source: ForumSource, commentId: string, signal?: AbortSignal): Promise<ForumComment> {
    return verifiedComment((await this.query(source, commentQuery, { id: commentId }, signal))?.comment?.result, source, commentId);
  }

  async resolve(input: ParsedSource, signal?: AbortSignal): Promise<ResolvedPost> {
    if (input.provider !== "forum_magnum") throw new Error("Expected a Forum Magnum source");
    if (!input.commentId) return postResult(await this.post(input, signal));
    const [post, comment] = await Promise.all([this.postForComment(input, signal), this.comment(input, input.commentId, signal)]);
    return commentResult(comment, post);
  }

  private async postForComment(source: ForumSource, signal?: AbortSignal): Promise<ForumPost> {
    // Shortform containers can have no post body. Their comments are the authored content.
    const value = (await this.query(source, postQuery, { id: source.id }, signal))?.post?.result;
    if (!value) throw new Error(`${siteName(source)} post is unavailable.`);
    const post = postSchema.parse(value);
    if (post._id !== source.id || post.status !== 2 || post.draft || post.isFuture || !post.user) {
      throw new Error(`${siteName(source)} post is unavailable.`);
    }
    const permalink = parseSource(post.pageUrl);
    if (permalink.provider !== "forum_magnum" || permalink.site !== source.site || permalink.id !== source.id || permalink.commentId) {
      throw new Error(`${siteName(source)} returned a different post link.`);
    }
    return post;
  }

  async discoverRelated(input: ForumSource, mode: "auto" | "on", signal?: AbortSignal): Promise<{ posts: ResolvedPost[]; seedId: string }> {
    if (!input.commentId) throw new Error("Copy a comment link to include its author chain.");
    signal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(60_000)]);
    const [post, seed] = await Promise.all([this.postForComment(input, signal), this.comment(input, input.commentId, signal)]);
    const seedAuthor = commentAuthorId(seed);
    const ancestors: ForumComment[] = [];
    const visited = new Set([seed._id]);
    let parentId = seed.parentCommentId;
    for (; parentId;) {
      if (visited.has(parentId)) throw new Error("The comment links form a cycle. Capture cannot determine their order.");
      visited.add(parentId);
      try {
        const parent = await this.comment(input, parentId, signal);
        if (commentAuthorId(parent) !== seedAuthor) break;
        if (ancestors.length + 1 >= MAX_EXPANDED_SOURCE_POSTS) throw new Error("The author chain exceeds 32 comments. Choose exact comment permalinks.");
        ancestors.unshift(parent);
        parentId = parent.parentCommentId;
      } catch (error) {
        if (signal?.aborted) throw error;
        if (!(error instanceof Error) || !/unavailable|private|deleted/.test(error.message)) throw error;
        break; // The selected public comment remains usable without an unavailable parent.
      }
    }
    const selected: ForumComment[] = [...ancestors, seed];
    if (mode === "on") {
      let index = selected.length - 1;
      while (true) {
        const parent = selected[index]!;
        const response = await this.query(input, repliesQuery,
          { terms: { view: "commentReplies", parentCommentId: parent._id, limit: 101 } }, signal);
        const raw = response?.comments?.results;
        if (!Array.isArray(raw) || raw.length >= 101 || parent.directChildrenCount == null || raw.length !== parent.directChildrenCount) throw new Error(`${siteName(input)} returned an incomplete set of replies. Choose exact comment permalinks.`);
        const ids = new Set<string>();
        const replies = raw.map(value => {
          const item = commentSchema.parse(value);
          if (item.parentCommentId !== parent._id || item.postId !== input.id || ids.has(item._id)) throw new Error(`${siteName(input)} returned inconsistent reply identities.`);
          const source = parseSource(item.pageUrl);
          if (source.provider !== "forum_magnum" || source.site !== input.site || source.id !== input.id || source.commentId !== item._id) {
            throw new Error(`${siteName(input)} returned a different comment link.`);
          }
          ids.add(item._id);
          return item;
        });
        const owned = replies.filter(item => item.user?._id === seedAuthor);
        if (owned.length > 1) throw new Error(`${siteName(input)} author replies branch. Choose exact comment permalinks in the intended order, or omit -t.`);
        if (replies.some(item => !item.user?._id)) throw new Error(`${siteName(input)} returned incomplete reply author identities. Choose exact comment permalinks.`);
        const reply = owned[0];
        if (!reply) break;
        const verified = verifiedComment(reply, input, reply._id);
        if (visited.has(reply._id)) throw new Error("The comment links form a cycle. Capture cannot determine their order.");
        if (selected.length >= MAX_EXPANDED_SOURCE_POSTS) throw new Error("The author chain exceeds 32 comments. Choose exact comment permalinks.");
        selected.push(verified); visited.add(reply._id);
        index++;
      }
    }
    return { seedId: seed._id, posts: selected.map(item => commentResult(item, post)) };
  }
}
