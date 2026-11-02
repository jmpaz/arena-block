import { expect, test } from "bun:test";
import { articleMarkdown } from "../src/providers/x-article.ts";

const block = (text: string, type = "unstyled", extra = {}) => ({ text, type, ...extra });
const article = (blocks: unknown[], entityMap: unknown = []) => ({ title: "An article", content: { blocks, entityMap } });

test("preserves headings, paragraphs, lists, quotations and literal markup", () => {
  const result = articleMarkdown(article([
    block("First <script> & text"), block("One", "ordered-list-item"), block("Two", "ordered-list-item"),
    block("Section", "header-two"), block("A\nB", "blockquote"), block("const x = 1;", "code-block"),
  ]));
  expect(result).toStartWith("# An article\n\nFirst <script> & text");
  expect(result).toContain("1.  One\n2.  Two");
  expect(result).toContain("## Section");
  expect(result).toContain("> A");
  expect(result).toContain("```\nconst x = 1;\n```");
});

test("preserves overlapping emphasis and links with code point offsets", () => {
  const result = articleMarkdown(article([block("😀 Read this now", "unstyled", {
    entityRanges: [{ key: 0, offset: 2, length: 9 }],
    inlineStyleRanges: [{ style: "Bold", offset: 2, length: 10 }],
  })], [{ key: "0", value: { type: "LINK", data: { url: "https://example.com" } } }]));
  expect(result).toContain("😀 [**Read this**](https://example.com) now");
});

test("never splits an emoji when ranges follow or surround one", () => {
  const result = articleMarkdown(article([block("Billy (🇦🇺): see here", "blockquote", {
    entityRanges: [{ key: 0, offset: 0, length: 7 }, { key: 1, offset: 7, length: 2 }, { key: 0, offset: 9, length: 1 }, { key: 2, offset: 16, length: 4 }],
  })], {
    "0": { type: "LINK", data: { url: "https://x.com/billy" } },
    "1": { type: "TWEMOJI", data: { url: "https://abs.twimg.com/emoji/v2/svg/1f1e6-1f1fa.svg" } },
    "2": { type: "LINK", data: { url: "https://example.com" } },
  }));
  expect(result).toBe("# An article\n\n> [Billy (](https://x.com/billy)🇦🇺[)](https://x.com/billy): see [here](https://example.com)");
  expect(result).not.toMatch(/\p{Cs}/u);
});

test("unwraps links that cover only the whitespace between emoji", () => {
  const result = articleMarkdown(article([block("Michał 🌐 🇪🇺: hi", "blockquote", {
    entityRanges: [{ key: 0, offset: 0, length: 6 }, { key: 0, offset: 8, length: 1 }],
  })], { "0": { type: "LINK", data: { url: "https://x.com/m" } } }));
  expect(result).toBe("# An article\n\n> [Michał](https://x.com/m) 🌐 🇪🇺: hi");
});

test("keeps Twemoji-annotated emoji as text and names unsupported inline entities", () => {
  const value = (type: string) => article([block("Goat Coder 👑: Frontend design?", "blockquote", {
    entityRanges: [{ key: 0, offset: 11, length: 1 }],
  })], [{ key: "0", value: { type, data: { url: "https://abs.twimg.com/emoji/v2/svg/1f451.svg" } } }]);
  expect(articleMarkdown(value("TWEMOJI"))).toBe("# An article\n\n> Goat Coder 👑: Frontend design?");
  expect(() => articleMarkdown(value("POLL"))).toThrow("Unsupported x.com article inline entity: POLL");
});

test("leaves bare URLs bare and retains inline media in reading order", () => {
  const value = article([
    block("https://example.com", "unstyled", { entityRanges: [{ key: 0, offset: 0, length: 19 }] }),
    block(" ", "atomic", { entityRanges: [{ key: 1, offset: 0, length: 1 }] }), block("After"),
  ], { "0": { type: "LINK", data: { url: "https://example.com" } }, "1": { type: "MEDIA", data: { mediaItems: [{ mediaId: "42" }] } } });
  const result = articleMarkdown({ ...value, media_entities: [{ media_id: "42", media_info: { original_img_url: "https://example.com/image.jpg" } }] });
  expect(result).toBe("# An article\n\nhttps://example.com\n\n![](https://example.com/image.jpg)\n\nAfter");
});

test("rejects previews, missing media, and unsafe links instead of silently losing content", () => {
  expect(() => articleMarkdown({ title: "Preview", preview_text: "Incomplete" })).toThrow();
  expect(() => articleMarkdown(article([block(" ", "atomic", { entityRanges: [{ key: 1, offset: 0, length: 1 }] })]))).toThrow();
  expect(() => articleMarkdown(article([block("link", "unstyled", { entityRanges: [{ key: 0, offset: 0, length: 4 }] })], { "0": { type: "LINK", data: { url: "javascript:alert(1)" } } }))).toThrow("Invalid x.com article resource URL");
});

test("preserves video links, captions, raw Swift code, dividers and embedded tweets", () => {
  const code = '```swift\nlet x = "<tag>"\n\n// Keep spacing\n```';
  const atomic = (key: number) => block(" ", "atomic", { entityRanges: [{ key, offset: 0, length: 1 }] });
  const value = article([atomic(0), atomic(1), atomic(2), atomic(3)], {
    "0": { type: "MEDIA", data: { mediaItems: [{ mediaId: "42" }], caption: "Full app experience" } },
    "1": { type: "MARKDOWN", data: { markdown: code } },
    "2": { type: "DIVIDER", data: {} },
    "3": { type: "TWEET", data: { tweetId: "123" } },
  });
  const result = articleMarkdown({ ...value, media_entities: [{ media_id: "42", media_info: { variants: [
    { content_type: "application/x-mpegURL", url: "https://example.com/stream.m3u8" },
    { content_type: "video/mp4", bit_rate: 100, url: "https://example.com/low.mp4" },
    { content_type: "video/mp4", bit_rate: 200, url: "https://example.com/high.mp4" },
  ] } }] });
  expect(result).toContain("[Video](https://example.com/high.mp4)\n\nFull app experience");
  expect(result).toContain(code);
  expect(result).toContain("* * *");
  expect(result).toEndWith("https://x.com/i/status/123");
  expect(result.indexOf(code)).toBeGreaterThan(result.indexOf("Full app experience"));
});
