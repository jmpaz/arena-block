import { expect, test } from "bun:test";
import { createDocument } from "@mixmark-io/domino";
import { renderBlockTextPreview, renderMarkdownPreview, markdownSummary } from "../extension/src/markdown-preview.ts";
import { quoteAuthorChoice, quoteAuthorPolicy, reviseQuoteAuthorLink } from "../extension/src/quote-presentation.ts";
import { revisePlan } from "../extension/src/core.ts";
import { composePlan, planHash } from "../packages/core/compose.ts";
import { publicationFields } from "../packages/core/capture.ts";
import { fixtureFetch, loadCatalog, resolveContract } from "../scripts/check-substack-contracts.ts";
import type { BlockPlan } from "../packages/core/types.ts";

const container = () => createDocument("").createElement("div") as unknown as HTMLElement;
const normalize = (text: string | null) => text?.replace(/\s+/g, " ").trim();
const catalog = await loadCatalog();
const plans = await Promise.all(["347044458", "348712218", "360829302"].map(async id => ({
  id, plan: await resolveContract(catalog.cases.find(value => value.id === id)!, await fixtureFetch()),
})));

for (const { id, plan } of plans) test(`real Note ${id}: formatted publication text retains source writing, links and nested quote ownership`, () => {
  const original = structuredClone(plan);
  for (const choice of ["", "source", "plain"] as const) {
    const revised = reviseQuoteAuthorLink(plan, choice);
    const preview = container(); renderBlockTextPreview(preview, revised);
    const fields = publicationFields(revised);
    const expected = container(); renderMarkdownPreview(expected, [fields.content, fields.description].filter(Boolean).join("\n\n---\n\n"), plan.block.canonicalSource);
    expect(preview.innerHTML).toBe(expected.innerHTML);
    let source = revised.sources[0]!;
    const root = container(); renderMarkdownPreview(root, source.text, source.canonicalUrl);
    expect(normalize(preview.textContent)).toContain(normalize(root.textContent)!);
    let depth = 0;
    while (source.quote) {
      source = source.quote; depth++;
      const quote = container(); renderMarkdownPreview(quote, source.text, source.canonicalUrl);
      expect(normalize(preview.textContent)).toContain(normalize(quote.textContent)!);
      expect(preview.querySelector("blockquote ".repeat(depth).trim())).not.toBeNull();
      const credit = Array.from(preview.querySelectorAll("a")).find(link => link.textContent === `@${source.author.handle}` && link.getAttribute("href") === source.canonicalUrl);
      if (choice !== "plain") expect(credit?.getAttribute("href")).toBe(source.canonicalUrl);
      else expect(credit).toBeUndefined();
    }
    expect(preview.querySelectorAll("img, video, audio, iframe, script, style").length).toBe(0);
    expect(preview.textContent).not.toContain("](<");
    expect(revised.sources).toEqual(plan.sources);
    expect(revised.block.selectedMedia).toEqual(plan.block.selectedMedia);
    if (id === "347044458" || id === "348712218") {
      expect(Array.from(preview.querySelectorAll("a")).some(link => link.href.includes("colly.com"))).toBe(true);
      expect(preview.querySelector("em")).not.toBeNull();
    }
    if (id === "348712218") {
      expect(Array.from(preview.querySelectorAll("a")).some(link => link.href.includes("lucy-ives.com"))).toBe(true);
      expect(preview.querySelector("blockquote blockquote")).not.toBeNull();
    }
    if (id === "360829302") {
      expect(preview.querySelectorAll("li").length).toBe(5);
      expect(preview.textContent).toContain("destructive policies that foreclose human potential.");
      expect(preview.querySelectorAll("em").length).toBeGreaterThanOrEqual(2);
    }
  }
  expect(plan).toEqual(original);
});

test("unset choice retains legacy hashes; source/plain can be reverted without establishing a new default", async () => {
  const legacy = await Bun.file(new URL("./fixtures/quote-author-links-legacy-plans.json", import.meta.url)).json() as { plan: BlockPlan }[];
  expect(quoteAuthorChoice(undefined)).toBe("");
  expect(quoteAuthorChoice("profile")).toBe("");
  expect(quoteAuthorPolicy("")).toEqual({});
  for (const { plan } of legacy) {
    expect(reviseQuoteAuthorLink(plan, "")).toEqual(plan);
    const linked = reviseQuoteAuthorLink(plan, "source");
    expect(quoteAuthorChoice(undefined, linked)).toBe("source");
    expect(quoteAuthorChoice("", linked)).toBe("");
    expect(reviseQuoteAuthorLink(linked, "")).toEqual(plan);
    const plain = reviseQuoteAuthorLink(linked, "plain");
    expect(plain.policy.quoteAuthorLink).toBe("plain");
    expect(reviseQuoteAuthorLink(plain, "")).toEqual(plan);
  }
});

