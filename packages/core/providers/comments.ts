import TurndownService from "turndown";

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export async function fetchJson(url: string, fetcher: Fetcher, signal?: AbortSignal): Promise<unknown> {
  const response = await fetcher(url, {
    headers: { accept: "application/json", "user-agent": "arena-block/0.1" },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Comment API returned ${response.status} for ${url}`);
  return response.json();
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
