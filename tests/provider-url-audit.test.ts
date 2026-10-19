import { expect, test } from "bun:test";
import { parseSource } from "../packages/core/url.ts";
import { explicitSelections } from "../packages/core/source-selection.ts";

test.each([
  ["https://x.com/writer/status/123?tracking=1", "x", "https://x.com/writer/status/123"],
  ["https://bsky.app/profile/writer.test/post/3abc", "bluesky", "https://bsky.app/profile/writer.test/post/3abc"],
  ["at://did:plc:writer/app.bsky.feed.post/3abc", "bluesky", "https://bsky.app/profile/did:plc:writer/post/3abc"],
  ["https://delve.town/profile/writer.test/post/3abc", "delve", "https://delve.town/profile/writer.test/post/3abc"],
  ["https://example.social/@writer/123", "mastodon", "https://example.social/@writer/123"],
  ["https://substack.com/@writer/note/c-123", "substack", "https://substack.com/@writer/note/c-123"],
  ["https://writer.substack.com/p/article", "substack", "https://writer.substack.com/p/article"],
  ["https://www.reddit.com/r/test/comments/abc123/title/def456/", "reddit", "https://www.reddit.com/comments/abc123/comment/def456/"],
  ["https://www.reddit.com/r/test/s/Share123", "reddit", "https://www.reddit.com/r/test/s/Share123"],
  ["https://www.reddit.com/gallery/abc123", "reddit", "https://www.reddit.com/comments/abc123/"],
  ["https://www.lesswrong.com/posts/Post123/title#CommentABC12345", "forum_magnum", "https://www.lesswrong.com/posts/Post123/?commentId=CommentABC12345"],
  ["https://www.lesswrong.com/posts/Post123/title", "forum_magnum", "https://www.lesswrong.com/posts/Post123/"],
  ["https://www.tiktok.com/@writer/video/123", "tiktok", "https://www.tiktok.com/@writer/video/123"],
  ["https://vm.tiktok.com/Share123/", "tiktok", "https://vm.tiktok.com/Share123/"],
  ["https://www.instagram.com/reel/ABC123/", "instagram", "https://www.instagram.com/reel/ABC123/"],
  ["https://www.are.na/block/123", "arena", "https://www.are.na/block/123"],
  ["https://soundcloud.com/artist/track?si=tracking", "soundcloud", "https://soundcloud.com/artist/track"],
  ["https://soundcloud.com/artist/sets/playlist", "soundcloud", "https://soundcloud.com/artist/sets/playlist"],
  ["https://news.ycombinator.com/item?id=123", "hackernews", "https://news.ycombinator.com/item?id=123"],
  ["https://lobste.rs/s/story1/title", "lobsters", "https://lobste.rs/s/story1"],
  ["https://lobste.rs/s/story1/title#c_comment1", "lobsters", "https://lobste.rs/c/comment1"],
])("keeps the source identity for %s", (input, provider, canonical) => {
  expect(parseSource(input!)).toMatchObject({ provider, canonicalUrl: canonical });
});

test.each(["https://x.com/writer", "https://bsky.app/profile/writer.test", "https://bsky.app/profile/writer.test/post/abc/extra",
  "https://bsky.app/profile/writer%2Fother/post/abc", "https://bsky.app/profile/writer.test/post/bad%2Fid", "https://delve.town/profile/writer.test",
  "https://substack.com/@writer", "https://www.lesswrong.com/", "https://www.reddit.com/r/test/", "https://www.tiktok.com/@writer",
  "https://www.instagram.com/writer/", "https://soundcloud.com/artist", "https://soundcloud.com/artist/likes",
  "https://news.ycombinator.com/", "https://lobste.rs/", "https://www.are.na/josh-pazmino/channel"])
("does not infer a selected source from profile, collection or malformed URL %s", input => {
  expect(() => parseSource(input)).toThrow();
});

test("share tokens do not stand in for globally identified source records before provider resolution", () => {
  expect(explicitSelections(["https://www.reddit.com/r/test/s/abc123", "https://www.reddit.com/comments/abc123/"])).toHaveLength(2);
  expect(explicitSelections(["https://vm.tiktok.com/123/", "https://www.tiktok.com/@writer/video/123"])).toHaveLength(2);
});
