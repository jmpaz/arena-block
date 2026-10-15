import type { BlockPlan, ResolvedPost } from "./types.ts";

/** Collect the receiver capabilities needed before submitting a publication capsule. */
export function requiredPlanCapabilities(plan: BlockPlan): string[] {
  const required = new Set<string>();
  if (plan.sources.length > 20) required.add("expanded-source-count-32-v1");
  const visit = (post: ResolvedPost): void => {
    if (post.media.some(item => item.acquisition === "substack-public-original")) required.add("substack-native-media-v1");
    if (post.substackArticle || post.substackRelation || post.substackThread) required.add("substack-public-sources-v2");
    if (post.provider === "substack" || post.substackCapture) required.add("substack-browser-records-v1");
    if (post.redditCapture) required.add("reddit-browser-records-v1");
    if (post.redditCapture?.schema === "arena-block/reddit-public-page-capture") required.add("reddit-public-page-records-v1");
    if (post.provider === "delve") required.add("delve-posts-v1");
    if (post.provider === "forum_magnum") required.add("forum-magnum-posts-v1");
    if (post.atproto || post.facets || post.external || post.embeddedRecord) required.add("atproto-post-records-v1");
    if (post.threadCoverage) required.add("bluesky-thread-coverage-v1");
    if (post.quote) visit(post.quote);
  };
  plan.sources.forEach(visit);
  return [...required];
}
