import { excerptPlanInputSchema } from "../packages/core/excerpt-schema.ts";
import { excerptPlanFromDocument, manualExcerptPlan, MAX_EXCERPT_DOCUMENT_BYTES } from "../packages/core/excerpt.ts";
import { parseTextFragment } from "../packages/core/text-fragment.ts";
import { requestPublicWeb } from "./web-link.ts";
import { abortable, deadline } from "./bounded-io.ts";
import type { BlockPlan } from "./types.ts";
import type { z } from "zod";
export { excerptPlanInputSchema, manualExcerptPlan, excerptPlanFromDocument, parseTextFragment };

/** Manual text needs no page fetch. Automatic selections require a complete bounded public document. */
export async function resolveExcerptPlan(input: z.input<typeof excerptPlanInputSchema>, options: { signal?: AbortSignal; fetcher?: (url: string, init?: RequestInit) => Promise<Response> } = {}): Promise<BlockPlan> {
  const value = excerptPlanInputSchema.parse(input);
  options.signal?.throwIfAborted();
  if (value.text !== undefined) return manualExcerptPlan(value);
  const fragment = parseTextFragment(value.url);
  if (!fragment) throw new Error("Supply a highlight URL or the excerpt text");
  const signal = deadline(20_000, options.signal);
  const { response, url } = await requestPublicWeb(fragment.documentURL, "GET", options.fetcher ?? fetch, signal);
  if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new Error(`The excerpt source returned HTTP ${response.status}. No selection was resolved. Open the page in its browser and supply the excerpt text manually`); }
  const type = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (type !== "text/html" && type !== "text/plain") { void response.body?.cancel().catch(() => {}); throw new Error("Automatic excerpt resolution requires an HTML or plain-text page; supply the excerpt manually for this source"); }
  const charset = /charset\s*=\s*["']?([^;\s"']+)/i.exec(response.headers.get("content-type") ?? "")?.[1];
  if (charset && !["utf-8", "utf8", "us-ascii"].includes(charset.toLowerCase())) { void response.body?.cancel().catch(() => {}); throw new Error("This page's character encoding is not supported for exact excerpt resolution"); }
  if (Number(response.headers.get("content-length") ?? 0) > MAX_EXCERPT_DOCUMENT_BYTES) { void response.body?.cancel().catch(() => {}); throw new Error("The source document exceeds 2 MiB; enter the excerpt manually"); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("The excerpt source returned no document body");
  let size = 0, body = ""; const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    while (true) {
      const part = await abortable(reader.read(), signal);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_EXCERPT_DOCUMENT_BYTES) throw new Error("The source document exceeds 2 MiB; enter the excerpt manually");
      body += decoder.decode(part.value, { stream: true });
    }
    body += decoder.decode();
  } finally { void reader.cancel().catch(() => {}); }
  signal.throwIfAborted();
  return excerptPlanFromDocument(value, { body, responseURL: url, contentType: type, method: type === "text/html" ? "public-html" : "public-text" });
}
