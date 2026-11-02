import { expect, test } from "bun:test";
import { RedditProvider } from "../src/providers/reddit.ts";
import { SocialResolver } from "../src/providers/index.ts";
import { parseSource } from "../src/url.ts";
import { composePlan } from "../src/compose.ts";
import { captureRenderRecipe } from "../packages/core/render-recipe.ts";
import { resolvedPostSchema } from "../src/types.ts";
import linuxaudio from "./fixtures/reddit-body-images.json";
const post = { id: "abc", title: "A post", author: "alice", permalink: "/r/test/comments/abc/a_post/", selftext: "Caption", created_utc: 1700000000 };
const image = (id: string) => ({ status: "valid", e: "Image", s: { u: `https://i.redd.it/${id}.jpg?a=1&amp;b=2`, x: 800, y: 600 } });
const gallery = { ...post, gallery_data: { items: [{ media_id: "b", caption: "Second picture" }, { media_id: "a" }] }, media_metadata: { a: image("a"), b: image("b") } };
const provider = (value: unknown) => new RedditProvider(async () => Response.json([{ data: { children: [{ data: value }] } }]));

test("exact linuxaudio share exposes primary and body images to All and explicit selection", async () => {
  const calls: string[] = [];
  const reddit = new RedditProvider(async (url, init) => {
    calls.push(String(url));
    if (init?.method === "HEAD") return new Response(null, { status: 302, headers: { location: `https://www.reddit.com${linuxaudio.post.permalink}` } });
    return Response.json([{ data: { children: [{ data: linuxaudio.post }] } }]);
  });
  const posts = await new SocialResolver({ reddit }).resolve([linuxaudio.provenance.shareURL]);
  const source = posts[0]!;
  expect(calls).toEqual([linuxaudio.provenance.shareURL, linuxaudio.provenance.jsonURL]);
  expect(source.text).toBe(linuxaudio.post.selftext);
  expect(source.media).toEqual([
    { ref: "1.1", id: "fixtureimagea", kind: "image", url: linuxaudio.post.url, width: 1890, height: 1029, alt: "" },
    { ref: "1.2", id: "fixtureimageb", kind: "image", url: linuxaudio.post.media_metadata.fixtureimageb.s.u, width: 1666, height: 937, sourcePlacement: "body", alt: "" },
  ]);
  expect(resolvedPostSchema.parse(source)).toEqual(source);
  expect(composePlan(posts).block.selectedMedia).toEqual(["1.1"]);
  const all = composePlan(posts, { media: "all" });
  expect(all.block.selectedMedia).toEqual(["1.1", "1.2"]);
  expect(all.block.markdown).toBe(linuxaudio.post.selftext);
  expect(all.block.title).toBe(linuxaudio.post.title);
  expect(captureRenderRecipe(all)!.tiles.map(tile => tile.ref)).toEqual(["1.1", "1.2"]);
  const selected = composePlan(posts, { media: "selected", selectedMedia: ["1.2"] });
  expect(selected.block.selectedMedia).toEqual(["1.2"]);
  const reversed = composePlan(posts, { media: "all", mediaOrder: ["1.2", "1.1"] });
  expect(captureRenderRecipe(reversed)!.tiles.map(tile => tile.ref)).toEqual(["1.2", "1.1"]);
  expect(reversed.sources[0]!.media.map(item => item.ref)).toEqual(["1.1", "1.2"]);
});

test("Reddit body assets follow textual order and deduplicate primary, gallery and repeated URL variants", async () => {
  const value = { ...gallery, selftext: "https://preview.redd.it/a.jpg?width=100\n![first](https://i.redd.it/c.png)\nhttps://preview.redd.it/c.png?width=200\n![img](d)\nhttps://example.com/page", media_metadata: { ...gallery.media_metadata, c: image("c"), d: image("d"), orphan: image("orphan") } };
  const result = await provider(value).resolve(parseSource("https://redd.it/abc"));
  expect(result.media.map(item => item.id)).toEqual(["b", "a", "c", "d"]);
  expect(result.media.map(item => item.sourcePlacement)).toEqual([undefined, undefined, "body", "body"]);
  expect(result.media[2]!.alt).toBe("first");
  expect(result.mediaIssues).toBeUndefined();
  expect(result.text).toStartWith(value.selftext);
  const bare = await provider({ ...post, selftext: "https://preview.redd.it/plain.png?width=10&amp;format=png" }).resolve(parseSource("https://redd.it/abc"));
  expect(bare.media[0]!.url).toBe("https://preview.redd.it/plain.png?width=10&format=png");
});

