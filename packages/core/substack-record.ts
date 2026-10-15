import { z } from "zod";
import { parseSource } from "./url.ts";
import { substackNoteAttachmentsSchema, type SubstackNoteAttachments } from "./substack-note-attachments.ts";

export const SUBSTACK_CAPTURE_MAX_BYTES = 2 * 1024 * 1024;
const httpsURL = z.url().refine(value => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password && !url.port && !/[\u0000-\u0020<>]/.test(value);
}, "Expected an HTTPS source URL without credentials or a custom port");
const authorSchema = z.object({ handle: z.string().regex(/^[a-zA-Z0-9_-]+$/), name: z.string().min(1).max(512), profileUrl: httpsURL }).strict();
const bodySchema = z.object({ status: z.enum(["complete", "preview", "unavailable"]), html: z.string().max(500_000) }).strict();
const attachmentSchema = z.object({ kind: z.enum(["image", "video"]), url: httpsURL, alt: z.string().max(20_000),
  width: z.number().int().positive().optional(), height: z.number().int().positive().optional(),
  posterUrl: httpsURL.optional(), durationSeconds: z.number().positive().optional(),
}).strict().refine(item => {
  const allowed = (url: string) => { const host = new URL(url).hostname; return host === "substackcdn.com" || host.endsWith(".substackcdn.com") || host === "substack-post-media.s3.amazonaws.com" || host === "substack-video.s3.amazonaws.com"; };
  return allowed(item.url) && (!item.posterUrl || allowed(item.posterUrl));
}, "Expected an observed original Substack media URL");
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
  acquisition?: { method: "public-html" | "browser-dom"; observedAt: string };
  publishedLabel?: string; postedAt?: string; links: z.infer<typeof linkSchema>[]; media?: z.infer<typeof attachmentSchema>[];
  attachmentEvidence?: SubstackNoteAttachments;
  quote?: { url: string; previewHtml?: string; expanded?: SubstackNote; status?: "unavailable" | "depth_limit" | "cycle" };
};
function noteSchema(depth: number): z.ZodType<SubstackNote> {
  return z.object({ acquisition: z.object({ method: z.enum(["public-html", "browser-dom"]), observedAt: z.iso.datetime() }).strict().optional(), url: httpsURL, author: authorSchema, body: bodySchema,
    publishedLabel: z.string().min(1).max(128).optional(), postedAt: z.iso.datetime().optional(), links: linkSchema.array().max(100), media: attachmentSchema.array().max(100).optional(),
    attachmentEvidence: substackNoteAttachmentsSchema.optional(),
    quote: z.object({ url: httpsURL, previewHtml: z.string().max(50_000).optional(),
      expanded: depth < 8 ? noteSchema(depth + 1).optional() : z.never().optional(), status: z.enum(["unavailable", "depth_limit", "cycle"]).optional(),
    }).strict().optional(),
  }).strict();
}
const envelope = z.object({
  schema: z.literal("arena-block/substack-browser-capture"), version: z.literal(1),
  sourceUrl: httpsURL, observedAt: z.iso.datetime(), method: z.enum(["browser-dom", "public-html"]), note: noteSchema(0),
}).strict();
export type SubstackCapture = z.infer<typeof envelope>;
export function substackSourceKey(value: string): string {
  const source = parseSource(value);
  if (source.provider !== "substack" || "kind" in source) throw new Error("Expected a Substack Note permalink");
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
  let bytes = 0;
  for (const character of json ?? "") { const point = character.codePointAt(0)!; bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4; }
  if (!json || bytes > SUBSTACK_CAPTURE_MAX_BYTES) throw new Error("Substack capture exceeds 2 MiB");
}
export const substackCaptureSchema = envelope.superRefine((capture, context) => {
  try {
    bounded(capture);
    if (substackSourceKey(capture.sourceUrl) !== substackSourceKey(capture.note.url)) throw new Error("Substack capture source identity mismatch");
    if (Date.parse(capture.observedAt) > Date.now() + 300_000) throw new Error("Substack observation time is in the future");
    const seen = new Set<string>();
    const visit = (note: SubstackNote) => {
      const source = parseSource(note.url), id = substackSourceKey(note.url);
      if (note.acquisition && Date.parse(note.acquisition.observedAt) > Date.now() + 300_000) throw new Error("Substack node observation time is in the future");
      if (note.attachmentEvidence && (String(note.attachmentEvidence.commentId) !== id || note.attachmentEvidence.handle.toLowerCase() !== note.author.handle.toLowerCase()
        || Date.parse(note.attachmentEvidence.observedAt) > Date.now() + 300_000)) throw new Error("Substack attachment evidence disagrees with its Note identity or observation time");
      if (seen.has(id)) throw new Error("Cyclic Substack quote identity");
      seen.add(id);
      const profile = new URL(note.author.profileUrl);
      if (profile.hostname !== "substack.com" || !/^\/(?:@[a-zA-Z0-9_]+|profile\/[1-9]\d*(?:-[a-zA-Z0-9_-]+)?)$/.test(profile.pathname) || profile.search || profile.hash) throw new Error("Expected a canonical Substack author profile");
      const actor = new URL(source.canonicalUrl).pathname.replace(/\/note\/c-\d+$/, "");
      if (actor && actor !== profile.pathname) throw new Error("Substack author and Note route disagree");
      if (profile.pathname.startsWith("/@") && profile.pathname.slice(2).toLowerCase() !== note.author.handle.toLowerCase()) throw new Error("Substack author handle and profile disagree");
      if (note.body.status === "complete" && !note.body.html.trim() && !note.links.length && !note.media?.length && !note.quote && !note.attachmentEvidence?.attachments.length) throw new Error("Empty complete Substack Note");
      if (note.quote) {
        const quoted = substackSourceKey(note.quote.url);
        if (seen.has(quoted) && note.quote.status !== "cycle") throw new Error("Cyclic Substack quote identity");
        if (note.quote.expanded && note.quote.status && note.quote.status !== "depth_limit") throw new Error("Expanded quote cannot also declare an unavailable boundary");
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

export const substackCapturesSchema = z.array(substackCaptureSchema).max(20).default([]).superRefine((captures, context) => {
  try { bindSubstackCaptures(captures.map(c => c.sourceUrl), captures); }
  catch (error) { context.addIssue({ code: "custom", message: String(error) }); }
});
export function requireRetainedSubstackCaptures(plan: { sources: { substackCapture?: SubstackCapture }[] }, captures: SubstackCapture[]): void {
  for (const capture of captures) {
    const expected = normalizeSubstackCapture(capture);
    const retained = plan.sources.find(source => source.substackCapture && substackSourceKey(source.substackCapture.sourceUrl) === substackSourceKey(expected.sourceUrl))?.substackCapture;
    const originalProjection = retained && JSON.parse(JSON.stringify(retained)) as SubstackCapture | undefined;
    const pruneHydration = (original: SubstackNote, result: SubstackNote) => {
      if (original.quote && result.quote) {
        if (!original.quote.expanded && original.quote.status === "depth_limit" && result.quote.expanded?.acquisition?.method === "public-html") delete result.quote.expanded;
        else if (original.quote.expanded && result.quote.expanded) pruneHydration(original.quote.expanded, result.quote.expanded);
      }
    };
    if (originalProjection) pruneHydration(expected.note, originalProjection.note);
    if (!originalProjection || JSON.stringify(originalProjection) !== JSON.stringify(expected)) throw new Error("The receiver did not retain the Substack source record. No save may continue with stripped provenance.");
  }
}
