import { createDocument } from "@mixmark-io/domino";
import { webPlan, webPlanInputSchema, webSourceURL } from "./capture.ts";
import { abortable, deadline } from "./bounded-io.ts";
import type { BlockPlan } from "./types.ts";
import type { z } from "zod";
import { parseTextFragment } from "../packages/core/text-fragment.ts";

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export function publicWebURL(value: string): string {
  const url = new URL(webSourceURL(value));
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || !host.includes(".") || host.includes(":")
    || /^(?:127|0|10)\.|^169\.254\.|^192\.168\.|^172\.(?:1[6-9]|2\d|3[01])\./.test(host)) throw new Error("Use a public web link");
  return url.href;
}

export async function requestPublicWeb(url: string, method: string, fetcher: Fetcher, signal: AbortSignal): Promise<{ response: Response; url: string }> {
  const requestURL = new URL(publicWebURL(url)); requestURL.hash = "";
  let current = requestURL.href;
  for (let index = 0; index < 4; index++) {
    const response = await abortable(fetcher(current, { method, redirect: "manual", credentials: "omit", signal,
      headers: { accept: "text/html,application/pdf;q=0.9,*/*;q=0.5" } }), signal);
    if (![301, 302, 303, 307, 308].includes(response.status)) return { response, url: current };
    void response.body?.cancel().catch(() => {});
    const next = response.headers.get("location");
    if (!next) throw new Error("The link has no redirect destination");
    const redirect = new URL(publicWebURL(new URL(next, current).href)); redirect.hash = ""; current = redirect.href;
  }
  throw new Error("The link redirected too many times");
}

export async function resolveWebPlan(input: z.input<typeof webPlanInputSchema>, options: { signal?: AbortSignal; fetcher?: Fetcher } = {}): Promise<BlockPlan> {
  const value = webPlanInputSchema.parse(input);
  if (parseTextFragment(value.url)) {
    if (value.contentType !== undefined) throw new Error("A highlight selection cannot be prepared as PDF content");
    const { contentType, ...excerpt } = value;
    return (await import("./excerpt.ts")).resolveExcerptPlan(excerpt, options);
  }
  webPlan(value);
  const fetcher = options.fetcher ?? fetch;
  const signal = deadline(20_000, options.signal);
  const { response: head } = await requestPublicWeb(value.url, "HEAD", fetcher, signal);
  const pdf = head.ok && head.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() === "application/pdf";
  // A .pdf suffix can survive a host's refusal of HEAD. Are.na still verifies the attachment after ingestion.
  const contentType = pdf || /\.pdf$/i.test(new URL(value.url).pathname) ? "application/pdf" as const : value.contentType;
  let title = value.title;
  const titleURL = value.sourceUrl ?? value.url;
  if (!title && (!contentType || value.sourceUrl)) {
    try {
      const { response } = await requestPublicWeb(titleURL, "GET", fetcher, signal);
      if (response.ok && response.headers.get("content-type")?.toLowerCase().includes("text/html")) {
        const reader = response.body?.getReader();
        if (reader) {
          const decoder = new TextDecoder(); let text = "", size = 0;
          try {
            while (true) {
              const part = await abortable(reader.read(), signal);
              if (part.done) break;
              size += part.value.byteLength;
              if (size > 512 * 1024) break;
              text += decoder.decode(part.value, { stream: true });
              if (/<\/head\s*>/i.test(text)) break;
            }
          } finally { void reader.cancel().catch(() => {}); }
          const document = createDocument(text);
          title = (document.querySelector('meta[property="og:title"]')?.getAttribute("content") ?? document.title)?.replace(/\s+/g, " ").trim().slice(0, 512) || undefined;
        }
      } else void response.body?.cancel().catch(() => {});
    } catch (error) { signal.throwIfAborted(); }
  }
  if (!title && contentType) {
    const disposition = head.headers.get("content-disposition") ?? "";
    const name = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1] ?? /filename="?([^";]+)/i.exec(disposition)?.[1];
    try { title = decodeURIComponent(name ?? new URL(value.url).pathname.split("/").at(-1) ?? "").replace(/\.pdf$/i, "").trim().slice(0, 512) || undefined; } catch { }
  }
  return webPlan({ ...value, ...(title ? { title } : {}), ...(contentType ? { contentType } : {}) });
}
