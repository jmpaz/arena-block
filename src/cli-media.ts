import { mediaSources } from "../packages/core/media-tree.ts";
import { renderedQuoteDepth } from "../packages/core/quote-policy.ts";
import { explicitAudio } from "../packages/core/render-recipe.ts";
import type { CompositionPolicy, ResolvedPost } from "./types.ts";

/** Freeze a fresh CLI choice against the resolver's complete selected-post set.
 * Expanded thread members are selected posts too. A quoted copy has its own
 * refs and is eligible only when named; its ID never excludes a selected copy.
 * Saved plans bypass this step and retain their original policy and selection.
 */
export function selectedPostMediaPolicy(posts: ResolvedPost[], policy: CompositionPolicy): CompositionPolicy {
  const mode = policy.media;
  if (!["all", "images", "video", "audio"].includes(mode)) return policy;
  const audio = explicitAudio(policy);
  const named = new Set([...(policy.mediaOrder ?? []), ...(policy.videoFrames ?? []), ...(audio ? [audio] : [])]);
  const selectedMedia = mediaSources(posts, renderedQuoteDepth(policy)).flatMap(node => node.media
    .filter(asset => (node.quoteDepth === 0 || named.has(asset.ref))
      && (mode === "all" || asset.kind === (mode === "images" ? "image" : mode)))
    .map(asset => asset.ref));
  return { ...policy, media: "selected", selectedMedia };
}
