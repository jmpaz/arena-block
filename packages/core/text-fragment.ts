import { z } from "zod";

export const textDirectiveSchema = z.object({
  start: z.string().min(1).max(8192), end: z.string().min(1).max(8192).optional(),
  prefix: z.string().min(1).max(8192).optional(), suffix: z.string().min(1).max(8192).optional(),
}).strict();
export type TextDirective = z.infer<typeof textDirectiveSchema>;
export type TextFragment = { url: string; documentURL: string; directives: TextDirective[] };

/** Split structural delimiters before percent decoding; '+' is a literal plus. */
export function parseTextFragment(value: string): TextFragment | undefined {
  const url = new URL(value);
  const at = url.hash.indexOf(":~:");
  if (at < 0) return;
  const raw = url.hash.slice(at + 3).split("&").filter(value => value.startsWith("text="));
  if (!raw.length) return;
  if (value.length > 8192) throw new Error("The highlight URL exceeds 8192 characters");
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Use a web source URL without embedded credentials");
  if (raw.length > 8) throw new Error("At most eight text selections are supported");
  const directives = raw.map(value => {
    const parts = value.slice(5).split(",");
    const result: Record<string, string> = {};
    const invalid = () => new Error("Invalid text-fragment directive; copy the highlight link again or supply the excerpt text");
    if (parts.length > 4) throw invalid();
    if (parts[0]?.endsWith("-")) result.prefix = parts.shift()!.slice(0, -1);
    if (parts.at(-1)?.startsWith("-")) result.suffix = parts.pop()!.slice(1);
    if (parts.length < 1 || parts.length > 2) throw invalid();
    result.start = parts[0]!;
    if (parts.length === 2) result.end = parts[1]!;
    for (const key of Object.keys(result)) {
      const term = result[key]!;
      if (!term || term.includes("-") || /%(?![\da-f]{2})/i.test(term)) throw invalid();
      try { result[key] = decodeURIComponent(term); } catch { throw invalid(); }
    }
    return textDirectiveSchema.parse(result);
  });
  const documentURL = new URL(url); documentURL.hash = url.hash.slice(1, at);
  return { url: url.href, documentURL: documentURL.href, directives };
}

export type TextMatch = { start: number; end: number; text: string; directive: TextDirective };
function folded(value: string): { text: string; starts: number[]; ends: number[] } {
  let text = "", offset = 0; const starts: number[] = [], ends: number[] = [];
  for (const char of value) {
    const end = offset + char.length;
    const normalized = char.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/ς/g, "σ");
    if (!normalized && ends.length) ends[ends.length - 1] = end;
    for (const unit of normalized) {
      const part = /\s/u.test(unit) ? " " : unit;
      if (part === " " && text.endsWith(" ")) { ends[ends.length - 1] = end; continue; }
      text += part;
      for (let n = 0; n < part.length; n++) { starts.push(offset); ends.push(end); }
    }
    offset = end;
  }
  return { text, starts, ends };
}
function wordBoundaries(text: string): Set<number> | undefined {
  if (typeof Intl === "undefined" || typeof Intl.Segmenter !== "function") return;
  const positions = new Set<number>([0, text.length]);
  for (const segment of new Intl.Segmenter(undefined, { granularity: "word" }).segment(text)) positions.add(segment.index);
  return positions;
}
function bounded(text: string, start: number, end: number, boundaries?: Set<number>): boolean {
  if (boundaries) return boundaries.has(start) && boundaries.has(end);
  const word = (s: string) => /[\p{L}\p{N}\p{M}_]/u.test(s);
  return !(word(text[start] ?? "") && word(text[start - 1] ?? "")) &&
    !(word(text[end - 1] ?? "") && word(text[end] ?? ""));
}
function occurrences(text: string, query: string, boundaries?: Set<number>): number[] {
  if (!query.trim()) throw new Error("A text-fragment term must contain visible text");
  const result: number[] = [];
  for (let at = text.indexOf(query); at >= 0; at = text.indexOf(query, at + 1)) {
    if (bounded(text, at, at + query.length, boundaries)) result.push(at);
    if (result.length > 256) throw new Error("The text selection is too ambiguous; include more context or enter the excerpt manually");
  }
  return result;
}

/** Conservative unique matching against one retained document-text projection.
 * This does not claim to reproduce browser layout, CSS or dynamic DOM behavior. */
export function matchTextFragments(document: string, directives: TextDirective[]): TextMatch[] {
  if (document.length > 1_000_000) throw new Error("The source text exceeds the excerpt resolution limit");
  const source = folded(document);
  const boundaries = wordBoundaries(source.text);
  const matches = directives.map(directive => {
    const start = folded(directive.start).text, end = directive.end ? folded(directive.end).text : undefined;
    const prefix = directive.prefix ? folded(directive.prefix).text : undefined;
    const suffix = directive.suffix ? folded(directive.suffix).text : undefined;
    const ends = end ? occurrences(source.text, end, boundaries) : [];
    const candidates: Array<[number, number]> = [];
    for (const at of occurrences(source.text, start, boundaries)) {
      if (prefix) {
        const before = source.text.slice(0, at).trimEnd();
        if (!before.endsWith(prefix) || !bounded(source.text, before.length - prefix.length, before.length, boundaries)) continue;
      }
      for (const until of end ? ends.filter(index => index >= at + start.length).map(index => index + end.length) : [at + start.length]) {
        if (suffix) {
          const after = source.text.slice(until).trimStart(), from = source.text.length - after.length;
          if (!after.startsWith(suffix) || !bounded(source.text, from, from + suffix.length, boundaries)) continue;
        }
        candidates.push([at, until]);
        if (candidates.length > 1) break;
      }
      if (candidates.length > 1) break;
    }
    if (!candidates.length) throw new Error("The highlighted passage could not be matched in the available page. It may have changed; enter the exact excerpt manually or copy a new highlight link");
    if (candidates.length !== 1) throw new Error("The highlighted passage is ambiguous. Copy a highlight link with more context or enter the excerpt manually");
    const [from, until] = candidates[0]!;
    const first = source.starts[from]!, last = source.ends[until - 1]!;
    return { start: first, end: last, text: document.slice(first, last), directive };
  });
  for (let i = 0; i < matches.length; i++) for (let j = i + 1; j < matches.length; j++)
    if (matches[i]!.start < matches[j]!.end && matches[j]!.start < matches[i]!.end) throw new Error("Overlapping text selections require review; enter the excerpt manually");
  return matches;
}
