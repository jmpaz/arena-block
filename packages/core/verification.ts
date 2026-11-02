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
    if (plan.block.kind === "url" && !["Link", "Embed"].includes(type ?? "")) throw new Error(`Expected Link or Embed block, received ${type}`);
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
