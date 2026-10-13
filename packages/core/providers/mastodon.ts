import TurndownService from "turndown";
import { z } from "zod";
import type { MediaAsset, ResolvedPost } from "../types.ts";
import type { ParsedSource } from "../url.ts";
import type { Fetcher } from "./comments.ts";
import type { SocialProvider } from "./provider.ts";

const dimensions = z.object({
  width: z.number().nullish(),
  height: z.number().nullish(),
  duration: z.number().nullish(),
});
const attachmentSchema = z.object({
  id: z.string(),
  type: z.string(),
  url: z.string().nullish(),
  remote_url: z.string().nullish(),
  preview_url: z.string().nullish(),
  description: z.string().nullish(),
  meta: dimensions.extend({ original: dimensions.nullish() }).nullish(),
});
const statusSchema = z.object({
  id: z.string().min(1),
  url: z.string().nullish(),
  uri: z.string().min(1),
  account: z.object({ acct: z.string().min(1), url: z.string(), display_name: z.string().optional() }),
  content: z.string(),
  created_at: z.string(),
  visibility: z.enum(["public", "unlisted"]),
  spoiler_text: z.string().default(""),
  sensitive: z.boolean().default(false),
  media_attachments: z.array(attachmentSchema),
  reblog: z.unknown().optional(),
  quote: z.object({ state: z.string(), quoted_status: z.unknown().optional() }).nullish(),
});

function markdownConverter(omitQuoteFallback: boolean): TurndownService {
  const converter = new TurndownService({ codeBlockStyle: "fenced" });
  converter.remove(["script", "style"]);
  converter.addRule("emoji", {
    filter: "img",
    replacement: (_content, node) => node.getAttribute("alt") ?? "",
  });
  converter.addRule("bareUrl", {
    filter: (node) => node.nodeName === "A"
      && /^https?:\/\//.test(node.getAttribute("href") ?? "")
      && node.textContent?.trim() === node.getAttribute("href"),
    replacement: (_content, node) => node.getAttribute("href")!,
  });
  if (omitQuoteFallback) converter.addRule("quoteFallback", {
    filter: (node) => node.nodeName === "P" && (node.getAttribute("class") ?? "").split(/\s+/).includes("quote-inline"),
    replacement: () => "",
  });
  return converter;
}

const markdown = markdownConverter(false);
const quotedMarkdown = markdownConverter(true);

function webUrl(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error(`Invalid Mastodon resource URL: ${value}`);
  }
  return url.href;
}

function positive(value: number | null | undefined): number | undefined {
  return value !== undefined && value !== null && Number.isFinite(value) && value > 0 ? value : undefined;
}

function safePoster(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}

function attachmentMedia(attachment: z.infer<typeof attachmentSchema>): MediaAsset | undefined {
  if (!["image", "video", "gifv"].includes(attachment.type)) return undefined;
  const url = attachment.url || attachment.remote_url;
  if (!url) throw new Error(`Mastodon attachment ${attachment.id} has no downloadable URL`);
  const width = positive(attachment.meta?.original?.width ?? attachment.meta?.width);
  const height = positive(attachment.meta?.original?.height ?? attachment.meta?.height);
  const duration = positive(attachment.meta?.original?.duration ?? attachment.meta?.duration);
  return {
    ref: "0.0", id: attachment.id,
    kind: attachment.type === "image" ? "image" : "video",
    url: webUrl(url), alt: attachment.description ?? "",
    ...(width && Number.isInteger(width) ? { width } : {}),
    ...(height && Number.isInteger(height) ? { height } : {}),
    ...(duration ? { durationSeconds: duration } : {}),
    ...(attachment.type !== "image" && safePoster(attachment.preview_url) ? { posterUrl: safePoster(attachment.preview_url) } : {}),
  };
}

function postFromStatus(value: unknown, depth = 0): ResolvedPost {
  if (depth > 4) throw new Error("Mastodon status nesting is too deep");
  const status = statusSchema.parse(value);
  if (status.reblog) return postFromStatus(status.reblog, depth + 1);
  const canonicalUrl = webUrl(status.url || status.uri);
  const accountHost = new URL(webUrl(status.account.url)).host;
  const handle = status.account.acct.includes("@") ? status.account.acct : `${status.account.acct}@${accountHost}`;
  const postedAt = new Date(status.created_at);
  if (!Number.isFinite(postedAt.getTime())) throw new Error("Invalid Mastodon post timestamp");
  const media = status.media_attachments.flatMap((attachment) => attachmentMedia(attachment) ?? []);
  const attachmentLinks = status.media_attachments.filter((attachment) => !["image", "video", "gifv"].includes(attachment.type)).map((attachment) => {
    const url = attachment.url || attachment.remote_url;
    if (!url) throw new Error(`Mastodon attachment ${attachment.id} has no downloadable URL`);
    return `[${attachment.type === "audio" ? "Audio" : "Attachment"}](<${webUrl(url)}>)`;
  });
  const warning = status.spoiler_text
    ? `Content warning: ${markdown.escape(status.spoiler_text)}`
    : status.sensitive ? "Sensitive media" : "";
  const quote = status.quote?.state === "accepted" && status.quote.quoted_status
    ? postFromStatus(status.quote.quoted_status, depth + 1) : undefined;
  return {
    provider: "mastodon", id: status.id, canonicalUrl,
    author: { handle, ...(status.account.display_name ? { name: status.account.display_name } : {}) },
    text: [warning, (quote ? quotedMarkdown : markdown).turndown(status.content), ...attachmentLinks].filter(Boolean).join("\n\n"),
    postedAt: postedAt.toISOString(), media,
    ...(quote ? { quote } : {}),
  };
}

export class MastodonProvider implements SocialProvider {
  constructor(private readonly fetcher: Fetcher = fetch) {}

  async resolve(source: ParsedSource, signal?: AbortSignal): Promise<ResolvedPost> {
    if (source.provider !== "mastodon") throw new Error("MastodonProvider received a non-Mastodon source");
    const endpoint = `${source.server}/api/v1/statuses/${source.id}`;
    const response = await this.fetcher(endpoint, {
      headers: { accept: "application/json", "user-agent": "arena-block/0.1" },
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Mastodon API returned ${response.status} for ${source.canonicalUrl}`);
    const value = await response.json();
    const status = statusSchema.parse(value);
    if (status.id !== source.id) throw new Error("Mastodon API returned a different status");
    return postFromStatus(status);
  }
}
