import type { BlockPlan } from "./types.ts";
import { publicationFields } from "./capture.ts";
type Json = Record<string, unknown>;
function string(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function markdown(value: unknown): string | undefined { return typeof value === "string" ? value : value && typeof value === "object" ? string((value as Json).markdown) : undefined; }
export function verifyPublication(plan: BlockPlan, block: Json, available: Json): void {
    const state = string(block.state) ?? string(available.state);
    if (state !== "available") throw new Error(`Unexpected Are.na block state: ${state ?? "missing"}`);
    if (string(block.title) !== plan.block.title) throw new Error("Are.na title does not match the block plan");
    const type = string(block.type);
    if (plan.block.kind === "text" && type !== "Text") throw new Error(`Expected Text block, received ${type}`);
    if (plan.block.kind === "image" && type !== "Image") throw new Error(`Expected Image block, received ${type}`);
    if (plan.block.kind === "link" && type !== "Link") throw new Error(`Expected Link block, received ${type}`);
    const pdfAttachment = plan.block.kind === "url" && plan.sources[0]?.provider === "web" && type === "Attachment"
      && string(object(block.attachment)?.content_type)?.split(";", 1)[0]?.trim().toLowerCase() === "application/pdf";
    if (plan.block.kind === "url" && plan.block.contentType !== "application/pdf" && !pdfAttachment && !["Link", "Embed"].includes(type ?? "")) throw new Error(plan.sources[0]?.provider === "web" ? `Expected Link, Embed or PDF Attachment block, received ${type}` : `Expected Link or Embed block, received ${type}`);
    if (plan.block.contentType === "application/pdf" || pdfAttachment) {
      const attachment = object(block.attachment);
      if (type !== "Attachment" || string(attachment?.content_type)?.split(";", 1)[0]?.trim().toLowerCase() !== "application/pdf")
        throw new Error("Are.na did not retain a PDF attachment");
      const url = new URL(string(attachment?.url) ?? "https://invalid.invalid");
      if (url.protocol !== "https:" || url.hostname === "invalid.invalid" || url.username || url.password)
        throw new Error("Are.na PDF has no public attachment URL");
      if (plan.block.pdfFile && attachment?.file_size !== plan.block.pdfFile.byteCount)
        throw new Error("Are.na PDF size does not match the retained file");
    }
    if (plan.block.kind === "url" && plan.sources[0]?.provider === "web" && string(object(block.source)?.url) !== plan.block.canonicalSource)
      throw new Error("Are.na source does not match the selected source URL");
    if (plan.block.kind === "video" && !["Attachment", "Embed"].includes(type ?? "")) {
      throw new Error(`Expected video Attachment or Embed block, received ${type}`);
    }
    if (plan.block.kind === "audio" && type !== "Attachment") throw new Error(`Expected audio Attachment block, received ${type}`);
    const body = plan.block.kind === "text" ? markdown(block.content)
      : block.description == null ? "" : markdown(block.description);
    const expectedBody = plan.block.kind === "text" ? plan.block.markdown : publicationFields(plan).description ?? "";
    if (body !== expectedBody) throw new Error("Are.na Markdown does not match the block plan");
    if (plan.block.kind === "text" && plan.block.description !== undefined
      && (block.description == null ? "" : markdown(block.description)) !== plan.block.description) {
      throw new Error("Are.na description does not match the block plan");
    }
    if (plan.block.kind === "audio") {
      const attachment = block.attachment && typeof block.attachment === "object" ? block.attachment as Json : undefined;
      const contentType = string(attachment?.content_type);
      if (!contentType?.startsWith("audio/")) throw new Error("Are.na attachment does not retain an audio content type");
    }
    const soundCloudLink = plan.block.kind === "url" && plan.sources[0]?.provider === "soundcloud";
    if (soundCloudLink && type === "Embed" && !["auto", "none", "images"].includes(plan.policy.media)) throw new Error("Expected Link block for retained explicit audio intent");
    if ((plan.block.kind === "audio" || soundCloudLink) && plan.sources[0]?.provider === "soundcloud"
      && string(object(block.source)?.url) !== plan.block.canonicalSource) throw new Error("Are.na SoundCloud source does not match the block plan");
    if (plan.block.kind === "audio" && plan.sources[0]?.provider === "soundcloud") {
      const attachment = object(block.attachment);
      const mime = (value: string | undefined) => value?.split(";", 1)[0]?.trim().toLowerCase().replace("audio/x-wav", "audio/wav")
        .replace("audio/x-m4a", "audio/mp4").replace("audio/opus", "audio/ogg");
      const asset = plan.sources[0].media.find(item => item.ref === plan.block.selectedMedia[0]);
      if (!asset?.mimeType || mime(string(attachment?.content_type)) !== mime(asset.mimeType)) throw new Error("Are.na SoundCloud audio content type does not match the selected file");
      try {
        const url = new URL(string(attachment?.url) ?? "");
        if (url.protocol !== "https:" || url.username || url.password) throw new Error();
      } catch { throw new Error("Are.na SoundCloud audio has no public attachment URL"); }
    }
    if (plan.block.kind === "image") {
      if (!arenaImageUrl(block)) throw new Error("Are.na playlist Image has no copied artwork");
      if (string(object(block.source)?.url) !== plan.block.canonicalSource) {
        throw new Error("Are.na playlist Image source does not match the block plan");
      }
    }
  }

function object(value: unknown): Json | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined; }
export function arenaImageUrl(block: Json): string | undefined {
  const image = object(block.image) ?? object(object(block.attachment)?.image);
  return string(image?.src) ?? string(object(image?.large)?.url) ?? string(object(image?.original)?.url);
}
