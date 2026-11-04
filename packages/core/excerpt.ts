import { createHash } from "node:crypto";
import { createDocument } from "@mixmark-io/domino";
import TurndownService from "turndown";
import { marked } from "marked";
import { composePlan, planHash } from "./compose.ts";
import { webSourceURL } from "./capture.ts";
import { excerptPlanInputSchema, excerptRecordSchema, literalExcerptMarkdown, type ExcerptRecord } from "./excerpt-schema.ts";
import { parseTextFragment, matchTextFragments } from "./text-fragment.ts";
import type { BlockPlan } from "./types.ts";
import type { z } from "zod";

export const MAX_EXCERPT_DOCUMENT_BYTES = 2 * 1024 * 1024;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const literalMarkdown = literalExcerptMarkdown;
const utf8Length = (text: string) => { let bytes = 0; for (const char of text) { const code = char.codePointAt(0)!; bytes += code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4; } return bytes; };
function plan(input: z.infer<typeof excerptPlanInputSchema>, record: ExcerptRecord, markdown: string, pageTitle?: string): BlockPlan {
  const title = input.title ?? `Excerpt from ${pageTitle || new URL(input.url).hostname}`.slice(0, 512);
  const composed = composePlan([{ provider: "web", id: `excerpt:${sha(input.url + "\0" + record.text)}`, canonicalUrl: webSourceURL(input.url),
    author: { handle: new URL(input.url).hostname }, text: record.text, postTitle: title, media: [] }], { media: "none" });
  const { hash, ...base } = composed;
  base.block = { kind: "text", title, markdown, canonicalSource: webSourceURL(input.sourceUrl ?? input.url), selectedMedia: [],
    ...(input.description !== undefined ? { description: input.description } : {}), excerpt: record };
  return { ...base, hash: planHash(base) };
}

/** Manual input is retained verbatim and never labelled as a verified page selection. */
export function manualExcerptPlan(input: z.input<typeof excerptPlanInputSchema>): BlockPlan {
  const value = excerptPlanInputSchema.parse(input);
  if (value.text === undefined) throw new Error("Supply the excerpt text");
  const record = excerptRecordSchema.parse({ kind: "manual", format: value.format ?? "markdown", text: value.text });
  return plan(value, record, record.format === "plain" ? literalMarkdown(record.text) : record.text);
}

type Run = { start: number; end: number; rawStarts: number[]; rawEnds: number[] };
const blockTags = new Set("ADDRESS ARTICLE ASIDE BLOCKQUOTE DD DIV DL DT FIGCAPTION FIGURE FOOTER H1 H2 H3 H4 H5 H6 HEADER HR LI MAIN NAV OL P PRE SECTION TABLE TD TH TR UL".split(" "));
const skippedTags = new Set("SCRIPT STYLE NOSCRIPT TEMPLATE HEAD IFRAME OBJECT SVG CANVAS INPUT SELECT BUTTON TEXTAREA".split(" "));
const keptTags = new Set("A B STRONG I EM S DEL CODE PRE BLOCKQUOTE UL OL LI P H1 H2 H3 H4 H5 H6 BR HR DIV SPAN SUP SUB".split(" "));

/** A deterministic DOM-text projection, not a claim about computed CSS or browser layout. */
function project(document: Document) {
  let text = "", nodes = 0;
  const runs = new Map<Node, Run>();
  const boundary = () => { if (text && !text.endsWith("\n\n")) text += text.endsWith("\n") ? "\n" : "\n\n"; };
  function visit(node: Node, pre = false, depth = 0) {
    if (++nodes > 100_000 || depth > 256) throw new Error("The source document is too complex for excerpt resolution");
    if (node.nodeType === 3) {
      const raw = node.nodeValue ?? "", start = text.length, rawStarts: number[] = [], rawEnds: number[] = [];
      let inWhitespace = false;
      for (let i = 0; i < raw.length; i++) {
        const space = !pre && /[\t\n\r\f ]/.test(raw[i]!);
        if (space && (inWhitespace || !text || /\s$/.test(text))) { if (inWhitespace && rawEnds.length) rawEnds[rawEnds.length - 1] = i + 1; inWhitespace = true; continue; }
        text += space ? " " : raw[i]!; rawStarts.push(i); rawEnds.push(i + 1); inWhitespace = space;
      }
      if (text.length > start) runs.set(node, { start, end: text.length, rawStarts, rawEnds });
      if (text.length > 1_000_000) throw new Error("The source text exceeds the excerpt resolution limit");
      return;
    }
    if (node.nodeType !== 1 && node.nodeType !== 9) return;
    const element = node as Element, tag = element.tagName;
    if (tag && (skippedTags.has(tag) || element.hasAttribute("hidden") || element.getAttribute("aria-hidden") === "true" ||
      /(?:display\s*:\s*none|visibility\s*:\s*hidden|content-visibility\s*:\s*hidden)/i.test(element.getAttribute("style") ?? ""))) return;
    if (tag === "BR") { const start = text.length; text += "\n"; runs.set(node, { start, end: text.length, rawStarts: [], rawEnds: [] }); return; }
    const block = blockTags.has(tag);
    if (block) boundary();
    for (const child of Array.from(node.childNodes)) visit(child, pre || tag === "PRE", depth + 1);
    if (block) boundary();
  }
  visit(document.body);
  return { text: text.trimEnd(), runs };
}

