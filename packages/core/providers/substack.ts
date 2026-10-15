/// <reference path="../polyfills.d.ts" />
import TurndownService from "turndown";
import { createDocument } from "@mixmark-io/domino";
import { bindSubstackCaptures, normalizeSubstackCapture, substackSourceKey, type SubstackCapture, type SubstackNote } from "../substack-record.ts";
import { readSubstackPage } from "../substack-page.ts";
import { renderedQuoteDepth } from "../quote-policy.ts";
import { compositionPolicySchema } from "../types.ts";
import { parseSource, type ParsedSource } from "../url.ts";
import type { ResolvedPost } from "../types.ts";
import type { SocialProvider, SourceResolutionPolicy } from "./provider.ts";
import { resolveSubstackArticle } from "./substack-article.ts";
import { discoverSubstackThread } from "./substack-thread.ts";
import { substackNoteVideo } from "../substack-note-attachments.ts";

function converter(base: string): TurndownService {
  const markdown = new TurndownService({ headingStyle: "atx", bulletListMarker: "-", codeBlockStyle: "fenced" });
  markdown.remove(["script", "style"]);
  // Imported HTML is data. Never execute it or turn arbitrary URLs into acquired media.
  markdown.addRule("safe-link", { filter: "a", replacement(content, node) {
    const raw = (node as HTMLElement).getAttribute("href") ?? "";
    try {
      const url = new URL(raw, base);
      if (url.protocol === "https:" && !url.username && !url.password && !url.port && !/[\u0000-\u0020<>]/.test(raw)) return `[${content}](<${url.href}>)`;
    } catch { /* Keep the visible label only. */ }
    return content;
  } });
  markdown.addRule("unacquired-image", { filter: "img", replacement: () => { throw new Error("Put Substack media in explicit attachment records before capture"); } });
  return markdown;
}