test("missing, unavailable, unsupported and unsafe body images stay explicit without losing the primary", async () => {
  const cases = [
    { text: "![img](missing)", metadata: {}, status: "missing_metadata" },
    { text: "![img](pending)", metadata: { pending: { status: "unprocessed" } }, status: "unavailable" },
    { text: "![img](missingurl)", metadata: { missingurl: { status: "valid", e: "Image", s: {} } }, status: "unavailable" },
    { text: "![img](video)", metadata: { video: { status: "valid", e: "AnimatedImage", s: { mp4: "https://i.redd.it/video.mp4" } } }, status: "unsupported" },
    { text: "https://user@preview.redd.it/unsafe.png", metadata: {}, status: "unsafe_url" },
    { text: "https://preview.redd.it:8443/unsafe.png", metadata: {}, status: "unsafe_url" },
    { text: "https://preview.redd.it/bad.png", metadata: { bad: { status: "valid", e: "Image", s: { u: "https://example.com/bad.png" } } }, status: "unsafe_url" },
    { text: "![external](https://example.com/picture.png)", metadata: {}, status: "unsupported" },
  ] as const;
  for (const item of cases) {
    const posts = await new SocialResolver({ reddit: provider({ ...post, post_hint: "image", url: "https://i.redd.it/primary.png", selftext: item.text, media_metadata: item.metadata }) }).resolve(["https://redd.it/abc"]);
    expect(posts[0]!.media).toHaveLength(1);
    expect(posts[0]!.mediaIssues?.[0]?.status).toBe(item.status);
    expect(resolvedPostSchema.parse(posts[0]).mediaIssues).toEqual(posts[0]!.mediaIssues);
    expect(composePlan(posts).block.selectedMedia).toEqual(["1.1"]);
    expect(() => composePlan(posts, { media: "all" })).toThrow(`is ${item.status}`);
    expect(composePlan(posts, { media: "selected", selectedMedia: ["1.1"] }).block.selectedMedia).toEqual(["1.1"]);
    expect(() => composePlan(posts, { media: "selected", selectedMedia: ["1.2"] })).toThrow("references do not exist");
  }
});

test("Reddit URLs canonicalize shares, short IDs and post permalinks and comment permalinks", () => {
  for (const url of ["https://redd.it/abc", "https://old.reddit.com/r/test/comments/abc/title/?x=1", "https://www.reddit.com/gallery/abc"]) expect(parseSource(url).id).toBe("abc");
  expect(parseSource("https://www.reddit.com/r/test/s/AbCd")).toMatchObject({ short: true });
  for (const url of ["http://reddit.com/comments/abc", "https://user@reddit.com/comments/abc", "https://reddit.com/r/test/"]) expect(() => parseSource(url)).toThrow();
});
test("gallery order, selftext, captions and arbitrary selection survive composition", async () => {
  const posts = await new SocialResolver({ reddit: provider(gallery) }).resolve(["https://redd.it/abc"]);
  expect(posts[0]!.media.map(m => m.id)).toEqual(["b", "a"]);
  expect(posts[0]!.media[0]!.url).toContain("&b=2");
  const plan = composePlan(posts);
  expect(plan.block.title).toBe("A post");
  expect(plan.block.markdown).toContain("Caption\n\n1. Second picture");
  expect(plan.block.selectedMedia).toEqual(["1.1", "1.2"]);
  expect(composePlan(posts, { media: "selected", selectedMedia: ["1.2"] }).block.selectedMedia).toEqual(["1.2"]);
  expect(composePlan(posts, { media: "none" }).block.markdown).toBe(`${plan.block.markdown}\n\n*[images]*`);
});
test("missing selftext is incomplete while an explicitly empty body is valid", async () => {
  const longBody = `First paragraph\n\n${"Body text. ".repeat(600)}\n\nUnique final line.`;
  const full = await provider({ ...post, selftext: longBody }).resolve(parseSource("https://redd.it/abc"));
  expect(full.text).toBe(longBody);
  expect((await provider({ ...post, selftext: "" }).resolve(parseSource("https://redd.it/abc"))).text).toBe("");
  const { selftext: _omitted, ...incomplete } = post;
  await expect(provider(incomplete).resolve(parseSource("https://redd.it/abc")))
    .rejects.toThrow("omitted a usable selftext field; full content cannot be verified");
  await expect(provider({ ...post, selftext: null }).resolve(parseSource("https://redd.it/abc")))
    .rejects.toThrow("omitted a usable selftext field; full content cannot be verified");
});
test("cross-posts retain their source and author while exposing parent attachments", async () => {
  const value = { ...post, id: "xyz", permalink: "/r/other/comments/xyz/title/", author: "bob", crosspost_parent_list: [gallery] };
  const result = await provider(value).resolve(parseSource("https://redd.it/xyz"));
  expect(result.canonicalUrl).toContain("/xyz/");
  expect(result.author.handle).toBe("u/bob");
  expect(result.quote?.author.handle).toBe("u/alice");
  expect(result.media).toHaveLength(2);
  const posts = await new SocialResolver({ reddit: provider(value) }).resolve(["https://redd.it/xyz"]);
  expect(composePlan(posts).block.markdown).not.toContain("*[");
});
test("short links expand before a live JSON read and identities are checked", async () => {
  const calls: string[] = [];
  const resolver = new RedditProvider(async (url, init) => {
    calls.push(String(url));
    expect(init?.signal).toBeDefined();
    if (calls.length === 1) return new Response(null, { status: 302, headers: { location: "https://www.reddit.com/r/test/comments/abc/title/?tracking=1" } });
    return Response.json([{ data: { children: [{ data: post }] } }]);
  });
  expect((await resolver.resolve(parseSource("https://reddit.com/r/test/s/SHARE"))).id).toBe("abc");
  expect(calls).toEqual(["https://www.reddit.com/r/test/s/SHARE", "https://www.reddit.com/comments/abc.json?raw_json=1"]);
  await expect(provider(post).resolve(parseSource("https://redd.it/other"))).rejects.toThrow("different post");
});
test("unavailable gallery entries and removed posts fail without silently dropping content", async () => {
  for (const value of [{ ...gallery, media_metadata: {} }, { ...post, removed_by_category: "deleted" }]) await expect(provider(value).resolve(parseSource("https://redd.it/abc"))).rejects.toThrow();
});
test("a blocked live read stops without consulting an archive or claiming deletion", async () => {
  const calls: string[] = [];
  const resolver = new RedditProvider(async url => {
    calls.push(String(url));
    if (calls.length === 1) return new Response(null, { status: 403 });
    return Response.json({ data: [{ id: "1wzw8zd", title: "A post", author: "source-author",
      permalink: "/r/ClaudeAI/comments/1wzw8zd/a_post/", selftext: "[removed]", created_utc: 1700000000,
      removed_by_category: "automod_filtered" }] });
  });
  await expect(resolver.resolve(parseSource("https://www.reddit.com/r/ClaudeAI/comments/1wzw8zd/a_post/")))
    .rejects.toThrow("live post read returned HTTP 403; current content cannot be verified. No archive or block creation was attempted");
  expect(calls).toEqual(["https://www.reddit.com/comments/1wzw8zd.json?raw_json=1"]);
});

