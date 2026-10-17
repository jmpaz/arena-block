import type { CompositionPolicy, ResolvedPost } from "../types.ts";
import type { ParsedSource } from "../url.ts";
import { MAX_QUOTE_DEPTH } from "../types.ts";

export type SourceResolutionPolicy = Pick<CompositionPolicy, "quoteDepth" | "quote">;
export interface SocialProvider {
  resolve(source: ParsedSource, signal?: AbortSignal, policy?: Partial<SourceResolutionPolicy>): Promise<ResolvedPost>;
}

export function assignMediaRefs(post: ResolvedPost, postIndex: number): ResolvedPost {
  return {
    ...post,
    media: post.media.map((item, mediaIndex) => ({
      ...item,
      ref: `${postIndex + 1}.${mediaIndex + 1}`,
    })),
    ...(post.quote ? { quote: assignQuoteRefs(post.quote, postIndex, { next: post.media.length }, 1, new Set([post])) } : {}),
  };
}

function assignQuoteRefs(post: ResolvedPost, postIndex: number, cursor: { next: number }, depth: number, seen: Set<ResolvedPost>): ResolvedPost {
  if (depth > MAX_QUOTE_DEPTH || seen.has(post)) throw new Error("Quoted media exceeds the supported source depth or repeats a source node");
  const path = new Set(seen); path.add(post);
  return {
    ...post,
    media: post.media.map((item, index) => ({ ...item, ref: item.sourceRole !== "preview"
      ? `${postIndex + 1}.${++cursor.next}` : `quote${depth === 1 ? "" : depth}.${index + 1}` })),
    ...(post.quote ? { quote: assignQuoteRefs(post.quote, postIndex, cursor, depth + 1, path) } : {}),
  };
}
