import { expect, test } from "bun:test";
import { parseSource } from "../packages/core/url.ts";
import { normalizeSubstackCapture, bindSubstackCaptures, type SubstackCapture } from "../packages/core/substack-record.ts";
import { SubstackProvider } from "../packages/core/providers/substack.ts";
import { SocialResolver } from "../packages/core/providers/index.ts";
import { blockPlanSchema, resolvedPostSchema } from "../packages/core/types.ts";
import { composePlan } from "../packages/core/compose.ts";
import { requiredPlanCapabilities } from "../src/plan-capabilities.ts";
import { ArenaBlockClient } from "../src/client.ts";

function fixture(): SubstackCapture {
  const quote = { url: "https://substack.com/@quoted/note/c-2", author: { handle: "quoted", name: "Quoted Writer", profileUrl: "https://substack.com/@quoted" },
    body: { status: "complete" as const, html: "<p>Full quoted body.</p><ul><li>First claim</li><li><em>Second</em> claim</li></ul>" },
    publishedLabel: "Oct 13, 2026, 8:46 AM", links: [{ kind: "video" as const, role: "linked" as const, url: "https://www.youtube.com/watch?v=example&utm_source=substack" }] };
  return { schema: "arena-block/substack-browser-capture", version: 1, sourceUrl: "https://substack.com/@writer/note/c-1?utm_source=share#comments",
    observedAt: "2026-10-15T12:00:00Z", method: "browser-dom", note: {
      url: "https://substack.com/@writer/note/c-1", author: { handle: "writer", name: "Writer", profileUrl: "https://substack.com/@writer" },
      body: { status: "complete", html: "<p>Outer <strong>commentary</strong>.</p>" }, links: [],
      quote: { url: quote.url, previewHtml: "<p>Full quoted …</p>", expanded: quote },
    } };
}
const source = (c: SubstackCapture) => parseSource(c.sourceUrl);

