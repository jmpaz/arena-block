import TurndownService from "turndown";

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export async function fetchJson(url: string, fetcher: Fetcher, signal?: AbortSignal): Promise<unknown> {
  const response = await fetcher(url, {
    headers: { accept: "application/json", "user-agent": "arena-block/0.1" },
    redirect: "manual", credentials: "omit",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Public story/comment API returned ${response.status} for ${url}`);
  if (response.redirected || response.url && response.url !== url) throw new Error("Public story/comment API followed an unchecked redirect");
  if (Number(response.headers.get("content-length")) > 2_000_000) throw new Error("Public story/comment API response exceeds 2 MB");
  const body = await response.text();
  if (body.length > 2_000_000) throw new Error("Public story/comment API response exceeds 2 MB");
  return JSON.parse(body);
}

const markdown = new TurndownService({ codeBlockStyle: "fenced" });
markdown.remove(["script", "style", "img"]);
const plain = new TurndownService();
plain.escape = (text) => text;
plain.addRule("text", { filter: () => true, replacement: (content) => content });

export function commentMarkdown(html: string): string {
  return markdown.turndown(html);
}

export function commentTitle(html: string): string {
  return plain.turndown(html);
}

export function storyBody(body: string, link: string | undefined, author: string, profile: string): string {
  let target: string | undefined;
  if (link) {
    const url = new URL(link);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || link.length > 8192) throw new Error("Story has an unsupported submitted link");
    target = `Link: <${url.href.replace(/[<>]/g, character => encodeURIComponent(character))}>`;
  }
  const label = author.replace(/[\\`*_{}\[\]<>]/g, "\\$&").replace(/[\r\n]+/g, " ");
  return [body.trim(), target, `Submitted by [${label}](<${profile}>)`].filter(Boolean).join("\n\n");
}
