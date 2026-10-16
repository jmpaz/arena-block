/// <reference path="../polyfills.d.ts" />
import TurndownService from "turndown";
import { createHash } from "node:crypto";
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
import { substackNoteVideo, substackNotePodcastAudio } from "../substack-note-attachments.ts";

function converter(base: string): TurndownService {
  const markdown = new TurndownService({ headingStyle: "atx", bulletListMarker: "-", codeBlockStyle: "fenced" });
  markdown.remove(["script", "style"]);
  // Imported HTML is data. Never execute it or turn arbitrary URLs into acquired media.
  markdown.addRule("safe-link", { filter: "a", replacement(content, node) {
    const raw = (node as HTMLElement).getAttribute("href") ?? "";
    try {
      const url = new URL(raw, base);
      if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password && !url.port && !/[\u0000-\u0020<>]/.test(raw)) return `[${content}](<${url.href}>)`;
    } catch { /* Keep the visible label only. */ }
    return content;
  } });
  markdown.addRule("unacquired-image", { filter: "img", replacement: () => { throw new Error("This Note includes media Capture cannot read."); } });
  return markdown;
}

function prose(html: string, base: string): string {
  if (/<\s*(?:img|picture|video|audio|iframe|object|embed)\b/i.test(html)) throw new Error("This Note includes media Capture cannot read.");
  return converter(base).turndown(html);
}
function literal(text: string): string {
  return converter("https://substack.com").turndown(`<p>${text.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</p>`);
}
function notePost(note: SubstackNote): ResolvedPost {
  const body = prose(note.body.html, note.url);
  if (!body.trim() && !note.links.length && !note.media?.length && !note.quote && !note.attachmentEvidence?.attachments.length) throw new Error("Empty complete Substack Note");
  const quote = note.quote?.expanded;
  const document = createDocument(note.body.html);
  const bodyReferences = new Set<string>();
  for (const anchor of Array.from(document.querySelectorAll("a[href]"))) {
    try { bodyReferences.add(new URL(anchor.getAttribute("href")!, note.url).href); } catch { /* Invalid source links remain visible text. */ }
  }
  const collectTextReferences = (node: Node): void => {
    if (["A", "CODE", "PRE", "SCRIPT", "STYLE"].includes(node.nodeName)) return;
    if (node.nodeType === 3) {
      for (const token of (node.nodeValue ?? "").split(/\s+/)) bodyReferences.add(token);
    } else {
      for (const child of Array.from(node.childNodes)) collectTextReferences(child);
    }
  };
  collectTextReferences(document.body);
  const links = note.links.map(link => {
    const reference = link.title ? `[${literal(link.title)}](<${link.url}>)` : `<${link.url}>`;
    if (link.previewText) return `*Preview of ${reference}:*\n\n${literal(link.previewText).split("\n").map(line => line ? `> ${line}` : ">").join("\n")}`;
    if (link.excerptHtml) return `*Excerpt from ${reference}, by ${literal(link.excerptAuthor!)}:*\n\n${prose(link.excerptHtml, link.url).split("\n").map(line => line ? `> ${line}` : ">").join("\n")}`;
    return !link.title && bodyReferences.has(link.url) ? "" : reference;
  });
  const articles = note.attachmentEvidence?.attachments.filter(a=>a.kind==="article").map(a=>{
    const authors=a.authors.map(author=>literal(author.name)).join(", ");
    const reference = `[${literal(a.title)}](<${a.url}>)`;
    const excerpt = a.selection?.text ?? a.previewText;
    if (!excerpt) return `${reference}, by ${authors}`;
    const scope = a.selection && !a.selection.isAutoSelection ? "Excerpt from" : "Preview of";
    return `*${scope} ${reference}, by ${authors}:*\n\n${literal(excerpt).split("\n").map(line => line ? `> ${line}` : ">").join("\n")}`;
  })??[];
  const native = note.attachmentEvidence?.attachments.flatMap(a=>{
    const media=a.kind==="video"?substackNoteVideo(a):substackNotePodcastAudio(a);
    return media?[{...media,ref:"0.0",alt:"",sourceRole:"original" as const}]:[];
  })??[];
  const text = [body, ...links, ...articles].filter(Boolean).join("\n\n");
  return { provider: "substack", id: substackSourceKey(note.url), canonicalUrl: parseSource(note.url).canonicalUrl,
    author: { handle: note.author.handle, name: note.author.name }, text, postTitle: `Note by @${note.author.handle}`,
    ...(note.postedAt ? { postedAt: note.postedAt } : {}), media: [...(note.media ?? []).map(item => ({ ...item, ref: "0.0", sourceRole: "original" as const })),...native],
    ...(quote?.body.status === "complete" ? { quote: notePost(quote) } : note.quote ? {
      quoteBoundary: { status: note.quote.status ?? "unavailable", id: substackSourceKey(note.quote.url), canonicalUrl: parseSource(note.quote.url).canonicalUrl },
    } : {}),
  };
}
/** Credentialless public HTML acquisition, or an explicitly supplied bounded browser record. */
type PodcastReadContext={articles:Map<string,Promise<ResolvedPost>>;signal:AbortSignal};
export class SubstackProvider implements SocialProvider {
  private readonly captures: SubstackCapture[];
  constructor(captures: SubstackCapture[] = [], private readonly fetcher: typeof fetch = fetch, private readonly podcastContext?:PodcastReadContext) { this.captures = bindSubstackCaptures(captures.map(c => c.sourceUrl), captures); }
  async discoverLinear(source: ParsedSource, signal?: AbortSignal, policy?: Partial<SourceResolutionPolicy>) {
    if (source.provider !== "substack" || "kind" in source) throw new Error("Substack author chains require a Note permalink");
    return discoverSubstackThread(source.id, (url, bounded) => this.resolve(parseSource(url), bounded, policy), this.fetcher, signal);
  }
  async resolve(source: ParsedSource, signal?: AbortSignal, policy?: Partial<SourceResolutionPolicy>): Promise<ResolvedPost> {
    if (signal?.aborted) throw signal.reason ?? new Error("Substack acquisition cancelled");
    if (source.provider !== "substack") throw new Error("Substack provider received another source");
    if ("kind" in source && source.kind === "article") return resolveSubstackArticle(source, this.fetcher, signal);
    const podcastContext=this.podcastContext??{articles:new Map<string,Promise<ResolvedPost>>(),signal:AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(60_000)])};
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
        const resolved = await new SubstackProvider([], this.fetcher,podcastContext).resolve(parseSource(reference.url), signal, { quoteDepth: remaining - 1 });
        reference.expanded = resolved.substackCapture!.note;
      }
      if (reference.expanded) await expand(reference.expanded, remaining - 1, new Set([...ancestors, id]));
    };
    await expand(capture.note, depth, new Set([substackSourceKey(capture.sourceUrl)]));
    // Hydrate only newly observed podcast cards. Legacy captures lacking this
    // evidence keep their original card-only projection and queued selections.
    const {articles,signal:podcastSignal}=podcastContext;
    const articleURLs=new Set<string>();
    for(let node:SubstackNote|undefined=capture.note;node;node=node.quote?.expanded)for(const a of node.attachmentEvidence?.attachments??[])
      if(a.kind==="article"&&a.podcast)articleURLs.add(a.url);
    if(articleURLs.size>8)throw new Error("Substack Note exceeds the eight podcast article bound");
    const hydrateAudio=async(note:SubstackNote):Promise<void>=>{
      for(const a of note.attachmentEvidence?.attachments??[]){
        if(a.kind!=="article"||!a.podcast||a.podcast.article)continue;
        let read=articles.get(a.url);
        if(!read){
          if(articles.size>=8)throw new Error("Substack Note exceeds the eight podcast article bound");
          const parsed=parseSource(a.url);
          if(parsed.provider!=="substack"||!("kind"in parsed)||parsed.kind!=="article")throw new Error("Substack podcast card has no canonical article source");
          read=resolveSubstackArticle(parsed,this.fetcher,podcastSignal);articles.set(a.url,read);
        }
        const resolved=await read;
        if(!resolved.substackArticle)throw new Error("Substack podcast card has no complete freely public article");
        const record=resolved.substackArticle,audio=record.nativeMedia?.find(item=>item.kind==="audio"&&item.uploadId===a.podcast!.uploadId);
        if(!audio)throw new Error("Substack podcast card does not match its article's original audio");
        let bodyBytes=0;
        for(const character of record.bodyHtml){const point=character.codePointAt(0)!;bodyBytes+=point<128?1:point<2048?2:point<65536?3:4;}
        a.podcast.article={version:record.version,id:record.id,publicationId:record.publicationId,url:record.url,title:record.title,
          authors:record.authors,observedAt:record.observedAt,method:record.method,audience:record.audience,audio,
          bodyEvidence:{status:"complete",sha256:createHash("sha256").update(record.bodyHtml).digest("hex"),bytes:bodyBytes}};
        normalizeSubstackCapture(capture);
      }
      if(note.quote?.expanded)await hydrateAudio(note.quote.expanded);
    };
    await hydrateAudio(capture.note);
    capture = normalizeSubstackCapture(capture);
    const post = notePost(capture.note);
    let node = post, actualDepth = 0; const sourceIds = [post.id];
    while (node.quote) { actualDepth++; node = node.quote; sourceIds.push(node.id); }
    return { ...post, substackCapture: capture, quoteCoverage: { maxDepth: 8, actualDepth, maxReached: actualDepth >= 8,
      truncated: !!node.quoteBoundary, stopped: node.quoteBoundary?.status ?? "end", sourceIds,
      acquisitionDepth: depth, mayExpand: node.quoteBoundary?.status === "depth_limit" } };
  }
}
