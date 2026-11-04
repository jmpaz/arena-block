import { expect, test } from "bun:test";
import { manualExcerptPlan, excerptPlanFromDocument } from "../packages/core/excerpt.ts";
import { publicationFields, publicationPayload, webPlan } from "../packages/core/capture.ts";
import { verifyPublication } from "../packages/core/verification.ts";
import { blockPlanSchema } from "../packages/core/types.ts";
const source = "https://gwern.net/example#section";
const highlight = "https://example.com/page#:~:text=First%20words,last%20words.";
const html = '<title>Page title</title><p>Before <strong>First words</strong> and a <a href="/reference">citation</a>.</p><p>More <em>last words.</em> After.</p>';
const automatic = () => excerptPlanFromDocument({ url: highlight }, { body: html, responseURL: "https://example.com/page", contentType: "text/html" });

test("manual Markdown retains exact typed content and source without claiming a live match", () => {
  const text = "\n- **An authored list**\r\n  - [Citation](https://example.com/ref)\n\n> Exact quotation.\n";
  const plan = manualExcerptPlan({ url: source, text, title: "My title", description: "My notes" });
  expect(plan.block).toMatchObject({ kind: "text", canonicalSource: source, markdown: text, excerpt: { kind: "manual", text, format: "markdown" } });
  expect(plan.sources[0]?.text).toBe(text); expect(blockPlanSchema.parse(plan)).toEqual(plan);
  expect(publicationFields(plan)).toEqual({ title: "My title", description: "My notes", content: text });
  expect(publicationPayload(plan, "", undefined, [7])).toMatchObject({ original_source_url: source });
  const body = { state: "available", type: "Text", title: "My title", content: { markdown: text }, description: "My notes", source: { url: source } };
  expect(() => verifyPublication(plan, body, body)).not.toThrow();
  expect(() => verifyPublication(plan, { ...body, source: { url: "https://example.com/changed" } }, body)).toThrow("source");
  expect(() => verifyPublication(plan, { ...body, content: text.trim() }, body)).toThrow("Markdown");
});

test("literal plain text remains separate from its Markdown representation", () => {
  const text = "*literal* <tag> [label](url)";
  const plan = manualExcerptPlan({ url: source, text, format: "plain" });
  expect(plan.block.excerpt?.text).toBe(text); expect(plan.block.markdown).toContain("\\*literal\\*");
  expect(plan.block.markdown).not.toBe(text);
  for (const text of ["", " \n ", "a\0b", "a".repeat(50001)]) expect(() => manualExcerptPlan({ url: source, text })).toThrow();
});

test("automatic excerpt preserves selected formatting, citations and page version identity", () => {
  const plan = automatic();
  expect(plan.block.kind).toBe("text"); expect(plan.block.canonicalSource).toBe(highlight);
  expect(plan.block.markdown).toBe("**First words** and a [citation](https://example.com/reference).\n\nMore _last words._");
  expect(plan.block.excerpt).toMatchObject({ kind: "text-fragment", selectionURL: highlight, documentURL: "https://example.com/page", method: "provided-html", text: "First words and a citation.\n\nMore last words." });
  expect(plan.block.title).toBe("Excerpt from Page title"); expect(blockPlanSchema.parse(plan)).toEqual(plan);
  const changed = excerptPlanFromDocument({ url: highlight }, { body: html + "<!-- new version -->", responseURL: "https://example.com/page", contentType: "text/html" });
  expect(changed.hash).not.toBe(plan.hash); expect(changed.block.excerpt?.text).toBe(plan.block.excerpt?.text);
  const override = excerptPlanFromDocument({ url: highlight, sourceUrl: source, title: "Edited" }, { body: html, responseURL: "https://example.com/page", contentType: "text/html" });
  expect(override.block.canonicalSource).toBe(source); expect(override.sources[0]?.canonicalUrl).toBe(highlight); expect(override.block.title).toBe("Edited");
});

