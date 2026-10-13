import { z } from "zod";
import type { MediaAsset, ResolvedPost } from "../types.ts";
import type { ParsedSource } from "../url.ts";
import type { Fetcher } from "./comments.ts";
import type { SocialProvider } from "./provider.ts";

const mediaURL = z.url().refine(value => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password && !url.port;
}, "Are.na media must use HTTPS without credentials or custom ports");
const image = z.object({
  src: mediaURL.optional(), alt_text: z.string().nullish(), content_type: z.string().optional(),
  width: z.number().int().positive().nullish(), height: z.number().int().positive().nullish(), updated_at: z.string().optional(),
});
const markdown = z.union([z.string(), z.object({ markdown: z.string() })]).nullish();
const blockSchema = z.object({
  id: z.number().int().positive().safe(), type: z.enum(["Image", "Link", "Attachment", "Embed", "Text"]), state: z.literal("available"),
  title: z.string().nullish(), description: markdown, created_at: z.string().optional(), updated_at: z.string().optional(),
  user: z.object({ slug: z.string().min(1), name: z.string().optional() }),
  source: z.object({ url: z.url().nullish() }).nullish(), image: image.nullish(),
  attachment: z.object({ url: mediaURL, content_type: z.string().nullish(), updated_at: z.string().nullish(), image: image.nullish() }).nullish(),
  embed: z.object({ thumbnail_url: mediaURL.nullish(), image: image.nullish() }).nullish(),
});

/** Convert an already-read v3 block, including a device-authorized private read. Never fetches or extracts embed HTML. */
export function arenaMediaPost(value: unknown, expectedId: number | string): ResolvedPost {
  const block = blockSchema.parse(value);
  if (String(block.id) !== String(expectedId)) throw new Error("Are.na returned a different source block");
  if (block.type === "Text") throw new Error("An Are.na Text block cannot be used as mosaic media");
  const ref = `https://www.are.na/block/${block.id}`;
  let media: MediaAsset | undefined;
  let mediaUpdatedAt: string | undefined;
  if (block.type === "Attachment" && block.attachment?.content_type?.startsWith("video/")) {
    media = { ref: "0.0", id: String(block.id), kind: "video", url: block.attachment.url,
      ...(block.attachment.image?.src ? { posterUrl: block.attachment.image.src } : {}),
      mimeType: block.attachment.content_type, sourceRole: "original", alt: "" };
    mediaUpdatedAt = block.attachment.updated_at ?? undefined;
  } else {
    const asset = block.type === "Attachment" ? block.attachment?.image : block.type === "Embed" ? block.embed?.image : block.image;
    const url = asset?.src ?? (block.type === "Embed" ? block.embed?.thumbnail_url : undefined);
    if (url) {
      media = { ref: "0.0", id: String(block.id), kind: "image", url, sourceRole: block.type === "Image" ? "original" : "preview",
        alt: asset?.alt_text ?? "", ...(asset?.content_type ? { mimeType: asset.content_type } : {}),
        ...(asset?.width ? { width: asset.width } : {}), ...(asset?.height ? { height: asset.height } : {}) };
      mediaUpdatedAt = asset?.updated_at;
    }
  }
  if (!media) throw new Error(`Are.na ${block.type} block has no usable image or video media`);
  return {
    provider: "arena", id: String(block.id), canonicalUrl: ref, author: { handle: block.user.slug, ...(block.user.name ? { name: block.user.name } : {}) },
    text: typeof block.description === "string" ? block.description : block.description?.markdown ?? "",
    postTitle: block.title ?? `Are.na block ${block.id}`, ...(block.created_at ? { postedAt: block.created_at } : {}), media: [media],
    arenaBlock: { type: block.type, ...(block.source?.url ? { sourceURL: block.source.url } : {}),
      ...(block.updated_at ? { updatedAt: block.updated_at } : {}), ...(mediaUpdatedAt ? { mediaUpdatedAt } : {}) },
  };
}

/** Public block resolution. Native private reads use arenaMediaPost with the existing on-device Are.na credential. */
export class ArenaMediaProvider implements SocialProvider {
  constructor(private readonly fetcher: Fetcher = fetch) {}
  async resolve(source: ParsedSource, signal?: AbortSignal): Promise<ResolvedPost> {
    if (source.provider !== "arena") throw new Error("Expected an Are.na source block");
    const response = await this.fetcher(`https://api.are.na/v3/blocks/${source.id}`, {
      headers: { accept: "application/json", "user-agent": "arena-block/0.1" }, redirect: "error",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Are.na source read returned ${response.status}; use an accessible non-text block`);
    return arenaMediaPost(await response.json(), source.id);
  }
}
