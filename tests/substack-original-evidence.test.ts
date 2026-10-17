import { expect, test } from "bun:test";
import { composePlan } from "../packages/core/compose.ts";
import { assignMediaRefs } from "../packages/core/providers/provider.ts";
import { resolvedPostSchema, blockPlanSchema, type ResolvedPost } from "../packages/core/types.ts";

const fixture = await Bun.file(new URL("./fixtures/substack-video-note-plan.json", import.meta.url)).json();
function video(): ResolvedPost { return structuredClone(fixture.sources[0]); }
function nested(): ResolvedPost {
  const quote = video(), note = quote.substackCapture!.note;
  delete quote.substackCapture;
  const url = "https://substack.com/@outer/note/c-400000000";
  const outer = video();
  outer.id = "400000000"; outer.canonicalUrl = url;
  outer.author = { handle: "outer", name: "Outer author" };
  outer.text = "Outer authored prose"; outer.media = []; outer.quote = quote;
  delete outer.quoteCoverage;
  outer.substackCapture = {
    ...outer.substackCapture!, sourceUrl: url,
    note: { url, author: { handle: "outer", name: "Outer author", profileUrl: "https://substack.com/@outer" },
      body: { status: "complete", html: "<p>Outer authored prose</p>" }, links: [],
      quote: { url: note.url, expanded: note } },
  };
  return outer;
}

test("root Note native media uses complete bound attachment evidence", () => {
  const post = video();
  expect(resolvedPostSchema.parse(post)).toEqual(post);
  expect(blockPlanSchema.parse(composePlan([assignMediaRefs(post, 0)]))).toBeDefined();
  for (const key of ["durationSeconds", "width", "height", "posterUrl", "url"] as const) {
    const changed = video(), media = changed.media[0]!;
    if (typeof media[key] === "number") (media as any)[key] = (media[key] as number) + 1;
    else (media as any)[key] = "https://substack.com/another-original";
    expect(() => resolvedPostSchema.parse(changed)).toThrow("complete source record");
  }
  const missing = video(); delete missing.substackCapture!.note.attachmentEvidence;
  expect(() => resolvedPostSchema.parse(missing)).toThrow("complete source record");
});

test("nested Note original is verified against the root retained capture tree", () => {
  const post = nested();
  expect(post.quote!.substackCapture).toBeUndefined();
  expect(resolvedPostSchema.parse(post)).toEqual(post);
  expect(blockPlanSchema.parse(composePlan([assignMediaRefs(post, 0)], { media: "all" }))).toBeDefined();
  for (const mutate of [
    (value: ResolvedPost) => { value.quote!.media[0]!.durationSeconds = 1; },
    (value: ResolvedPost) => { value.quote!.media[0]!.url += "&another=upload"; },
    (value: ResolvedPost) => { delete value.substackCapture; },
    (value: ResolvedPost) => { delete value.substackCapture!.note.quote!.expanded!.attachmentEvidence; },
  ]) {
    const changed = nested(); mutate(changed);
    expect(() => resolvedPostSchema.parse(changed)).toThrow("complete source record");
  }
});

test("a second child capture cannot override contradictory retained root evidence", () => {
  const post = nested(), other = video().substackCapture!;
  other.note.attachmentEvidence!.attachments.forEach(item => { if (item.kind === "video") item.upload.durationSeconds = 1; });
  post.quote!.substackCapture = other;
  expect(() => resolvedPostSchema.parse(post)).toThrow("complete source record");
});

test("unrelated provider media cannot claim Substack original acquisition", () => {
  const post = video(); post.provider = "x"; delete post.substackCapture;
  expect(() => resolvedPostSchema.parse(post)).toThrow("complete source record");
});

test("complete child evidence cannot replace an incomplete retained parent snapshot", () => {
  const post = nested();
  post.substackCapture!.note.quote!.expanded!.body.status = "preview";
  post.quote!.substackCapture = video().substackCapture;
  expect(() => resolvedPostSchema.parse(post)).toThrow("complete source record");
});

test("a native quote cannot skip its retained intervening Note", () => {
  const post = nested(), expanded = post.substackCapture!.note.quote!.expanded!;
  const middleURL = "https://substack.com/@middle/note/c-400000001";
  post.substackCapture!.note.quote = { url: middleURL, expanded: {
    url: middleURL, author: { handle: "middle", name: "Middle author", profileUrl: "https://substack.com/@middle" },
    body: { status: "complete", html: "<p>Middle authored prose</p>" }, links: [],
    quote: { url: expanded.url, expanded },
  } };
  expect(() => resolvedPostSchema.parse(post)).toThrow("complete source record");
});

test("complete multi-level Note quotes retain their exact source path", () => {
  const post = nested(), expanded = post.substackCapture!.note.quote!.expanded!;
  const middleURL = "https://substack.com/@middle/note/c-400000001";
  post.substackCapture!.note.quote = { url: middleURL, expanded: {
    url: middleURL, author: { handle: "middle", name: "Middle author", profileUrl: "https://substack.com/@middle" },
    body: { status: "complete", html: "<p>Middle authored prose</p>" }, links: [],
    quote: { url: expanded.url, expanded },
  } };
  post.quote = { provider: "substack", id: "400000001", canonicalUrl: middleURL,
    author: { handle: "middle", name: "Middle author" }, text: "Middle authored prose", media: [], quote: post.quote };
  expect(resolvedPostSchema.parse(post)).toEqual(post);
  expect(blockPlanSchema.parse(composePlan([assignMediaRefs(post, 0)], { media: "all", quoteDepth: "full" }))).toBeDefined();
});
