import { describe, expect, test } from "bun:test";
import { atprotoMarkdown, atprotoPostFromView, BLUESKY, DELVE } from "../packages/core/providers/atproto-post.ts";
import { BlueskyProvider } from "../packages/core/providers/bluesky.ts";
import { composePlan, planHash } from "../packages/core/compose.ts";
import { parseSource } from "../packages/core/url.ts";
import { blockPlanSchema, type ResolvedPost } from "../packages/core/types.ts";

const did = "did:plc:abcdefghijklmnopqrstuvwx";
const bytes = (value: string) => new TextEncoder().encode(value).length;
function source(app: typeof BLUESKY, label: string, uri: string, before = "", after = "", id = "a"): ResolvedPost {
  const text = before + label + after;
  return atprotoPostFromView({ uri: `at://${did}/${app.namespace}.feed.post/${id}`, cid: `cid-${id}`,
    author: { did, handle: "explicit.author.test" }, record: { $type: `${app.namespace}.feed.post`, text,
      createdAt: "2026-10-12T00:00:00Z", facets: [{ index: { byteStart: bytes(before), byteEnd: bytes(before + label) },
        features: [{ $type: `${app.namespace}.richtext.facet#link`, uri }] }] } }, app);
}

for (const app of [BLUESKY, DELVE]) describe(`${app.provider} facet rendering`, () => {
  test.each([
    ["reference.example/ref_...", "https://reference.example/ref_002"],
    ["https://example.com/long…", "https://example.com/longer?source=1"],
    ["EXAMPLE.com/doc...", "https://example.com/document"],
    ["example.com/doc...", "https://www.example.com/document"],
    ["https://exa...", "https://example.com/document"],
    ["example.com/", "https://example.com/"],
    ["example.com/path", "https://example.com/path"],
    ["example.com/文…", "https://example.com/文書"],
    ["例え.テスト/文…", "https://例え.テスト/文書"],
    ["example.com/a%2f...", "https://example.com/a%2Fmore"],
  ])("expands a verified URL display %s", (label, uri) => {
    const post = source(app, label, uri, "👩🏽‍💻 café 界 — ", "\n\nNext paragraph.");
    const snapshot = JSON.stringify(post), full = new URL(uri).href;
    const html = Bun.markdown.html(atprotoMarkdown(post));
    const escaped = full.replaceAll("&", "&amp;");
    expect(html).toContain(`href="${escaped}"`);
    expect(html).toContain(`>${escaped}</a>`);
    expect(html).toContain("👩🏽‍💻 café 界 — ");
    expect(html).toContain("Next paragraph.");
    expect(JSON.stringify(post)).toBe(snapshot);
    expect(post.text).toContain(label);
  });

  test.each([
    ["Read the full paper", "https://example.com/paper"],
    ["README.md", "https://github.com/example/project/blob/main/README.md"],
    ["example.com", "https://example.com/article"],
    ["example.com/path", "https://example.com/path?tracking=1"],
    ["example.com/other...", "https://example.com/article"],
    ["http://example.com/p...", "https://example.com/paper"],
    ["example.com.evil...", "https://example.com/document"],
    ["Read...", "https://reader.example/document"],
    ["2.0...", "https://2.0.0.0/notes"],
    [" contact@example.com ", "mailto:contact@example.com"],
  ])("keeps meaningful or ambiguous label %s clickable", (label, uri) => {
    const post = source(app, label, uri);
    expect(atprotoMarkdown(post)).toBe(`[${label}](<${new URL(uri).href}>)`);
    expect(post.text).toBe(label);
    expect(post.atproto!.record.facets).toEqual(post.facets);
  });

  test("escapes literal label markup and destination syntax without changing source", () => {
    const label = "<em>Read [docs]</em> &copy; *now* `literal`";
    const post = source(app, label, "https://example.com/p?a=1&b=2");
    const markdown = atprotoMarkdown(post), html = Bun.markdown.html(markdown);
    expect(html).toContain('href="https://example.com/p?a=1&amp;b=2"');
    expect(html).toContain("&lt;em&gt;Read [docs]&lt;/em&gt; &amp;copy; *now* `literal`");
    expect(html).not.toContain("<em>");
    expect(post.text).toBe(label);
    const destination = source(app, "Details", "https://example.com/p?q=\\*<br> value");
    const output = Bun.markdown.html(atprotoMarkdown(destination));
    expect(output).toContain("%5C*%3Cbr%3E%20value");
    expect(output).not.toContain("<br>");
  });

  test("preserves paragraph boundaries within a meaningful facet label", () => {
    const post = source(app, "First label\n\nSecond label", "https://example.com/paper");
    expect(atprotoMarkdown(post)).toBe("[First label](<https://example.com/paper>)\n\n[Second label](<https://example.com/paper>)");
    expect(Bun.markdown.html(atprotoMarkdown(post)).match(/<a /g)).toHaveLength(2);
    expect(post.text).toBe("First label\n\nSecond label");
  });

  test("retains authored mention names, literal tags, and unknown metadata", () => {
    const post = source(app, "@old.name #tag", "https://example.com");
    post.facets = [
      { index: { byteStart: 0, byteEnd: 9 }, features: [{ $type: `${app.namespace}.richtext.facet#mention`, did }] },
      { index: { byteStart: 10, byteEnd: 14 }, features: [{ $type: `${app.namespace}.richtext.facet#tag`, tag: "tag" }] },
    ];
    expect(atprotoMarkdown(post)).toBe(`[@old.name](<${app.origin}/profile/${did}>) #tag`);
    post.facets[0]!.features = [{ $type: "other.richtext.facet#link", uri: "https://wrong.example" },
      { $type: `${app.namespace}.richtext.facet#mention`, did }];
    expect(atprotoMarkdown(post)).toBe(`[@old.name](<${app.origin}/profile/${did}>) #tag`);
    post.facets[0]!.features = [{ $type: "other.richtext.facet#mention", did }];
    expect(atprotoMarkdown(post)).toBe("@old.name #tag");
  });

  test("retains lexicon-permitted empty annotations without inserting or deleting text", () => {
    const post = source(app, "example.com/p...", "https://example.com/paper");
    post.facets![0]!.features = [];
    post.facets!.push({ index: { byteStart: 0, byteEnd: 0 }, features: [{ $type: `${app.namespace}.richtext.facet#link`, uri: "https://example.com/empty" }] });
    expect(atprotoMarkdown(post)).toBe(post.text);
    expect(blockPlanSchema.parse(composePlan([post])).sources[0]!.facets).toEqual(post.facets);
  });

  test.each(["inside-utf8", "overlap", "backward", "past-end", "noninteger", "missing-features", "conflicting"])(
    "rejects %s annotations without modifying the post", variant => {
      const post = source(app, "example.com/p...", "https://example.com/paper", "👋 ");
      if (variant === "inside-utf8") post.facets![0]!.index.byteStart = 1;
      if (variant === "overlap") post.facets!.push(structuredClone(post.facets![0]!));
      if (variant === "backward") post.facets![0]!.index.byteEnd = 4;
      if (variant === "past-end") post.facets![0]!.index.byteEnd = bytes(post.text) + 1;
      if (variant === "noninteger") post.facets![0]!.index.byteStart = 5.5;
      if (variant === "missing-features") (post.facets![0] as any).features = undefined;
      if (variant === "conflicting") post.facets![0]!.features.push({ $type: `${app.namespace}.richtext.facet#link`, uri: "https://other.example" });
      const snapshot = JSON.stringify(post);
      expect(() => atprotoMarkdown(post)).toThrow(/facet|destinations/i);
      expect(JSON.stringify(post)).toBe(snapshot);
    });

  test.each(["javascript:alert(1)", "data:text/html,test", "https://user:password@example.com", "https://ex\nample.com/paper", " https://example.com/paper"])("rejects unsupported destination %s", uri => {
    expect(() => atprotoMarkdown(source(app, "Details", uri))).toThrow("destination");
  });

  test("preserves explicit authors, quote structure and source metadata through composition", () => {
    const root = source(app, "example.com/p...", "https://example.com/paper");
    root.quote = { ...source(app, "Research notes", "https://example.com/notes", "", "", "b"), author: { handle: "quoted.author.test" } };
    const snapshot = JSON.stringify(root), plan = composePlan([root]);
    expect(plan.block.title).toBe("Post by @explicit.author.test");
    expect(plan.block.markdown).toContain("`@quoted.author.test`");
    expect(plan.block.markdown).toContain("[Research notes](<https://example.com/notes>)");
    expect(plan.block.markdown).toContain("[https://example.com/paper](<https://example.com/paper>)");
    expect(JSON.stringify(root)).toBe(snapshot);
    expect(blockPlanSchema.parse(plan)).toEqual(plan);
    const { hash, ...content } = plan; expect(planHash(content)).toBe(hash);
    expect(composePlan([root], { quote: "omit" }).block.markdown).not.toContain("Research notes");
  });

  test("nested facet snippets retain author attribution, selected mixed-source images and separators", () => {
    const root = source(app, "example.com/p...", "https://example.com/paper");
    root.quote = { ...source(app, "Research notes", "https://example.com/notes", "", "", "b"), author: { handle: "middle.author.test" },
      quote: { ...source(app, "example.com/e...", "https://example.com/evidence", "", "", "c"), author: { handle: "original.author.test" } } };
    root.media = [{ ref: "1.1", kind: "image", url: "https://example.com/root.jpg", alt: "Root image" }];
    const extra: ResolvedPost = { provider: "x", id: "extra", canonicalUrl: "https://x.com/extra/status/123", author: { handle: "extra" },
      text: "Supplementary prose stays out", media: [{ ref: "2.1", kind: "image", url: "https://example.com/extra.jpg", alt: "Extra image" }] };
    const snapshot = JSON.stringify([root, extra]);
    const plan = composePlan([root, extra], { media: "all", mediaOnlyPosts: [2], mediaOrder: ["2.1", "1.1"], quoteDepth: "full" });
    expect(plan.block.selectedMedia).toEqual(["2.1", "1.1"]);
    expect(plan.block.markdown).toContain("> > `@original.author.test`");
    expect(plan.block.markdown).toContain("> `@middle.author.test`");
    expect(plan.block.markdown).toContain("[https://example.com/evidence](<https://example.com/evidence>)");
    expect(plan.block.markdown).toContain("[Research notes](<https://example.com/notes>)");
    expect(plan.block.markdown).not.toContain(extra.text);
    expect(JSON.stringify([root, extra])).toBe(snapshot);
    const tail = source(app, "Follow-up notes", "https://example.com/followup", "", "", "tail");
    const sequence = composePlan([root, tail], { quote: "sequence", quoteDepth: "full", separator: "always" });
    expect(sequence.block.markdown).toContain("\n\n---\n\n");
  });
});