test("an unavailable live server cannot infer a current deletion from an archive", async () => {
  const calls: string[] = [];
  const resolver = new RedditProvider(async url => { calls.push(String(url)); return String(url).includes("arctic-shift")
    ? Response.json({ data: [{ id: "1wzw8zd", title: "A post", author: "source-author",
      permalink: "/r/ClaudeAI/comments/1wzw8zd/a_post/", selftext: "[removed]", created_utc: 1700000000,
      removed_by_category: "automod_filtered" }] })
    : new Response(null, { status: 503 }); });
  await expect(resolver.resolve(parseSource("https://www.reddit.com/r/ClaudeAI/comments/1wzw8zd/a_post/")))
    .rejects.toThrow("live post read returned HTTP 503 without a usable post; current content cannot be verified");
  expect(calls).toEqual(["https://www.reddit.com/comments/1wzw8zd.json?raw_json=1"]);
});
test("native video uses HLS to retain audio instead of the silent fallback", async () => {
  const result = await provider({ ...post, secure_media: { reddit_video: { hls_url: "https://v.redd.it/abc/HLSPlaylist.m3u8", fallback_url: "https://v.redd.it/abc/DASH_720.mp4", has_audio: true, width: 720, height: 1280 } } }).resolve(parseSource("https://redd.it/abc"));
  expect(result.media[0]!.url).toEndWith(".m3u8");
});

test("incomplete galleries stop without bot-facing embed requests or guessed originals", async () => {
  const incomplete = { ...gallery, media_metadata: { a: image("a"), b: { status: "unprocessed" } } };
  const calls: string[] = [];
  const resolver = new RedditProvider(async url => {
    calls.push(String(url));
    return Response.json([{ data: { children: [{ data: incomplete }] } }]);
  });
  await expect(resolver.resolve(parseSource("https://redd.it/abc"))).rejects.toThrow("gallery item b is unavailable");
  expect(calls).toEqual(["https://www.reddit.com/comments/abc.json?raw_json=1"]);
});
test("root attachments are depicted consistently across providers even with media none", () => {
  for (const provider of ["x", "bluesky", "mastodon", "reddit"] as const) {
    const result = composePlan([{ provider, id: "1", canonicalUrl: "https://example.com", author: { handle: "alice" }, text: "Caption", media: [
      { ref: "1.1", kind: "image", url: "https://example.com/a.jpg", alt: "" },
      { ref: "1.2", kind: "video", url: "https://example.com/a.mp4", alt: "" },
    ] }], { media: "none" });
    expect(result.block.markdown).toBe("Caption\n\n*[image, video]*");
  }
});

