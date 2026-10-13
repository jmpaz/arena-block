import type { CompositionPolicy, ResolvedPost } from "../types.ts";
import type { ParsedSource } from "../url.ts";

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
    ...(post.quote ? { quote: assignQuoteRefs(post.quote) } : {}),
  };
}

function assignQuoteRefs(post: ResolvedPost, depth = 1): ResolvedPost {
  return {
    ...post,
    media: post.media.map((item, index) => ({ ...item, ref: `quote${depth === 1 ? "" : depth}.${index + 1}` })),
    ...(post.quote ? { quote: assignQuoteRefs(post.quote, depth + 1) } : {}),
  };
}
