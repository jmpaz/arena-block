import TurndownService from "turndown";
import { bindSubstackCaptures, substackSourceKey, type SubstackCapture, type SubstackNote } from "../substack-record.ts";
import { parseSource, type ParsedSource } from "../url.ts";
import type { ResolvedPost } from "../types.ts";
import type { SocialProvider } from "./provider.ts";

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
  if (!body.trim() && !note.links.length && !note.quote) throw new Error("Empty complete Substack Note");
  const quote = note.quote?.expanded;
  const links = note.links.map(link => {
    const label = `${link.role === "linked" ? "Linked" : link.role === "preview" ? "Preview of" : "Attachment; original not acquired:"} ${link.kind}`;
    return [`*[${label}](<${link.url}>)*`, link.title ? literal(link.title) : "",
      link.excerptHtml ? `*Selected article excerpt (not full article), by ${literal(link.excerptAuthor!)}:*\n\n${prose(link.excerptHtml, link.url).split("\n").map(line => `> ${line}`).join("\n")}` : ""].filter(Boolean).join("\n\n");
  });
  const text = [body, ...links, `*[Substack Note source](<${parseSource(note.url).canonicalUrl}>)${note.publishedLabel ? ` · ${literal(note.publishedLabel)}` : ""}*`].filter(Boolean).join("\n\n");
  return { provider: "substack", id: substackSourceKey(note.url), canonicalUrl: parseSource(note.url).canonicalUrl,
    author: { handle: note.author.handle, name: note.author.name }, text, postTitle: `Substack Note by @${note.author.handle}`, media: [],
    ...(quote?.body.status === "complete" ? { quote: notePost(quote) } : note.quote ? {
      quoteBoundary: { status: "unavailable", id: substackSourceKey(note.quote.url), canonicalUrl: parseSource(note.quote.url).canonicalUrl },
    } : {}),
  };
}
/** Import-only candidate. Never calls undocumented endpoints or reads browser credentials. */
export class SubstackProvider implements SocialProvider {
  private readonly captures: SubstackCapture[];
  constructor(captures: SubstackCapture[] = []) { this.captures = bindSubstackCaptures(captures.map(c => c.sourceUrl), captures); }
  async resolve(source: ParsedSource, signal?: AbortSignal): Promise<ResolvedPost> {
    signal?.throwIfAborted();
    if (source.provider !== "substack") throw new Error("Substack provider received another source");
    const capture = this.captures.find(c => substackSourceKey(c.sourceUrl) === source.id);
    if (!capture) throw new Error("Substack Notes require a browser-observed --substack-capture file; automatic acquisition is not available");
    if (capture.note.body.status !== "complete") throw new Error("Substack root Note is a preview or unavailable; full body capture is required");
    return { ...notePost(capture.note), substackCapture: capture };
  }
}