test("canonical Note identities include handles, profile routes and bare Note URLs", () => {
  for (const url of ["https://substack.com/@writer/note/c-1?utm_source=share#comments", "https://www.substack.com/note/c-1/", "https://substack.com/profile/123-writer/note/c-1"]) {
    expect(parseSource(url)).toMatchObject({ provider: "substack", id: "1" });
    expect(parseSource(url).canonicalUrl).not.toContain("?");
  }
  expect(() => parseSource("https://writer.substack.com/p/article")).toThrow("Unsupported social post URL");
});
test.each(["http://substack.com/@writer/note/c-1", "https://user:secret@substack.com/@writer/note/c-1", "https://substack.com:444/@writer/note/c-1", "https://substack.com/@writer/note/c-0", "https://substack.com/@writer/note/c-1/replies"])("invalid Note route stops: %s", url => {
  expect(() => parseSource(url)).toThrow();
});
test("full nested prose and preview provenance stay distinct through schema and composition", async () => {
  const capture = fixture();
  const posts = await new SocialResolver({ substack: new SubstackProvider([capture]) }).resolve([capture.sourceUrl]);
  const post = posts[0]!;
  expect(post.text).toContain("Outer **commentary**.");
  expect(post.text).not.toContain("Full quoted body");
  expect(post.quote?.text).toContain("Full quoted body.");
  expect(post.quote?.text).toContain("-   First claim");
  expect(post.quote?.text).toContain("Linked video");
  expect(post.quote?.media).toEqual([]);
  expect(post.quote?.text).toContain("utm_source=substack");
  expect(post.postedAt).toBeUndefined();
  const plan = composePlan(posts, { media: "none" });
  expect(plan.block.markdown).toContain("`@quoted`");
  expect(plan.block.markdown).toContain("/note/c-2");
  expect(plan.block.markdown).toContain("/note/c-1");
  expect(plan.block.markdown).not.toContain("Full quoted …");
  expect(blockPlanSchema.parse(plan)).toEqual(plan);
  expect(post.substackCapture?.note.quote?.previewHtml).toBe(capture.note.quote?.previewHtml);
  expect(requiredPlanCapabilities(plan)).toEqual(["substack-browser-records-v1"]);
});
test.each(["preview", "unavailable"] as const)("%s root cannot become full prose", async status => {
  const capture = fixture(); capture.note.body.status = status;
  await expect(new SubstackProvider([capture]).resolve(source(capture))).rejects.toThrow("full body capture is required");
});
test("an unexpanded quote is a visible boundary; preview is retained without promotion", async () => {
  const c = fixture(); delete c.note.quote!.expanded;
  const post = await new SubstackProvider([c]).resolve(source(c));
  expect(post.quote).toBeUndefined();
  expect(post.quoteBoundary).toMatchObject({ status: "unavailable", id: "2" });
  const plan = composePlan([post]);
  expect(plan.block.markdown).toContain("Quoted post unavailable");
  expect(plan.block.markdown).not.toContain("Full quoted …");
  expect(plan.sources[0]!.substackCapture?.note.quote?.previewHtml).toContain("Full quoted …");
});
test("article excerpts and attachment links are labelled separately from Note prose", async () => {
  const c = fixture(); c.note.links = [
    { kind: "article", role: "linked", url: "https://writer.substack.com/p/article?selection=abc", title: "An article", excerptAuthor: "Article Writer", excerptHtml: "<p>Only the selected words</p>" },
    { kind: "image", role: "preview", url: "https://substackcdn.com/image/example.jpg" },
    { kind: "audio", role: "attachment", url: "https://substackcdn.com/audio/example.mp3" },
  ];
  const post = await new SubstackProvider([c]).resolve(source(c));
  expect(post.article).toBeUndefined();
  expect(post.text).toContain("Selected article excerpt (not full article), by Article Writer");
  expect(post.text).toContain("Preview of image");
  expect(post.text).toContain("Attachment; original not acquired: audio");
  expect(post.media).toEqual([]);
});
test("mismatched source, author, quote and cycles fail before composition", () => {
  for (const mutate of [
    (c: SubstackCapture) => { c.sourceUrl = "https://substack.com/@writer/note/c-3"; },
    (c: SubstackCapture) => { c.note.author.handle = "someoneelse"; },
    (c: SubstackCapture) => { c.note.quote!.expanded!.url = "https://substack.com/@quoted/note/c-3"; },
    (c: SubstackCapture) => { c.note.quote!.url = c.note.url; },
  ]) { const c = fixture(); mutate(c); expect(() => normalizeSubstackCapture(c)).toThrow(); }
});
test("bounded import rejects excess depth, bytes, unknown fields and future observations", () => {
  const c = fixture(); let node = c.note;
  for (let i = 2; i < 12; i++) { const next = structuredClone(c.note); delete next.quote; next.url = `https://substack.com/@writer/note/c-${i}`; node.quote = { url: next.url, expanded: next }; node = next; }
  expect(() => normalizeSubstackCapture(c)).toThrow();
  expect(() => normalizeSubstackCapture({ ...fixture(), extra: "x".repeat(2_100_000) })).toThrow("2 MiB");
  expect(() => normalizeSubstackCapture({ ...fixture(), cookies: "not allowed" })).toThrow();
  expect(() => normalizeSubstackCapture({ ...fixture(), observedAt: "2099-01-01T00:00:00Z" })).toThrow("future");
});
test("selected binding rejects unrelated and duplicate captures", () => {
  const c = fixture(); expect(() => bindSubstackCaptures([c.sourceUrl], [c, c])).toThrow("Duplicate");
  expect(() => new SubstackProvider([c, c])).toThrow("Duplicate");
  expect(() => bindSubstackCaptures(["https://substack.com/note/c-9"], [c])).toThrow("selected source");
});
test("empty body markup cannot masquerade as a complete Note, while an uncommented restack can", async () => {
  const c = fixture(); c.note.body.html = "<p></p>";
  await expect(new SubstackProvider([c]).resolve(source(c))).resolves.toMatchObject({ quote: { provider: "substack" } });
  delete c.note.quote;
  await expect(new SubstackProvider([c]).resolve(source(c))).rejects.toThrow("Empty complete");
});
test("Substack metadata preserves other providers' article introductions in mixed compositions", async () => {
  const c = fixture(), post = await new SubstackProvider([c]).resolve(source(c));
  const plan = composePlan([post, { provider: "x", id: "7", canonicalUrl: "https://x.com/writer/status/7", author: { handle: "writer" }, text: "Article introduction", article: "# Full article", media: [] }]);
  expect(plan.block.description).toContain("Article introduction");
  expect(plan.block.description).toContain("Substack browser DOM capture observed at:");
});
test("unsafe HTML links cannot become executable Markdown; implicit media fails", async () => {
  const c = fixture(); c.note.body.html = '<p>Hello <a href="javascript:alert(1)">world</a><script>evil()</script></p>';
  const post = await new SubstackProvider([c]).resolve(source(c));
  expect(post.text).toContain("Hello world"); expect(post.text).not.toContain("javascript:"); expect(post.text).not.toContain("evil()");
  for (const tag of ["img", "video", "audio", "iframe", "object"]) {
    c.note.body.html = `<p>Body</p><${tag} src="https://example.com/media"></${tag}>`;
    await expect(new SubstackProvider([c]).resolve(source(c))).rejects.toThrow("explicit attachment");
  }
  c.note.links = [{ kind: "image", role: "attachment", url: "http://example.com/image" }];
  expect(() => normalizeSubstackCapture(c)).toThrow();
});
test("Note URL alone never falls through to undocumented acquisition", async () => {
  await expect(new SocialResolver({ substack: new SubstackProvider([], (async () => new Response(null, { status: 403 })) as unknown as typeof fetch) }).resolve([fixture().sourceUrl])).rejects.toThrow("no authenticated fallback");
});
test("relative body and article excerpt anchors keep their containing source as base", async () => {
  const c = fixture(); c.note.body.html = '<p>See <a href="/@lamblog/note/c-359890078">this Note</a> and <a href="//substack.com/@norvidstudies">this author</a>.</p>';
  c.note.links = [{ kind: "article", role: "linked", url: "https://writer.substack.com/p/article", excerptAuthor: "Writer", excerptHtml: '<p><a href="/p/other">Other article</a></p>' }];
  const post = await new SubstackProvider([c]).resolve(source(c));
  expect(post.text).toContain('[this Note](<https://substack.com/@lamblog/note/c-359890078>)');
  expect(post.text).toContain('[this author](<https://substack.com/@norvidstudies>)');
  expect(post.text).toContain('[Other article](<https://writer.substack.com/p/other>)');
});
test("retained capture provenance must bind the normalized source and author", async () => {
  const c = fixture(); const post = await new SubstackProvider([c]).resolve(source(c));
  expect(() => resolvedPostSchema.parse({ ...post, id: "99" })).toThrow("Mismatched Substack");
  expect(() => resolvedPostSchema.parse({ ...post, author: { handle: "other" } })).toThrow("Mismatched Substack");
});
test("older receiver sees only a version read, including for a nested Substack quote", async () => {
  const c = fixture(), post = await new SubstackProvider([c]).resolve(source(c));
  const plan = composePlan([{ provider: "x", id: "7", canonicalUrl: "https://x.com/writer/status/7", author: { handle: "writer" }, text: "Root", media: [], quote: post }]);
  const reads: string[] = [];
  const fetcher = (async (url: URL | RequestInfo) => { reads.push(String(url)); return Response.json({ version: "old", revision: "legacy", sourceId: "fixture", platform: "fixture", packagePath: null, schemaVersion: 1 }); }) as unknown as typeof fetch;
  await expect(new ArenaBlockClient("https://daemon.example", "fixture", fetcher).publish(plan, ["4622814"])).rejects.toThrow("No save was submitted");
  expect(reads).toEqual(["https://daemon.example/v1/version"]);
});
