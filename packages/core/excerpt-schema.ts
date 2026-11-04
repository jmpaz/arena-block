import { z } from "zod";
import { createHash } from "node:crypto";
import { parseTextFragment, textDirectiveSchema } from "./text-fragment.ts";
export const MAX_EXCERPT_TEXT = 50_000;
export const literalExcerptMarkdown = (text: string) => text.replace(/[\\`*_{}\[\]<>()#+.!|~=\-]/g, "\\$&");
export const excerptMarkdownHash = (text: string) => createHash("sha256").update(text).digest("hex");
const text = z.string().min(1).max(MAX_EXCERPT_TEXT).refine(value => value.trim().length > 0 && !value.includes("\0"), "Enter nonempty excerpt text without NUL characters");
const webURL = z.url().max(8192).refine(value => { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password; });
export const excerptRecordSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("manual"), format: z.enum(["plain", "markdown"]), text }).strict(),
  z.object({ kind: z.literal("text-fragment"), format: z.literal("markdown"), text,
    selectionURL: webURL, documentURL: webURL, responseURL: webURL,
    documentTitle: z.string().min(1).max(512).optional(),
    documentBaseURL: webURL.optional(),
    documentSHA256: z.string().regex(/^[a-f0-9]{64}$/), documentTextSHA256: z.string().regex(/^[a-f0-9]{64}$/),
    markdownSHA256: z.string().regex(/^[a-f0-9]{64}$/),
    method: z.enum(["public-html", "provided-html", "public-text", "provided-text"]),
    ranges: z.array(z.object({ start: z.number().int().nonnegative(), end: z.number().int().positive(), text, directive: textDirectiveSchema }).strict()
      .refine(range => range.end - range.start === range.text.length, "Selection offsets must match exact UTF-16 text")).min(1).max(8),
  }).strict(),
]).superRefine((record, context) => {
  if (record.kind !== "text-fragment") return;
  let parsed;
  try { parsed = parseTextFragment(record.selectionURL); } catch { /* Invalid provenance is a schema issue, not an exception from safeParse. */ }
  if (!parsed || parsed.documentURL !== record.documentURL || JSON.stringify(parsed.directives) !== JSON.stringify(record.ranges.map(range => range.directive)))
    context.addIssue({ code: "custom", message: "Selection provenance must retain the original text directives" });
  if (record.text !== record.ranges.map(range => range.text).join("\n\n")) context.addIssue({ code: "custom", message: "Excerpt text must retain every exact selection in directive order" });
});
export type ExcerptRecord = z.infer<typeof excerptRecordSchema>;
export const excerptPlanInputSchema = z.object({
  url: webURL, sourceUrl: webURL.optional(), title: z.string().trim().min(1).max(512).optional(),
  description: z.string().max(20_000).optional(), text: text.optional(), format: z.enum(["plain", "markdown"]).optional(),
}).strict().refine(value => value.format === undefined || value.text !== undefined, "An excerpt format requires manual text");
