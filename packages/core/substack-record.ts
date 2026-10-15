import { z } from "zod";
import { parseSource } from "./url.ts";

export const SUBSTACK_CAPTURE_MAX_BYTES = 2 * 1024 * 1024;
const httpsURL = z.url().refine(value => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password && !url.port && !/[\u0000-\u0020<>]/.test(value);
}, "Expected an HTTPS source URL without credentials or a custom port");
const authorSchema = z.object({ handle: z.string().regex(/^[a-zA-Z0-9_-]+$/), name: z.string().min(1).max(512), profileUrl: httpsURL }).strict();
const bodySchema = z.object({ status: z.enum(["complete", "preview", "unavailable"]), html: z.string().max(500_000) }).strict();
const linkSchema = z.object({
  kind: z.enum(["link", "article", "image", "video", "audio"]),
  role: z.enum(["linked", "preview", "attachment"]), url: httpsURL,
  title: z.string().max(1000).optional(),
  excerptAuthor: z.string().min(1).max(512).optional(),
  // An intentional selected article quote is an excerpt, never an article body.
  excerptHtml: z.string().max(50_000).optional(),
}).strict().refine(link => !link.excerptHtml || (link.kind === "article" && !!link.excerptAuthor), "An article excerpt requires its own author");
export type SubstackNote = {
  url: string; author: z.infer<typeof authorSchema>; body: z.infer<typeof bodySchema>;
  publishedLabel?: string; links: z.infer<typeof linkSchema>[];
  quote?: { url: string; previewHtml?: string; expanded?: SubstackNote };
};
function noteSchema(depth: number): z.ZodType<SubstackNote> {
  return z.object({ url: httpsURL, author: authorSchema, body: bodySchema,
    publishedLabel: z.string().min(1).max(128).optional(), links: linkSchema.array().max(100),
    quote: z.object({ url: httpsURL, previewHtml: z.string().max(50_000).optional(),
      expanded: depth < 8 ? noteSchema(depth + 1).optional() : z.never().optional(),
    }).strict().optional(),
  }).strict();
}
const envelope = z.object({
  schema: z.literal("arena-block/substack-browser-capture"), version: z.literal(1),
  sourceUrl: httpsURL, observedAt: z.iso.datetime(), method: z.literal("browser-dom"), note: noteSchema(0),
}).strict();
export type SubstackCapture = z.infer<typeof envelope>;
export function substackSourceKey(value: string): string {
  const source = parseSource(value);
  if (source.provider !== "substack") throw new Error("Expected a Substack Note permalink");
  return source.id;
}
function bounded(value: unknown) {
  let nodes = 0;
  const walk = (item: unknown, depth: number) => {
    if (++nodes > 20_000 || depth > 40) throw new Error("Substack capture exceeds record bounds");
    if (item && typeof item === "object") for (const child of Object.values(item)) walk(child, depth + 1);
  };
  walk(value, 0);
  const json = JSON.stringify(value);
  if (!json || new TextEncoder().encode(json).length > SUBSTACK_CAPTURE_MAX_BYTES) throw new Error("Substack capture exceeds 2 MiB");
}
export const substackCaptureSchema = envelope.superRefine((capture, context) => {
  try {
    bounded(capture);
    if (substackSourceKey(capture.sourceUrl) !== substackSourceKey(capture.note.url)) throw new Error("Substack capture source identity mismatch");
    if (Date.parse(capture.observedAt) > Date.now() + 300_000) throw new Error("Substack observation time is in the future");
    const seen = new Set<string>();
    const visit = (note: SubstackNote) => {
      const source = parseSource(note.url), id = substackSourceKey(note.url);
      if (seen.has(id)) throw new Error("Cyclic Substack quote identity");
      seen.add(id);
      const profile = new URL(note.author.profileUrl);
      if (profile.hostname !== "substack.com" || !/^\/(?:@[a-zA-Z0-9_]+|profile\/[1-9]\d*(?:-[a-zA-Z0-9_-]+)?)$/.test(profile.pathname) || profile.search || profile.hash) throw new Error("Expected a canonical Substack author profile");
      const actor = new URL(source.canonicalUrl).pathname.replace(/\/note\/c-\d+$/, "");
      if (actor && actor !== profile.pathname) throw new Error("Substack author and Note route disagree");
      if (profile.pathname.startsWith("/@") && profile.pathname.slice(2).toLowerCase() !== note.author.handle.toLowerCase()) throw new Error("Substack author handle and profile disagree");
      if (note.body.status === "complete" && !note.body.html.trim() && !note.links.length && !note.quote) throw new Error("Empty complete Substack Note");
      if (note.quote) {
        const quoted = substackSourceKey(note.quote.url);
        if (seen.has(quoted)) throw new Error("Cyclic Substack quote identity");
        if (note.quote.expanded) {
          if (quoted !== substackSourceKey(note.quote.expanded.url)) throw new Error("Expanded Substack quote identity mismatch");
          visit(note.quote.expanded);
        }
      }
    };
    visit(capture.note);
  } catch (error) { context.addIssue({ code: "custom", message: String(error) }); }
});
export function normalizeSubstackCapture(value: unknown): SubstackCapture {
  bounded(value);
  const capture = substackCaptureSchema.parse(value);
  return { ...capture, sourceUrl: parseSource(capture.sourceUrl).canonicalUrl };
}
export function bindSubstackCaptures(refs: string[], captures: SubstackCapture[]): SubstackCapture[] {
  const normalized = captures.map(normalizeSubstackCapture);
  bounded(normalized);
  if (normalized.length > 20) throw new Error("At most 20 Substack captures are supported");
  const keys = normalized.map(c => substackSourceKey(c.sourceUrl));
  if (new Set(keys).size !== keys.length) throw new Error("Duplicate Substack captures");
  const selected = new Set(refs.flatMap(ref => { try { return [substackSourceKey(ref)]; } catch { return []; } }));
  if (keys.some(key => !selected.has(key))) throw new Error("Substack capture does not match a selected source");
  return normalized;
}
