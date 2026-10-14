import TurndownService from "turndown";
import { z } from "zod";
import type { MediaAsset, ResolvedPost } from "../types.ts";
import { parseSource, type ParsedSource } from "../url.ts";
import type { Fetcher } from "./comments.ts";
import type { SocialProvider } from "./provider.ts";

type ForumSource = Extract<ParsedSource, { provider: "forum_magnum" }>;
const origins = {
  lesswrong: "https://www.lesswrong.com",
  alignment_forum: "https://www.alignmentforum.org",
  ea_forum: "https://forum.effectivealtruism.org",
} as const;
const id = z.string().regex(/^[A-Za-z0-9]+$/);
const user = z.object({ username: z.string().min(1), displayName: z.string().nullish() }).nullish();
const postSchema = z.object({
  _id: id, title: z.string().min(1), pageUrl: z.string().url(), postedAt: z.string(),
  status: z.number(), draft: z.boolean().nullish(), isFuture: z.boolean().nullish(),
  shortform: z.boolean().nullish(), contents: z.object({ html: z.string().nullish() }).nullish(), user,
});
const commentSchema = z.object({
  _id: id, postId: id, parentCommentId: id.nullish(), pageUrl: z.string().url(),
  postedAt: z.string(), deleted: z.boolean(), deletedPublic: z.boolean(),
  draft: z.boolean().nullish(), rejected: z.boolean().nullish(),
  contents: z.object({ html: z.string().nullish() }).nullish(), user,
});
type ForumPost = z.infer<typeof postSchema>;
type ForumComment = z.infer<typeof commentSchema>;

