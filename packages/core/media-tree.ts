import type { BlockPlan, MediaAsset, ResolvedPost } from "./types.ts";
import { MAX_QUOTE_DEPTH } from "./types.ts";
import { renderedQuoteDepth } from "./quote-policy.ts";

export type MediaSource = { source: ResolvedPost; rootIndex: number; quoteDepth: number; media: MediaAsset[] };

/** Legacy quote.N references remain readable but were never selectable. */
export function isAddressableQuoteImage(asset: MediaAsset, rootIndex: number): boolean {
  return asset.kind === "image" && isAddressableQuoteMedia(asset, rootIndex);
}

export function isAddressableQuoteMedia(asset: MediaAsset, rootIndex: number): boolean {
  return asset.sourceRole !== "preview"
    && asset.ref.startsWith(`${rootIndex + 1}.`) && /^\d+\.[1-9]\d*$/.test(asset.ref);
}

/** Source order is outer post, its quoted ancestors, then the next post. */
export function mediaSources(posts: ResolvedPost[], maximumDepth = MAX_QUOTE_DEPTH): MediaSource[] {
  const result: MediaSource[] = [];
  posts.forEach((root, rootIndex) => {
    const seen = new Set<ResolvedPost>();
    let source: ResolvedPost | undefined = root;
    for (let quoteDepth = 0; source && quoteDepth <= Math.min(MAX_QUOTE_DEPTH, maximumDepth) && !seen.has(source); quoteDepth++) {
      seen.add(source);
      result.push({ source, rootIndex, quoteDepth, media: quoteDepth === 0 ? source.media : source.media.filter(asset => isAddressableQuoteMedia(asset, rootIndex)) });
      source = source.quote;
    }
  });
  return result;
}

export function selectableMedia(posts: ResolvedPost[], maximumDepth = MAX_QUOTE_DEPTH): MediaAsset[] {
  const assets = mediaSources(posts, maximumDepth).flatMap(node => node.media);
  const refs = new Set<string>();
  for (const asset of assets) {
    // Providers use 0.0 until the resolver assigns source-scoped refs. Keep
    // direct, unassigned provider records compatible with existing callers.
    if (asset.ref !== "0.0" && refs.has(asset.ref)) throw new Error(`Media reference ${asset.ref} identifies more than one source asset`);
    refs.add(asset.ref);
  }
  return assets;
}

export function planMedia(plan: Pick<BlockPlan, "sources" | "policy">): MediaAsset[] {
  return selectableMedia(plan.sources, renderedQuoteDepth(plan.policy));
}

/** Only selected moving video can supply a composition soundtrack. */
export function videoSoundtrackSources(plan: BlockPlan): MediaSource[] {
  const selected = new Set(plan.block.selectedMedia);
  const frames = new Set((plan.block.frameMedia ?? []).map(asset => asset.ref));
  return mediaSources(plan.sources, renderedQuoteDepth(plan.policy)).map(node => ({ ...node,
    media: node.media.filter(asset => asset.kind === "video" && selected.has(asset.ref) && !frames.has(asset.ref)),
  })).filter(node => node.media.length > 0);
}

export function requireAddressableQuoteImages(plan: BlockPlan): void {
  for (const node of mediaSources(plan.sources, renderedQuoteDepth(plan.policy))) {
    if (node.quoteDepth && node.source.media.some(asset => asset.kind === "image" && asset.sourceRole !== "preview" && !isAddressableQuoteImage(asset, node.rootIndex))) {
      throw new Error("The receiver cannot include images from quoted posts. Install a matching receiver; no save was submitted.");
    }
  }
}

export function requireAddressableQuoteMedia(plan: BlockPlan): void {
  for (const node of mediaSources(plan.sources, renderedQuoteDepth(plan.policy))) {
    if (node.quoteDepth && node.source.media.some(asset => asset.sourceRole !== "preview" && !isAddressableQuoteMedia(asset, node.rootIndex))) {
      throw new Error("The receiver cannot include media from quoted posts. Install a matching receiver; no save was submitted.");
    }
  }
}