test("changing credit style preserves manual fields, media exclusions, order, quote depth and source tree", () => {
  const original = plans[1]!.plan;
  const configured = composePlan(original.sources, { ...original.policy, quoteDepth: 2, media: "selected",
    selectedMedia: [original.block.selectedMedia[0]!], mediaOrder: [original.block.selectedMedia[0]!] });
  const edits = { title: "Chosen title", markdown: "**My text** with [link](https://example.com/authored)", description: "_My description_" };
  const edited = revisePlan(configured, edits);
  for (const choice of ["source", "plain", ""] as const) {
    const changed = reviseQuoteAuthorLink(edited, choice, edits);
    expect(changed.block.title).toBe(edits.title);
    expect(changed.block.markdown).toBe(edits.markdown);
    expect(changed.block.description).toBe(edits.description);
    expect(changed.sources).toEqual(edited.sources);
    expect(changed.block.selectedMedia).toEqual(edited.block.selectedMedia);
    expect(changed.policy.mediaOrder).toEqual(edited.policy.mediaOrder);
    expect(changed.policy.quoteDepth).toBe(2);
    const { hash, ...content } = changed;
    expect(planHash(content)).toBe(hash);
  }
  const titleOnly = reviseQuoteAuthorLink(edited, "plain", { title: edits.title });
  expect(titleOnly.block.title).toBe(edits.title);
  expect(titleOnly.block.markdown).not.toBe(edits.markdown);
  expect(titleOnly.block.markdown).not.toContain("[`@joodaloop`]");
});

test("Markdown preview keeps raw HTML inert and rejects obfuscated unsafe destinations without dropping authored labels", () => {
  const preview = container();
  renderMarkdownPreview(preview, [
    '<script>alert(1)</script><img src="https://tracking.invalid/pixel" onerror="alert(2)"><svg onload="alert(3)"></svg>',
    '[script](javascript:alert%281%29) [entity](java&#x73;cript:alert%281%29) [control](java&#9;script:alert%281%29)',
    '[data](data:text/html,attack) [file](file:///etc/passwd) [credentials](https://user:pass@example.com/)',
    '[safe](https://example.com/path?a=1&b=2) [http](http://example.org/) [relative](../parent#reply) [mail](mailto:josh@example.com)',
    '![**authored alt**](https://tracking.invalid/pixel) &lt;iframe src=https://tracking.invalid&gt; &amp; &copy;',
  ].join("\n\n"), "https://substack.com/@author/note/c-1");
  expect(preview.querySelectorAll("script, img, iframe, svg, style, input, video, audio, object, embed").length).toBe(0);
  expect(Array.from(preview.querySelectorAll("a")).map(a => a.textContent)).toEqual(["safe", "http", "relative", "mail", "https://tracking.invalid"]);
  expect(preview.textContent).toContain("script entity control");
  expect(preview.textContent).toContain("data file credentials");
  expect(preview.textContent).toContain("authored alt");
  expect(preview.textContent).toContain('<script>alert(1)</script>');
  expect(preview.textContent).toContain("<iframe src=https://tracking.invalid> & ©");
  for (const link of Array.from(preview.querySelectorAll("a"))) {
    expect(link.rel).toBe("noreferrer noopener"); expect(link.target).toBe("_blank");
  }
  expect(Array.from(preview.querySelectorAll("*")).some(node => Array.from(node.attributes).some(attr => attr.name.startsWith("on")))).toBe(false);
});

test("lists, code, entities, headings and table cells retain structure and literal code", () => {
  const preview = container();
  renderMarkdownPreview(preview, '# Title\n\n3. first\n   - nested **bold**\n4. second\n\n> quote\n>\n> > deep _emphasis_\n\n`&amp; <script>`\n\n```html\n<img src="x"> &amp;\n```\n\n| A | B |\n|:--|--:|\n| one | two |\n\n~~deleted~~ and &amp; &lt; literal');
  expect(preview.querySelector("h1")?.textContent).toBe("Title");
  expect(preview.querySelector("ol")?.getAttribute("start")).toBe("3");
  expect(preview.querySelector("ol li ul li strong")?.textContent).toBe("bold");
  expect(preview.querySelector("blockquote blockquote em")?.textContent).toBe("emphasis");
  expect(Array.from(preview.querySelectorAll("code")).map(node => node.textContent)).toEqual(['&amp; <script>', '<img src="x"> &amp;']);
  expect(preview.querySelectorAll("table td").length).toBe(2);
  expect(preview.querySelector("del")?.textContent).toBe("deleted");
  expect(preview.textContent).toContain("and & < literal");
  expect(markdownSummary(preview.ownerDocument, "**First** paragraph\n\nSecond [label](https://example.com) `code`"))
    .toBe("First paragraph Second label code");
});

test("media descriptions and edited text are previewed without modifying immutable publication fields", () => {
  const plan = revisePlan(plans[0]!.plan, { markdown: "**edited writing**", description: "[description link](https://example.org/description)" });
  const frozen = JSON.stringify(plan), preview = container();
  renderBlockTextPreview(preview, plan);
  expect(preview.querySelector("strong")?.textContent).toBe("edited writing");
  expect(preview.querySelector("a")?.href).toBe("https://example.org/description");
  expect(JSON.stringify(plan)).toBe(frozen);
});

test("autolink labels keep literal character references while ordinary link destinations decode them", () => {
  const preview = container();
  renderMarkdownPreview(preview, "<https://example.com/?a=1&amp;b=2> [label](https://example.com/?a=1&amp;b=2)");
  const links = Array.from(preview.querySelectorAll("a"));
  expect(links[0]!.textContent).toBe("https://example.com/?a=1&amp;b=2");
  expect(links[0]!.getAttribute("href")).toBe("https://example.com/?a=1&amp;b=2");
  expect(links[1]!.getAttribute("href")).toBe("https://example.com/?a=1&b=2");
});
