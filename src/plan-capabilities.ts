import type { BlockPlan, ResolvedPost } from "./types.ts";
import { mediaSources } from "../packages/core/media-tree.ts";

/** Collect the receiver capabilities needed before submitting a publication capsule. */
export function requiredPlanCapabilities(plan: BlockPlan): string[] {
  const required = new Set<string>();
  if (plan.policy.quoteAuthorLink !== undefined) required.add("quote-author-links-v1");
  const referenced = new Set([...plan.block.selectedMedia, ...plan.policy.selectedMedia, ...(plan.policy.mediaOrder ?? []), ...(plan.policy.videoFrames ?? []), ...(plan.policy.audio ? [plan.policy.audio] : [])]);
  if (mediaSources(plan.sources).some(node => node.quoteDepth > 0 && node.media.some(asset => asset.kind === "image" && referenced.has(asset.ref)))) required.add("quoted-image-media-v1");
  if (mediaSources(plan.sources).some(node => node.quoteDepth > 0 && node.media.some(asset => asset.kind !== "image" && referenced.has(asset.ref)))) required.add("quoted-video-audio-v1");
  if (plan.sources.length > 20) required.add("expanded-source-count-32-v1");
  const visit = (post: ResolvedPost): void => {
    if (post.media.some(item => item.acquisition === "soundcloud-mp3")) required.add("soundcloud-mp3-v1");
    let note = post.substackCapture?.note;
    while (note) {
      if (note.attachmentEvidence) required.add("substack-note-attachments-v1");
      if(note.attachmentEvidence?.attachments.some(a=>a.kind==="article"&&a.podcast))required.add("substack-note-podcast-audio-v1");
      note = note.quote?.expanded;
    }
    if(post.media.some(asset=>asset.sourceAttribution))required.add("substack-note-podcast-audio-v1");
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