const comment = { id: "def", link_id: "t3_abc", author: "alice", body: "`code`\n\n> Quoted text", permalink: "/r/test/comments/abc/title/def/", created_utc: 1700000000 };
test("Reddit comments expand from shares and compose with author, parent title and timestamp", async () => {
  const resolver = new RedditProvider(async url => {
    if (String(url).includes("/s/")) return new Response(null, { status: 302, headers: { location: "https://reddit.com/r/test/comments/abc/comment/def/?context=3" } });
    return Response.json({ data: { children: [{ data: String(url).includes("t1_") ? comment : post }] } });
  });
  const result = await resolver.resolve(parseSource("https://reddit.com/r/test/s/SHARE"));
  const plan = composePlan([result], { media: "all" });
  expect(plan.block.kind).toBe("text");
  expect(plan.block.title).toBe('Comment by /u/alice on “A post”');
  expect(plan.block.markdown).toBe(comment.body);
  expect(plan.block.description).toBe("Posted at: 2023-11-14T22:13:20.000Z");
  expect(plan.block.canonicalSource).toBe(`https://www.reddit.com${comment.permalink}`);
});
test("comment media is explicit instead of silently becoming text-only", async () => {
  const resolve = (changes: Record<string, unknown>) => new RedditProvider(async url => Response.json({
    data: { children: [{ data: String(url).includes("t1_") ? { ...comment, ...changes } : post }] },
  })).resolve(parseSource("https://reddit.com/r/test/comments/abc/title/def/"));
  for (const body of [
    "Watch https://v.redd.it/clip/HLSPlaylist.m3u8",
    "![gif](giphy|clip)",
  ]) await expect(resolve({ body })).rejects.toThrow("Reddit comment media is unsupported");
  await expect(resolve({ media_metadata: { picture: { status: "valid" } } }))
    .rejects.toThrow("Reddit comment media is unsupported");
  await expect(resolve({ media_metadata: { picture: { status: "unprocessed" } } }))
    .rejects.toThrow("Reddit comment media is unavailable");
  await expect(resolve({ media: { reddit_video: { id: "clip" } } }))
    .rejects.toThrow("Reddit comment media is unsupported");
  const illustrated = await resolve({ body: "Read this ![img](https://preview.redd.it/picture.png)" });
  expect(illustrated.media[0]?.url).toBe("https://preview.redd.it/picture.png");
  const plain = await resolve({ body: "A text reply with https://example.com/article", media_metadata: {} });
  expect(plain.text).toBe("A text reply with https://example.com/article");
  expect(plain.media).toEqual([]);
  expect(plain.storyTitle).toBe(post.title);
});
test("unavailable comment metadata stops before consulting an archive or parent", async () => {
  const calls: string[] = [];
  const resolver = new RedditProvider(async url => { calls.push(String(url)); return String(url).includes("/api/info") ? new Response(null, { status: 503 }) : Response.json({ data: [String(url).includes("/comments/ids") ? comment : post] }); });
  await expect(resolver.resolve(parseSource("https://reddit.com/r/test/comments/abc/title/def/")))
    .rejects.toThrow("live metadata read returned HTTP 503 without usable content; current content cannot be verified");
  expect(calls).toEqual(["https://www.reddit.com/api/info.json?id=t1_def&raw_json=1"]);
});
test("a blocked live comment lookup stops before the archive", async () => {
  const calls: string[] = [];
  const resolver = new RedditProvider(async url => {
    calls.push(String(url));
    return new Response(null, { status: 403 });
  });
  await expect(resolver.resolve(parseSource("https://reddit.com/r/test/comments/abc/title/def/")))
    .rejects.toThrow("live metadata read returned HTTP 403; current content cannot be verified. No archive or block creation was attempted");
  expect(calls).toEqual(["https://www.reddit.com/api/info.json?id=t1_def&raw_json=1"]);
});
test("rejects removed comments and mismatched comment identities", async () => {
  for (const changes of [{ body: "[deleted]" }, { id: "wrong" }, { link_id: "t3_wrong" }, { permalink: "/comments/abc/comment/other/" }]) {
    const resolver = new RedditProvider(async () => Response.json({ data: { children: [{ data: { ...comment, ...changes } }] } }));
    await expect(resolver.resolve(parseSource("https://reddit.com/comments/abc/comment/def/"))).rejects.toThrow();
  }
});