function prose(html: string, base: string): string {
  if (/<\s*(?:img|picture|video|audio|iframe|object|embed)\b/i.test(html)) throw new Error("Put Substack media in explicit attachment records before capture");
  return converter(base).turndown(html);
}
function literal(text: string): string {
  return converter("https://substack.com").turndown(`<p>${text.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</p>`);
}
function notePost(note: SubstackNote): ResolvedPost {
  const body = prose(note.body.html, note.url);
  if (!body.trim() && !note.links.length && !note.media?.length && !note.quote && !note.attachmentEvidence?.attachments.length) throw new Error("Empty complete Substack Note");
  const quote = note.quote?.expanded;
  const links = note.links.map(link => {
    const label = `${link.role === "linked" ? "Linked" : link.role === "preview" ? "Preview of" : "Attachment; original not acquired:"} ${link.kind}`;
    return [`*[${label}](<${link.url}>)*`, link.title ? literal(link.title) : "",
      link.excerptHtml ? `*Selected article excerpt (not full article), by ${literal(link.excerptAuthor!)}:*\n\n${prose(link.excerptHtml, link.url).split("\n").map(line => `> ${line}`).join("\n")}` : ""].filter(Boolean).join("\n\n");
  });
  const articles = note.attachmentEvidence?.attachments.filter(a=>a.kind==="article").map(a=>{
    const authors=a.authors.map(author=>literal(author.name)).join(", ");
    return [`*[Article card (preview; full article not acquired)](<${a.url}>)*`,`${literal(a.title)} — ${authors}`,
      a.selection?`*${a.selection.isAutoSelection ? "Automatic article preview" : "Selected article excerpt (not full article)"}, by ${authors}:*\n\n${literal(a.selection.text).split("\n").map(line=>`> ${line}`).join("\n")}`:a.previewText?`*Article preview:* ${literal(a.previewText)}`:""].filter(Boolean).join("\n\n");
  })??[];
  const native = note.attachmentEvidence?.attachments.filter(a=>a.kind==="video").map(a=>({...substackNoteVideo(a),ref:"0.0",alt:"",sourceRole:"original" as const}))??[];
  const text = [body, ...links, ...articles, `*[Substack Note source](<${parseSource(note.url).canonicalUrl}>)${note.publishedLabel ? ` · ${literal(note.publishedLabel)}` : ""}*`].filter(Boolean).join("\n\n");
  return { provider: "substack", id: substackSourceKey(note.url), canonicalUrl: parseSource(note.url).canonicalUrl,
    author: { handle: note.author.handle, name: note.author.name }, text, postTitle: `Substack Note by @${note.author.handle}`,
    ...(note.postedAt ? { postedAt: note.postedAt } : {}), media: [...(note.media ?? []).map(item => ({ ...item, ref: "0.0", sourceRole: "original" as const })),...native],
    ...(quote?.body.status === "complete" ? { quote: notePost(quote) } : note.quote ? {
      quoteBoundary: { status: note.quote.status ?? "unavailable", id: substackSourceKey(note.quote.url), canonicalUrl: parseSource(note.quote.url).canonicalUrl },
    } : {}),
  };
}
/** Credentialless public HTML acquisition, or an explicitly supplied bounded browser record. */
export class SubstackProvider implements SocialProvider {
  private readonly captures: SubstackCapture[];
  constructor(captures: SubstackCapture[] = [], private readonly fetcher: typeof fetch = fetch) { this.captures = bindSubstackCaptures(captures.map(c => c.sourceUrl), captures); }
  async discoverLinear(source: ParsedSource, signal?: AbortSignal, policy?: Partial<SourceResolutionPolicy>) {
    if (source.provider !== "substack" || "kind" in source) throw new Error("Substack author chains require a Note permalink");
    return discoverSubstackThread(source.id, (url, bounded) => this.resolve(parseSource(url), bounded, policy), this.fetcher, signal);
  }
  async resolve(source: ParsedSource, signal?: AbortSignal, policy?: Partial<SourceResolutionPolicy>): Promise<ResolvedPost> {
    if (signal?.aborted) throw signal.reason ?? new Error("Substack acquisition cancelled");
    if (source.provider !== "substack") throw new Error("Substack provider received another source");
    if ("kind" in source && source.kind === "article") return resolveSubstackArticle(source, this.fetcher, signal);
    let capture = this.captures.find(c => substackSourceKey(c.sourceUrl) === source.id);
    const depth = renderedQuoteDepth(compositionPolicySchema.parse(policy ?? {}));
    if (!capture) {
      const bounded = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(20_000)]);
      capture = normalizeSubstackCapture(await readSubstackPage(source.canonicalUrl, { url: source.canonicalUrl,
        parseHTML: createDocument, fetcher: this.fetcher, method: "public-html", maxDepth: depth, signal: bounded }));
    }
    if (capture.note.body.status !== "complete") throw new Error("Substack root Note is a preview or unavailable; full body capture is required");
    // A retained shallow record can hydrate only its missing public descendants.
    // Keep the outer authored body, preview and its original observation untouched.
    capture = JSON.parse(JSON.stringify(capture)) as SubstackCapture;
    const expand = async (note: SubstackNote, remaining: number, ancestors: Set<string>): Promise<void> => {
      const reference = note.quote;
      if (!reference || remaining <= 0) return;
      const id = substackSourceKey(reference.url);
      if (ancestors.has(id)) { delete reference.expanded; reference.status = "cycle"; return; }
      if (!reference.expanded && reference.status === "depth_limit") {
        const resolved = await new SubstackProvider([], this.fetcher).resolve(parseSource(reference.url), signal, { quoteDepth: remaining - 1 });
        reference.expanded = resolved.substackCapture!.note;
      }
      if (reference.expanded) await expand(reference.expanded, remaining - 1, new Set([...ancestors, id]));
    };
    await expand(capture.note, depth, new Set([substackSourceKey(capture.sourceUrl)]));
    capture = normalizeSubstackCapture(capture);
    const post = notePost(capture.note);
    let node = post, actualDepth = 0; const sourceIds = [post.id];
    while (node.quote) { actualDepth++; node = node.quote; sourceIds.push(node.id); }
    return { ...post, substackCapture: capture, quoteCoverage: { maxDepth: 8, actualDepth, maxReached: actualDepth >= 8,
      truncated: !!node.quoteBoundary, stopped: node.quoteBoundary?.status ?? "end", sourceIds,
      acquisitionDepth: depth, mayExpand: node.quoteBoundary?.status === "depth_limit" } };
  }
}