const postQuery = `query ForumPost($id: String!) {
  post(input: {selector: {_id: $id}}) { result {
    _id title pageUrl postedAt status draft isFuture shortform contents { html }
    user { username displayName }
  } }
}`;
const commentQuery = `query ForumComment($id: String!) {
  comment(input: {selector: {_id: $id}}) { result {
    _id postId parentCommentId pageUrl postedAt deleted deletedPublic draft rejected
    contents { html } user { username displayName }
  } }
}`;
const repliesQuery = `query ForumReplies($terms: JSON) {
  comments(input: {terms: $terms}) { results {
    _id postId parentCommentId pageUrl postedAt deleted deletedPublic draft rejected
    contents { html } user { username displayName }
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
    replacement: content => content.trim() ? `\n\n*Caption:* ${content.trim()}\n\n` : "",
  });
  converter.addRule("forumStrike", { filter: ["s", "del"], replacement: content => `~~${content}~~` });
  const text = converter.turndown(html).trim();
  return { text, media, ...(issues.length ? { mediaIssues: issues } : {}) };
}

function verifiedPost(value: unknown, source: ForumSource): ForumPost {
  if (!value) throw new Error(`Forum Magnum post ${source.id} is unavailable or private`);
  const post = postSchema.parse(value);
  if (post._id !== source.id) throw new Error("Forum Magnum returned a different post");
  const permalink = parseSource(post.pageUrl);
  if (permalink.provider !== "forum_magnum" || permalink.site !== source.site || permalink.id !== source.id || permalink.commentId) {
    throw new Error("Forum Magnum returned a mismatched post permalink");
  }
  if (post.status !== 2 || post.draft || post.isFuture || !post.user) throw new Error("Forum Magnum post is unavailable, private, or deleted");
  if (!post.contents?.html?.trim() && post.shortform) throw new Error("This Shortform post is a container; choose a Quick Take comment permalink");
  if (!post.contents?.html?.trim()) throw new Error("Forum Magnum post body is unavailable");
  return post;
}

function verifiedComment(value: unknown, source: ForumSource, expectedId: string): ForumComment {
  if (!value) throw new Error(`Forum Magnum comment ${expectedId} is unavailable or private`);
  const comment = commentSchema.parse(value);
  if (comment._id !== expectedId || comment.postId !== source.id) throw new Error("Forum Magnum returned a comment from a different post");
  const permalink = parseSource(comment.pageUrl);
  if (permalink.provider !== "forum_magnum" || permalink.site !== source.site || permalink.id !== source.id || permalink.commentId !== expectedId) {
    throw new Error("Forum Magnum returned a mismatched comment permalink");
  }
  if (comment.deleted || comment.deletedPublic || comment.draft || comment.rejected || !comment.user || !comment.contents?.html?.trim()) {
    throw new Error(`Forum Magnum comment ${expectedId} is unavailable, private, or deleted`);
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
    if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
      throw new Error(`Forum Magnum public API returned HTTP ${response.status}; current content cannot be verified`);
    }
    const payload = await response.json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || payload.errors?.length) {
      throw new Error(`Forum Magnum public API did not return usable content${payload?.errors?.[0]?.message ? `: ${payload.errors[0].message}` : ""}`);
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
    if (!value) throw new Error(`Forum Magnum post ${source.id} is unavailable or private`);
    const post = postSchema.parse(value);
    if (post._id !== source.id || post.status !== 2 || post.draft || post.isFuture || !post.user) {
      throw new Error("Forum Magnum post is unavailable, private, or deleted");
    }
    const permalink = parseSource(post.pageUrl);
    if (permalink.provider !== "forum_magnum" || permalink.site !== source.site || permalink.id !== source.id || permalink.commentId) {
      throw new Error("Forum Magnum returned a mismatched post permalink");
    }
    return post;
  }

  /** Ancestors by default; opt-in adds only bounded direct replies and same-author continuations. */
  async discoverRelated(input: ForumSource, mode: "auto" | "on", signal?: AbortSignal): Promise<{ posts: ResolvedPost[]; seedId: string }> {
    if (!input.commentId) throw new Error("Forum Magnum expansion needs a comment permalink");
    const [post, seed] = await Promise.all([this.postForComment(input, signal), this.comment(input, input.commentId, signal)]);
    const ancestors: ForumComment[] = [];
    const visited = new Set([seed._id]);
    let parentId = seed.parentCommentId;
    for (let depth = 0; parentId && depth < 6; depth++) {
      if (visited.has(parentId)) throw new Error("Forum Magnum comment ancestry contains a cycle");
      visited.add(parentId);
      try {
        const parent = await this.comment(input, parentId, signal);
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
      const queue: Array<{ parent: ForumComment; depth: number }> = [{ parent: seed, depth: 0 }];
      while (queue.length && selected.length < 16) {
        const { parent, depth } = queue.shift()!;
        if (depth >= 3) continue;
        const response = await this.query(input, repliesQuery,
          { terms: { view: "commentReplies", parentCommentId: parent._id, limit: depth ? 5 : 9 } }, signal);
        const raw = response?.comments?.results;
        if (!Array.isArray(raw)) throw new Error("Forum Magnum replies response is incomplete");
        const replies = raw.map(value => {
          const item = commentSchema.parse(value);
          if (item.parentCommentId !== parent._id) throw new Error("Forum Magnum returned an unrelated reply");
          return item;
        }).filter(item => !item.deleted && !item.deletedPublic && !item.draft && !item.rejected && item.user && item.contents?.html?.trim())
          .slice(0, depth ? 4 : 8);
        replies.sort((a, b) => a.postedAt.localeCompare(b.postedAt) || a._id.localeCompare(b._id));
        for (const reply of replies) {
          if (selected.length >= 16 || visited.has(reply._id)) continue;
          const verified = verifiedComment(reply, input, reply._id);
          selected.push(verified); visited.add(reply._id);
          if (reply.user!.username === parent.user!.username) queue.push({ parent: verified, depth: depth + 1 });
        }
      }
    }
    return { seedId: seed._id, posts: selected.map(item => commentResult(item, post)) };
  }
}