test("hidden/bootstrap text and incomplete selectors cannot produce an excerpt", () => {
  for (const body of ['<script>First words last words.</script><p>Login required</p>', '<p hidden>First words last words.</p>', '<p>First words but a different ending</p>'])
    expect(() => excerptPlanFromDocument({ url: highlight }, { body, responseURL: "https://example.com/page", contentType: "text/html" })).toThrow("could not be matched");
  expect(() => excerptPlanFromDocument({ url: source }, { body: html, responseURL: source, contentType: "text/html" })).toThrow("no text-fragment");
  expect(() => excerptPlanFromDocument({ url: highlight, text: "manual" }, { body: html, responseURL: source, contentType: "text/html" })).toThrow("Manual");
});

test("multiple selectors retain separate passages in directive order and list markup", () => {
  const url = "https://example.com/list#:~:text=Third%20item&text=First%20item";
  const plan = excerptPlanFromDocument({ url }, { body: '<ul><li>First item <b>bold</b></li><li>Second item</li><li>Third item</li></ul>', responseURL: "https://example.com/list", contentType: "text/html" });
  expect(plan.block.excerpt?.text).toBe("Third item\n\nFirst item");
  expect(plan.block.markdown).toBe("-   Third item\n\n-   First item");
});

test("source page title remains distinct from an edited block title and arbitrary citation override", () => {
  const document = { body: html, responseURL: "https://example.com/page", contentType: "text/html" as const };
  const plan = excerptPlanFromDocument({ url: highlight, title: "My title" }, document);
  expect(publicationPayload(plan, "", undefined, [])).toMatchObject({ title: "My title", original_source_title: "Page title" });
  const changed = excerptPlanFromDocument({ url: highlight, sourceUrl: source }, document);
  expect(publicationPayload(changed, "", undefined, [])).not.toHaveProperty("original_source_title");
  expect(publicationPayload(manualExcerptPlan({ url: source, title: "My title", text: "Copied text." }), "", undefined, [])).not.toHaveProperty("original_source_title");
});

test("selected line breaks and ordered list positions survive serialization", () => {
  const input = { url: "https://example.com/#:~:text=Second%20item,continued." };
  const plan = excerptPlanFromDocument(input, { body: '<ol start="3"><li>First item</li><li>Second item<br>continued.</li></ol>', responseURL: "https://example.com/", contentType: "text/html" });
  expect(plan.block.markdown).toStartWith("4."); expect(plan.block.excerpt?.text).toBe("Second item\ncontinued.");
  expect(plan.block.markdown).toContain("  \n");
});


test("a pure URL plan cannot silently replace an unresolved highlight excerpt", () => {
  expect(() => webPlan({ url: highlight })).toThrow("Resolve the highlight");
  expect(webPlan({ url: "https://gwern.net/design#features" }).block.kind).toBe("url");
});

test("an excerpt cannot be reinterpreted through media layout editing", async () => {
  const { reviseMosaicLayout } = await import("../packages/core/compose.ts");
  expect(() => reviseMosaicLayout(automatic(), "compact")).toThrow("Text excerpts do not have a media layout");
});

test("relative citations honor a safe declared document base and unsafe links stay inert", () => {
  const plan = excerptPlanFromDocument({ url: "https://example.com/#:~:text=Selected%20citation." }, { body: '<head><base href="https://citations.example/notes/"></head><p>Selected <a href="reference">citation.</a></p>', responseURL: "https://example.com/page", contentType: "text/html" });
  expect(plan.block.markdown).toBe("Selected [citation.](https://citations.example/notes/reference)");
  expect(plan.block.excerpt).toMatchObject({ documentBaseURL: "https://citations.example/notes/" });
  const unsafe = excerptPlanFromDocument({ url: "https://example.com/#:~:text=Selected%20citation." }, { body: '<p>Selected <a href="javascript:alert(1)" onclick="alert(2)">citation.</a></p>', responseURL: "https://example.com/", contentType: "text/html" });
  expect(unsafe.block.markdown).toBe("Selected citation.");
});
