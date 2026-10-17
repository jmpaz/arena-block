import { expect, test } from "bun:test";
import { createDocument } from "@mixmark-io/domino";
import capture from "./fixtures/substack-requested-public-capture.json";
import frozen from "./fixtures/substack-browser-plan.json";
import { SubstackProvider } from "../packages/core/providers/substack.ts";
import { normalizeSubstackCapture } from "../packages/core/substack-record.ts";
import { assignMediaRefs } from "../packages/core/providers/provider.ts";
import { parseSource } from "../packages/core/url.ts";
import { composePlan } from "../packages/core/compose.ts";
import { publicationFields } from "../packages/core/capture.ts";
import { blockPlanSchema } from "../packages/core/types.ts";
import { previewFields, revisePlan } from "../extension/src/core.ts";

const normalized = normalizeSubstackCapture(capture);
async function currentPlan() {
  const post = await new SubstackProvider([normalized]).resolve(parseSource(normalized.sourceUrl));
  return composePlan([assignMediaRefs(post, 0)], { media: "none" });
}

test("the requested public Note keeps authored writing and a linked quote without acquisition footers", async () => {
  const plan = await currentPlan(), fields = publicationFields(plan);
  expect(fields.title).toBe("Note by @norvidstudies");
  expect(fields.description).toBe("");
  expect(plan.sources[0]!.substackCapture).toEqual(normalized);
  expect(plan.sources[0]!.quote?.author.handle).toBe("lamblog");
  expect(plan.block.canonicalSource).toBe("https://substack.com/@norvidstudies/note/c-360829302");
  expect(previewFields(plan)).toEqual(fields);
  const markdown = String(fields.content);
  expect(markdown).not.toMatch(/Linked video|Substack Note source|capture observed|inferred timezone/);
  const doc = createDocument(Bun.markdown.html(markdown));
  const quote = doc.querySelector("blockquote")!;
  expect(quote).not.toBeNull();
  const attribution = quote.querySelector('a[href="https://substack.com/@lamblog/note/c-359890078"]')!;
  expect(attribution.querySelector("code")?.textContent).toBe("@lamblog");
  expect(quote.querySelector("p")?.textContent).toBe("@lamblog (Oct 13, 2026)");
  expect(quote.querySelectorAll("li")).toHaveLength(5);
  expect(quote.querySelectorAll("em").length).toBeGreaterThanOrEqual(2);
  expect(quote.querySelector('a[href="https://www.youtube.com/watch?v=1u5qMZvd6ps"]')?.textContent).toBe("https://www.youtube.com/watch?v=1u5qMZvd6ps");
  const words = (html: string) => createDocument(html.replace(/<\/(?:p|li|ul|ol|blockquote|div)>/gi, "$& ")).body.textContent!.replace(/\s+/g, " ").trim();
  expect(quote.textContent!.replace(/\s+/g, " ")).toContain(words(normalized.note.quote!.expanded!.body.html));
  quote.remove();
  expect(doc.body.textContent!.replace(/\s+/g, " ").trim()).toBe(words(normalized.note.body.html));
});

test("published quote dates remain source dates and obey the quote-date control", async () => {
  const record = structuredClone(normalized);
  record.note.postedAt = "2026-10-14T14:34:41.000Z";
  record.note.quote!.expanded!.postedAt = "2026-10-13T12:46:49.000Z";
  const post = assignMediaRefs(await new SubstackProvider([record]).resolve(parseSource(record.sourceUrl)), 0);
  expect(composePlan([post], { media: "none" }).block.markdown).toContain("](<https://substack.com/@lamblog/note/c-359890078>) (Oct 13, 2026)");
  expect(composePlan([post], { media: "none", quoteDates: "none" }).block.markdown).not.toContain("Oct 13, 2026");
  expect(composePlan([post], { media: "none", quote: "omit" }).block.markdown).not.toContain("Interesting debate");
});

test("opening an older frozen Note preserves its approved fields and source record", () => {
  const plan = blockPlanSchema.parse(frozen), edited = revisePlan(plan, { title: "My saved title" });
  expect(edited.block.markdown).toBe(plan.block.markdown);
  expect(edited.block.description).toBe(plan.block.description);
  expect(edited.sources).toEqual(plan.sources);
  expect(frozen.hash).toBe("26ea57c89d1dd23d9918d5f0854bb4894cea2ac11e3ba35d30a8b24ed4d9e233");
});

test("a linked source title stays literal and an authored URL is not appended twice", async () => {
  const record = structuredClone(normalized);
  record.note.body.html = "<p>Watch https://www.youtube.com/watch?v=abc</p>";
  record.note.links = [{ kind: "video", role: "linked", url: "https://www.youtube.com/watch?v=abc" },
    { kind: "article", role: "linked", url: "https://example.com/article", title: "An [authored] title" }];
  delete record.note.quote;
  const post = await new SubstackProvider([record]).resolve(parseSource(record.sourceUrl));
  expect(post.text.match(/https:\/\/www.youtube.com\/watch\?v=abc/g)).toHaveLength(1);
  const doc = createDocument(Bun.markdown.html(post.text));
  expect(doc.querySelector('a[href="https://example.com/article"]')?.textContent).toBe("An [authored] title");
});

test.each(["<p>See https://example.com/article-two</p>", '<p><a href="https://example.com/article-two">Other article</a></p>',
  "<p>See https://example.com/article?draft=unrelated</p>"])("distinct retained link survives a shared URL prefix: %s", async html => {
  const record = structuredClone(normalized);
  record.note.body.html = html;
  record.note.links = [{ kind: "article", role: "linked", url: "https://example.com/article" }];
  delete record.note.quote;
  const post = await new SubstackProvider([record]).resolve(parseSource(record.sourceUrl));
  expect(post.text).toContain("<https://example.com/article>");
});

test.each(['<p><a href="https://example.com/other">https://example.com/article</a></p>',
  "<p><code>https://example.com/article</code></p>", "<pre>https://example.com/article</pre>", "<script>https://example.com/article</script><p>Writing</p>", "<style>https://example.com/article</style><p>Writing</p>", "<p>https://example.com/<code>other</code>article</p>"])("a non-link reference cannot suppress the actual retained link: %s", async html => {
  const record = structuredClone(normalized);
  record.note.body.html = html;
  record.note.links = [{ kind: "article", role: "linked", url: "https://example.com/article" }];
  delete record.note.quote;
  const post = await new SubstackProvider([record]).resolve(parseSource(record.sourceUrl));
  const doc = createDocument(Bun.markdown.html(post.text));
  expect(doc.querySelectorAll('a[href="https://example.com/article"]')).toHaveLength(1);
});