function selectedMarkdown(document: Document, runs: Map<Node, Run>, from: number, until: number, responseURL: string): string {
  function copy(node: Node): Node | undefined {
    if (node.nodeType === 3) {
      const run = runs.get(node);
      if (!run || from >= run.end || until <= run.start) return;
      const first = Math.max(from - run.start, 0), last = Math.min(until, run.end) - run.start - 1;
      return document.createTextNode((node.nodeValue ?? "").slice(run.rawStarts[first]!, run.rawEnds[last]!));
    }
    if (node.nodeType !== 1) return;
    const source = node as Element;
    if (skippedTags.has(source.tagName)) return;
    if (source.tagName === "BR") { const run = runs.get(node); return run && from < run.end && until > run.start ? document.createElement("br") : undefined; }
    const fragment = document.createElement(keptTags.has(source.tagName) ? source.tagName : blockTags.has(source.tagName) ? "div" : "span");
    const integer = (value: string | null) => value !== null && /^-?\d{1,9}$/.test(value) ? Number(value) : undefined;
    let ordinal = integer(source.getAttribute("start")) ?? 1, selectedOrdinal: number | undefined;
    for (const child of Array.from(node.childNodes)) {
      const listItem = source.tagName === "OL" && (child as Element).tagName === "LI";
      if (listItem) ordinal = integer((child as Element).getAttribute("value")) ?? ordinal;
      const selected = copy(child);
      if (selected) { if (listItem && selectedOrdinal === undefined) selectedOrdinal = ordinal; fragment.appendChild(selected); }
      if (listItem) ordinal++;
    }
    if (!fragment.childNodes.length) return;
    if (source.tagName === "A" && source.getAttribute("href")) {
      let href: string;
      try { href = webSourceURL(new URL(source.getAttribute("href") ?? "", responseURL).href); }
      catch { return fragment; }
      if (href.length > 8192) throw new Error("A selected citation URL exceeds the excerpt limit; supply the excerpt manually");
      fragment.setAttribute("href", href);
    }
    if (source.tagName === "OL" && selectedOrdinal !== undefined) fragment.setAttribute("start", String(selectedOrdinal));
    return fragment;
  }
  const root = document.createElement("div");
  for (const child of Array.from(document.body.childNodes)) { const selected = copy(child); if (selected) root.appendChild(selected); }
  return new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" }).turndown(root.innerHTML);
}

/** Resolve only against the supplied document. The method records its actual acquisition path. */
export function excerptPlanFromDocument(input: z.input<typeof excerptPlanInputSchema>, documentInput: {
  body: string; responseURL: string; contentType: "text/html" | "text/plain"; method?: "public-html" | "provided-html" | "public-text" | "provided-text";
}): BlockPlan {
  const value = excerptPlanInputSchema.parse(input);
  if (value.text !== undefined) throw new Error("Manual excerpt text must not be labelled as an automatic selection");
  if (utf8Length(documentInput.body) > MAX_EXCERPT_DOCUMENT_BYTES) throw new Error("The source document exceeds 2 MiB");
  const fragment = parseTextFragment(value.url);
  if (!fragment) throw new Error("This URL has no text-fragment selection");
  const responseURL = webSourceURL(documentInput.responseURL);
  const html = documentInput.contentType === "text/html";
  const document = html ? createDocument(documentInput.body) as unknown as Document : undefined;
  let documentBaseURL = responseURL;
  const base = document?.querySelector("base[href]")?.getAttribute("href");
  if (base) { try { documentBaseURL = webSourceURL(new URL(base, responseURL).href); } catch { /* Unsupported base URLs cannot create unsafe citations. */ } }
  const projection = document ? project(document) : { text: documentInput.body, runs: new Map<Node, Run>() };
  const ranges = matchTextFragments(projection.text, fragment.directives);
  const pageTitle = document?.title.replace(/\s+/g, " ").trim().slice(0, 512);
  const markdown = ranges.map(range => document ? selectedMarkdown(document, projection.runs, range.start, range.end, documentBaseURL) : literalMarkdown(range.text)).join("\n\n");
  if (utf8Length(markdown) > 512 * 1024) throw new Error("The formatted excerpt exceeds 512 KiB; supply a shorter excerpt manually");
  const normalize = (text: string) => text.replace(/\s+/gu, " ").trim();
  const retained = project(createDocument(marked.parse(markdown, { async: false })) as unknown as Document).text;
  if (normalize(retained) !== normalize(ranges.map(range => range.text).join("\n\n"))) throw new Error("The selected formatting could not retain the exact passage; supply the excerpt manually");
  const record = excerptRecordSchema.parse({ kind: "text-fragment", format: "markdown", selectionURL: fragment.url,
    documentURL: fragment.documentURL, responseURL, text: ranges.map(range => range.text).join("\n\n"),
    ...(pageTitle ? { documentTitle: pageTitle } : {}),
    ...(documentBaseURL !== responseURL ? { documentBaseURL } : {}),
    documentSHA256: sha(documentInput.body), documentTextSHA256: sha(projection.text), markdownSHA256: sha(markdown),
    method: documentInput.method ?? (html ? "provided-html" : "provided-text"), ranges });
  if (!markdown.trim()) throw new Error("The resolved selection could not be retained as excerpt content");
  return plan(value, record, markdown, pageTitle);
}
