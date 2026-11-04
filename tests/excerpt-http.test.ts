import { expect, test } from "bun:test";
import { resolveExcerptPlan } from "../src/excerpt.ts";
import { resolveWebPlan } from "../src/web-link.ts";
const url = "https://example.com/article#intro:~:text=First%20words,last%20words.";
const html = '<title>Source title</title><p>First words preserve the complete middle and last words.</p>';

test("public resolution strips HTTP fragments, retains source identity and records actual acquisition", async () => {
  const calls: Array<{ url: string; options?: RequestInit }> = [];
  const plan = await resolveWebPlan({ url }, { fetcher: async (url, options) => { calls.push({ url, options }); return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }); } });
  expect(calls).toHaveLength(1); expect(calls[0]?.url).toBe("https://example.com/article");
  expect(calls[0]?.options).toMatchObject({ method: "GET", credentials: "omit", redirect: "manual" });
  expect(plan.block.excerpt).toMatchObject({ kind: "text-fragment", method: "public-html", documentURL: "https://example.com/article#intro", responseURL: "https://example.com/article" });
  expect(plan.block.canonicalSource).toBe(url);
});

test("manual text never fetches or acquires a false verified-selection label", async () => {
  const text = "A user-supplied excerpt, even when its live source is unavailable.";
  const plan = await resolveExcerptPlan({ url, text, title: "Edited" }, { fetcher: async () => { throw new Error("Manual input must not fetch"); } });
  expect(plan.block.excerpt).toEqual({ kind: "manual", format: "markdown", text });
  expect(plan.block.markdown).toBe(text); expect(plan.block.title).toBe("Edited");
});

test("access refusal, unsupported MIME/encoding, missing and oversized bodies fail rather than create a Link", async () => {
  for (const response of [new Response("Forbidden", { status: 403 }), new Response("PDF", { headers: { "content-type": "application/pdf" } }),
    new Response(html, { headers: { "content-type": "text/html; charset=windows-1252" } }),
    new Response(html, { headers: { "content-type": "text/html", "content-length": String(2 * 1024 * 1024 + 1) } }),
    new Response("<p>Login to continue</p>", { headers: { "content-type": "text/html" } }),
    new Response(new Uint8Array([0xff]), { headers: { "content-type": "text/html; charset=utf-8" } })])
    await expect(resolveExcerptPlan({ url }, { fetcher: async () => response })).rejects.toThrow();
});

test("redirects retain the input source and enforce public destinations", async () => {
  const plan = await resolveExcerptPlan({ url }, { fetcher: async address => address.includes("/article")
    ? new Response(null, { status: 302, headers: { location: "/canonical#ignored" } }) : new Response(html, { headers: { "content-type": "text/html" } }) });
  expect(plan.block.canonicalSource).toBe(url);
  expect(plan.block.excerpt).toMatchObject({ responseURL: "https://example.com/canonical" });
  await expect(resolveExcerptPlan({ url }, { fetcher: async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } }) })).rejects.toThrow("public");
  const cancel = new AbortController(); cancel.abort();
  await expect(resolveExcerptPlan({ url }, { signal: cancel.signal, fetcher: async () => new Promise(() => {}) })).rejects.toThrow();
});

test("stalled response reads cancel and streamed documents enforce the actual byte limit", async () => {
  const controller = new AbortController();
  const stream = new ReadableStream<Uint8Array>({ start() { } });
  const pending = resolveExcerptPlan({ url }, { signal: controller.signal, fetcher: async () => new Response(stream, { headers: { "content-type": "text/html" } }) });
  controller.abort(); await expect(pending).rejects.toThrow();
  await expect(resolveExcerptPlan({ url }, { fetcher: async () => new Response('a'.repeat(2 * 1024 * 1024 + 1), { headers: { "content-type": "text/html" } }) })).rejects.toThrow("2 MiB");
});
