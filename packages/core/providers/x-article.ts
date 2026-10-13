import TurndownService from "turndown";
import { z } from "zod";

const range = z.object({ offset: z.number().int().nonnegative(), length: z.number().int().nonnegative() });
const entity = z.object({ type: z.string(), data: z.record(z.string(), z.unknown()) });
const articleSchema = z.object({
  title: z.string().min(1),
  content: z.object({
    blocks: z.array(z.object({
      text: z.string(), type: z.string(), depth: z.number().int().nonnegative().default(0),
      entityRanges: z.array(range.extend({ key: z.union([z.string(), z.number()]) })).default([]),
      inlineStyleRanges: z.array(range.extend({ style: z.string() })).default([]),
    })).min(1),
    entityMap: z.union([
      z.array(z.object({ key: z.string(), value: entity })),
      z.record(z.string(), entity),
    ]),
  }),
  media_entities: z.array(z.object({
    media_id: z.string(), media_info: z.object({
      original_img_url: z.string().optional(),
      variants: z.array(z.object({
        url: z.string(), content_type: z.string(), bit_rate: z.number().optional(),
      })).optional(),
    }),
  })).default([]),
});
const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function url(value: unknown): string {
  if (typeof value !== "string") throw new Error("X article resource has no URL");
  const parsed = new URL(value);
  if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error("Invalid X article resource URL");
  return escape(value);
}
const converter = new TurndownService({ headingStyle: "atx", bulletListMarker: "-", codeBlockStyle: "fenced" });
converter.addRule("bareUrl", {
  filter: node => node.nodeName === "A" && node.textContent === node.getAttribute("href"),
  replacement: (_content, node) => node.getAttribute("href")!,
});
converter.addRule("blankLink", {
  filter: node => node.nodeName === "A" && !node.textContent?.trim(),
  replacement: content => content,
});
converter.addRule("strike", { filter: ["s", "del"], replacement: content => `~~${content}~~` });
converter.addRule("articleMarkdown", {
  filter: node => node.nodeName === "PRE" && node.getAttribute("data-article-markdown") === "true",
  replacement: (_content, node) => `\n\n${node.textContent ?? ""}\n\n`,
});

export function articleMarkdown(value: unknown): string {
  const article = articleSchema.parse(value);
  const entities = new Map(Array.isArray(article.content.entityMap)
    ? article.content.entityMap.map(item => [item.key, item.value] as const)
    : Object.entries(article.content.entityMap));
  const media = new Map(article.media_entities.map(item => [item.media_id, item.media_info]));
  let html = `<h1>${escape(article.title)}</h1>`;
  let list: string | undefined;
  for (const block of article.content.blocks) {
    const nextList = block.type === "ordered-list-item" ? "ol" : block.type === "unordered-list-item" ? "ul" : undefined;
    if (list !== nextList) {
      if (list) html += `</${list}>`;
      if (nextList) html += `<${nextList}>`;
      list = nextList;
    }
    if (block.type === "atomic") {
      for (const ref of block.entityRanges) {
        const item = entities.get(String(ref.key));
        if (item?.type === "DIVIDER") {
          html += "<hr>";
          continue;
        }
        if (item?.type === "TWEET" && typeof item.data.tweetId === "string" && /^\d+$/.test(item.data.tweetId)) {
          const permalink = `https://x.com/i/status/${item.data.tweetId}`;
          html += `<p><a href="${permalink}">${permalink}</a></p>`;
          continue;
        }
        if (item?.type === "MARKDOWN" && typeof item.data.markdown === "string") {
          html += `<pre data-article-markdown="true">${escape(item.data.markdown)}</pre>`;
          continue;
        }
        if (item?.type !== "MEDIA" || !Array.isArray(item.data.mediaItems)) throw new Error("Unsupported X article embed");
        for (const raw of item.data.mediaItems) {
          const id = z.object({ mediaId: z.string() }).parse(raw).mediaId;
          const resource = media.get(id);
          if (resource?.original_img_url) {
            html += `<p><img src="${url(resource.original_img_url)}" alt=""></p>`;
          } else {
            const video = resource?.variants?.filter(variant => variant.content_type === "video/mp4")
              .sort((a, b) => (b.bit_rate ?? 0) - (a.bit_rate ?? 0))[0];
            if (!video) throw new Error(`x.com article media ${id} has no supported image or video URL`);
            html += `<p><a href="${url(video.url)}">Video</a></p>`;
          }
        }
        if (typeof item.data.caption === "string" && item.data.caption.trim()) html += `<p>${escape(item.data.caption)}</p>`;
      }
      continue;
    }
    const units = [0];
    for (const char of block.text) units.push(units[units.length - 1]! + char.length);
    const unit = (codePoint: number) => units[Math.min(codePoint, units.length - 1)]!;
    const span = (ref: z.infer<typeof range>, open: string, close: string) =>
      ({ offset: unit(ref.offset), length: unit(ref.offset + ref.length) - unit(ref.offset), open, close });
    const spans = [
      ...block.entityRanges.flatMap(ref => {
        const item = entities.get(String(ref.key));
        if (item?.type === "TWEMOJI") return [];
        if (item?.type !== "LINK") throw new Error(`Unsupported x.com article inline entity: ${item?.type ?? "missing"}`);
        return [span(ref, `<a href="${url(item.data.url)}">`, "</a>")];
      }),
      ...block.inlineStyleRanges.flatMap(ref => {
        const tag = ({ bold: "strong", italic: "em", strikethrough: "s", code: "code", underline: "u" } as Record<string, string>)[ref.style.toLowerCase()];
        return tag ? [span(ref, `<${tag}>`, `</${tag}>`)] : [];
      }),
    ];
    const points = [...new Set([0, block.text.length, ...spans.flatMap(ref => [ref.offset, ref.offset + ref.length])])].sort((a,b) => a-b);
    let inline = "";
    let active: typeof spans = [];
    for (let i = 0; i < points.length - 1; i++) {
      const start = points[i]!;
      const next = spans.filter(ref => ref.offset <= start && ref.offset + ref.length > start);
      let shared = 0;
      while (shared < active.length && active[shared] === next[shared]) shared++;
      inline += active.slice(shared).reverse().map(ref => ref.close).join("");
      inline += next.slice(shared).map(ref => ref.open).join("");
      inline += escape(block.text.slice(start, points[i+1])).replace(/\n/g, "<br>");
      active = next;
    }
    inline += active.reverse().map(ref => ref.close).join("");
    const tag = nextList ? "li" : ({ unstyled: "p", paragraph: "p", "header-one": "h1", "header-two": "h2", "header-three": "h3", "header-four": "h4", "header-five": "h5", "header-six": "h6", blockquote: "blockquote", "code-block": "pre" } as Record<string,string>)[block.type];
    if (!tag) throw new Error(`Unsupported x.com article block: ${block.type}`);
    html += `<${tag}>${tag === "pre" ? `<code>${escape(block.text)}</code>` : inline}</${tag}>`;
  }
  if (list) html += `</${list}>`;
  return converter.turndown(html);
}
