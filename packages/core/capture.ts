import { z } from "zod";
import { parseSource } from "./url.ts";
import type { BlockPlan, CompositionPolicy } from "./types.ts";
import { compositionPolicySchema } from "./types.ts";
import { composePlan } from "./compose.ts";
import { explicitSelections } from "./source-selection.ts";

export const captureInputSchema = z.object({
  url: z.string().min(1).max(8192).optional(),
  refs: z.array(z.string().min(1).max(8192)).min(1).max(20).optional(),
  media: z.enum(["auto", "all", "none"]).default("auto"),
  threadExpansion: z.enum(["auto", "on", "off"]).optional(),
  extraRefs: z.array(z.string().min(1).max(8192)).max(19).default([]),
  policy: compositionPolicySchema.optional(),
}).refine(input => Boolean(input.url) !== Boolean(input.refs), "Supply either one URL or ordered primary refs")
  .refine(input => (input.refs?.length ?? (input.url ? 1 : 0)) + input.extraRefs.length <= 20, "At most 20 source posts are supported");

/** Keep primary prose and append explicitly media-only sources in stable order. */
export function sourceComposition(refs: string[], extraRefs: string[] = [], policy: Partial<CompositionPolicy> = {}): { refs: string[]; policy: Partial<CompositionPolicy> } {
  const selected = explicitSelections(refs, extraRefs);
  const firstExtra = selected.findIndex(item => item.role === "extra");
  return { refs: selected.map(item => item.ref), policy: { ...policy,
    ...(firstExtra >= 0 ? { mediaOnlyPosts: selected.slice(firstExtra).map((_, index) => firstExtra + index + 1) } : {}) } };
}

export function captureSource(value: string): { kind: "social" | "url"; url: string } {
  if (value.startsWith("at://")) return { kind: "social", url: parseSource(value).canonicalUrl };
  const url = new URL(value);
  if (!["https:", "http:", "at:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Capture a web URL without embedded credentials");
  }
  try {
    return { kind: "social", url: parseSource(value).canonicalUrl };
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith("Unsupported social post URL:") || url.protocol === "at:") throw error;
    return { kind: "url", url: url.href };
  }
}

export const webPlanInputSchema = z.object({
  url: z.string().min(1).max(8192),
  title: z.string().trim().min(1).max(512).optional(),
  description: z.string().max(20_000).optional(),
}).strict();

/** Preserve an ordinary URL as a Link block without fetching or inventing page metadata. */
export function webPlan(input: z.input<typeof webPlanInputSchema>): BlockPlan {
  const value = webPlanInputSchema.parse(input);
  const source = captureSource(value.url);
  if (source.kind !== "url") throw new Error("Use the social resolver for a supported post URL");
  const title = value.title ?? new URL(source.url).hostname;
  return composePlan([{
    provider: "web", id: source.url, canonicalUrl: source.url,
    author: { handle: new URL(source.url).hostname }, text: value.description ?? "",
    postTitle: title, media: [],
  }], { media: "none" });
}

export function publicationFields(plan: BlockPlan): Record<string, unknown> {
  return {
    title: plan.block.title,
    description: plan.block.kind === "text" || plan.block.kind === "url" ? plan.block.description ?? ""
      : [plan.block.markdown, plan.block.description].filter(Boolean).join("\n\n"),
    ...(plan.block.kind === "text" ? { content: plan.block.markdown } : {}),
  };
}

export function publicationPayload(plan: BlockPlan, publicBaseUrl: string, media: { hash: string; extension: string } | undefined, channelIds: number[]): Record<string, unknown> {
  const base = {
    title: plan.block.title,
    original_source_url: plan.block.canonicalSource,
    original_source_title: plan.block.title,
    metadata: { arena_block_plan: plan.hash, arena_block_version: plan.schemaVersion },
    channel_ids: [...new Set(channelIds)],
    description: `arena-block description ${plan.hash}`,
  };
  if (plan.block.kind === "text") return {
    ...base,
    value: `arena-block text ${plan.hash}`,
  };
  if (plan.block.kind === "image") {
    if (!plan.block.artworkUrl) throw new Error("SoundCloud playlist Image has no source artwork");
    return { ...base, value: plan.block.artworkUrl };
  }
  if (plan.block.kind === "url") return {
    ...base, value: plan.block.canonicalSource,
    ...(plan.block.artworkUrl ? { cover_url: plan.block.artworkUrl } : {}),
  };
  if (!media) throw new Error("Media plan rendered no public artifact");
  const mediaUrl = `${publicBaseUrl}/media/${media.hash}.${media.extension}`;
  if (plan.block.kind === "video") return { ...base, value: mediaUrl };
  if (plan.block.kind === "audio") return { ...base, value: mediaUrl,
    ...(plan.block.artworkUrl ? { cover_url: plan.block.artworkUrl } : {}) };
  return {
    ...base,
    value: `${publicBaseUrl}/ingest/${plan.hash}`,
    cover_url: mediaUrl,
  };
}

export function publicationPayloadForMedia(plan: BlockPlan, mediaURL: string | undefined, ingestURL: string | undefined, channelIds: number[]): Record<string, unknown> {
  const payload = publicationPayload(plan, "https://capture.invalid", plan.block.kind === "text" ? undefined : { hash: "artifact", extension: "jpg" }, channelIds);
  if (plan.block.kind === "video") {
    if (!mediaURL) throw new Error("Media plan rendered no public artifact");
    payload.value = mediaURL;
  } else if (plan.block.kind === "audio") {
    if (!mediaURL) throw new Error("Audio plan rendered no public artifact");
    payload.value = mediaURL;
    if (plan.block.artworkUrl) payload.cover_url = plan.block.artworkUrl;
  } else if (plan.block.kind === "link") {
    if (!mediaURL || !ingestURL) throw new Error("Link plan requires a cover and ingest URL");
    payload.value = ingestURL;
    payload.cover_url = mediaURL;
  }
  return payload;
}
