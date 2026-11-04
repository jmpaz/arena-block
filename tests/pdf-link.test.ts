import { expect, test } from "bun:test";
import { webPlan, publicationPayload } from "../src/capture.ts";
import { blockPlanSchema } from "../src/types.ts";
import { resolveWebPlan } from "../src/web-link.ts";
import { verifyPublication } from "../packages/core/verification.ts";
import { ArenaBlockClient } from "../src/client.ts";

const pdf = "https://pure.mpg.de/rest/items/item_3493256_8/component/file_3505426/content";
const source = "https://dl.acm.org/doi/10.1145/320435.320594";

test("PDF payload preserves content and chosen source separately, including plan identity", () => {
  const original = webPlan({ url: pdf, contentType: "application/pdf", title: "Paper" });
  const changed = webPlan({ url: pdf, sourceUrl: source, contentType: "application/pdf", title: "Paper" });
  expect(publicationPayload(original, "", undefined, [7])).toMatchObject({ value: pdf, original_source_url: pdf });
  expect(publicationPayload(changed, "", undefined, [7])).toMatchObject({ value: pdf, original_source_url: source });
  expect(changed.sources[0]!.canonicalUrl).toBe(pdf);
  expect(changed.hash).not.toBe(original.hash);
  expect(blockPlanSchema.parse(changed)).toEqual(changed);
});

test("source override also preserves ordinary link content", () => {
  const plan = webPlan({ url: "https://example.com/content", sourceUrl: source });
  expect(publicationPayload(plan, "", undefined, [])).toMatchObject({ value: "https://example.com/content", original_source_url: source });
  for (const sourceUrl of ["file:///etc/passwd", "javascript:alert(1)", "https://name:pass@example.com/"])
    expect(() => webPlan({ url: pdf, sourceUrl })).toThrow();
});

test("extensionless PDF detection uses MIME and resolves the chosen source title", async () => {
  const requests: string[] = [];
  const plan = await resolveWebPlan({ url: pdf, sourceUrl: source }, { fetcher: async (url, init) => {
    requests.push(`${init?.method} ${url}`);
    return init?.method === "HEAD" ? new Response(null, { headers: { "content-type": "application/pdf; charset=UTF-8" } })
      : new Response('<head><title>Paper &amp; citation</title></head>', { headers: { "content-type": "text/html" } });
  } });
  expect(plan.block).toMatchObject({ contentUrl: pdf, canonicalSource: source, contentType: "application/pdf", title: "Paper & citation" });
  expect(requests).toEqual([`HEAD ${pdf}`, `GET ${source}`]);
});

test("explicit title survives metadata resolution and inaccessible source metadata", async () => {
  let requests = 0;
  const plan = await resolveWebPlan({ url: pdf, sourceUrl: source, title: "My title" }, { fetcher: async () => {
    requests++; return new Response(null, { headers: { "content-type": "application/pdf" } });
  } });
  expect(requests).toBe(1); expect(plan.block.title).toBe("My title");
  const unavailable = await resolveWebPlan({ url: pdf, sourceUrl: source }, { fetcher: async (_url, init) => init?.method === "HEAD"
    ? new Response(null, { headers: { "content-type": "application/pdf", "content-disposition": "inline;filename*=UTF-8''Paper%20title.pdf" } })
    : new Response("denied", { status: 403 }) });
  expect(unavailable.block.title).toBe("Paper title");
  expect(unavailable.block.canonicalSource).toBe(source);
});

test("PDF verification requires available PDF content, public attachment and exact source", () => {
  const plan = webPlan({ url: pdf, sourceUrl: source, contentType: "application/pdf", title: "Paper" });
  const block = { state: "available", title: "Paper", type: "Attachment", description: null,
    attachment: { content_type: "application/pdf", url: "https://attachments.are.na/paper.pdf" }, source: { url: source } };
  expect(() => verifyPublication(plan, block, block)).not.toThrow();
  for (const patch of [{ source: { url: pdf } }, { type: "Link" }, { attachment: { content_type: "text/html", url: "https://example.com/" } },
    { attachment: { content_type: "application/pdf" } }, { state: "failed" }])
    expect(() => verifyPublication(plan, { ...block, ...patch }, block)).toThrow();
});

test("ordinary web verification checks the chosen source", () => {
  const plan = webPlan({ url: "https://example.com/content", sourceUrl: source, title: "Article" });
  const block = { state: "available", title: "Article", type: "Link", source: { url: source } };
  expect(() => verifyPublication(plan, block, block)).not.toThrow();
  expect(() => verifyPublication(plan, { ...block, source: { url: "https://example.com/content" } }, block)).toThrow("source");
});

test("older receivers are rejected before they can discard PDF or source fields", async () => {
  const calls: string[] = [];
  const client = new ArenaBlockClient("https://daemon.invalid", "unused", async url => {
    calls.push(String(url));
    return Response.json({ version: "old", revision: null, sourceId: "old", platform: "test", schemaVersion: 1, packagePath: null });
  });
  const plan = webPlan({ url: pdf, sourceUrl: source, contentType: "application/pdf" });
  await expect(client.publish(plan, ["destination"])).rejects.toThrow("web-pdf-source-v1");
  expect(calls).toEqual(["https://daemon.invalid/v1/version"]);
});

test("metadata acquisition refuses local redirects and propagates cancellation", async () => {
  await expect(resolveWebPlan({ url: pdf }, { fetcher: async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } }) })).rejects.toThrow("public");
  const controller = new AbortController(); controller.abort();
  await expect(resolveWebPlan({ url: pdf }, { signal: controller.signal, fetcher: async () => new Promise(() => {}) })).rejects.toThrow();
});