test("does not infer facet semantics for other providers or record collections", () => {
  const post = source(BLUESKY, "example.com/p...", "https://example.com/paper");
  expect(atprotoMarkdown({ ...post, provider: "x", atproto: undefined })).toBe(post.text);
  expect(() => atprotoMarkdown({ ...post, atproto: { ...post.atproto!, record: { $type: "other.feed.post" } } })).toThrow("supported post record");
  expect(atprotoMarkdown({ ...post, article: "Edited article" })).toBe("Edited article");
});

test("Bluesky acquisition retains facets and exact record provenance for primary and quoted posts", async () => {
  const quoted = { uri: `at://${did}/app.bsky.feed.post/b`, cid: "cid-b", author: { did, handle: "quoted.author.test" },
    value: { $type: "app.bsky.feed.post", text: "Research notes", createdAt: "2026-10-12T00:00:00Z", facets: [
      { index: { byteStart: 0, byteEnd: 14 }, features: [{ $type: "app.bsky.richtext.facet#link", uri: "https://example.com/notes" }] }] } };
  const primary = { uri: `at://${did}/app.bsky.feed.post/a`, cid: "cid-a", author: { did, handle: "explicit.author.test" },
    record: { $type: "app.bsky.feed.post", text: "example.com/p...", createdAt: "2026-10-12T00:00:00Z", facets: [
      { index: { byteStart: 0, byteEnd: 16 }, features: [{ $type: "app.bsky.richtext.facet#link", uri: "https://example.com/paper" }] }] },
    embed: { $type: "app.bsky.embed.record#view", record: quoted } };
  const original = globalThis.fetch;
  globalThis.fetch = (async (_input: URL | RequestInfo) => Response.json({ thread: { post: primary } })) as typeof fetch;
  try {
    const resolved = await new BlueskyProvider().resolve(parseSource("https://bsky.app/profile/explicit.author.test/post/a"));
    expect(resolved.text).toBe(primary.record.text);
    expect(resolved.atproto).toMatchObject({ uri: primary.uri, cid: primary.cid, authorDid: did, record: primary.record });
    expect(resolved.quote!.atproto!.record).toEqual(quoted.value);
    expect(resolved.author.handle).toBe("explicit.author.test");
    expect(resolved.quote!.author.handle).toBe("quoted.author.test");
    expect(composePlan([resolved]).block.markdown).toContain("[Research notes](<https://example.com/notes>)");
  } finally { globalThis.fetch = original; }
});
