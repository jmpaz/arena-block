import { expect, test } from "bun:test";
import { createContext, runInContext } from "node:vm";
import { createHash } from "node:crypto";
import { manualExcerptPlan, excerptPlanFromDocument } from "../packages/core/excerpt.ts";
const bundle = await Bun.file(new URL("../ios/Sources/CaptureRuntime/Resources/capture-core.js", import.meta.url)).text();
const runtime = () => {
  const context = createContext({ nativeSHA256: (value: string) => createHash("sha256").update(value).digest("hex"),
    setTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay).unref(), clearTimeout,
    nativeHTTP() {}, nativeCancelHTTP() {}, nativeResolveComplete() {} });
  runInContext(bundle, context); return context;
};
test("shared native bundle produces the identical manual and resolved excerpt plans", () => {
  const context = runtime();
  const manual = { url: "https://example.com/#source", text: "- **Copied**\n\n> café 日本語 👋", title: "Edited" };
  expect(JSON.parse(context.captureExcerptPlan(JSON.stringify(manual))).plan).toEqual(manualExcerptPlan(manual));
  const input = { url: "https://example.com/#:~:text=First%20words,last%20words." };
  const document = { body: '<title>Source</title><p><b>First words</b> and <a href="/ref">café 日本語 👋</a> last words.</p>', responseURL: "https://example.com/", contentType: "text/html" as const };
  const plan = JSON.parse(context.captureExcerptDocumentPlan(JSON.stringify({ input, document }))).plan;
  expect(plan).toEqual(excerptPlanFromDocument(input, document));
  expect(plan.block.excerpt.method).toBe("provided-html");
  const payload = JSON.parse(context.captureLocalPayload(JSON.stringify(plan), "", "", "[]"));
  expect(payload.original_source_url).toBe(input.url);
  const block = { state: "available", type: "Text", title: plan.block.title, content: { markdown: plan.block.markdown }, description: null, source: { url: input.url } };
  expect(() => context.captureVerify(JSON.stringify(plan), JSON.stringify(block))).not.toThrow();
  expect(() => context.captureVerify(JSON.stringify(plan), JSON.stringify({ ...block, source: { url: "https://example.com/" } }))).toThrow("source");
  expect(() => context.captureExcerptDocumentPlan(JSON.stringify({ input, document: { ...document, body: "<p>Unavailable</p>" } }))).toThrow("could not be matched");
  expect(() => context.captureExcerptDocumentPlan(JSON.stringify({ input, document: { ...document, method: "public-html" } }))).toThrow();
});
