import { describe, expect, test } from "bun:test";
import { composePlan } from "../src/compose.ts";
import { SocialResolver } from "../src/providers/index.ts";
import { MastodonProvider } from "../src/providers/mastodon.ts";
import type { Fetcher } from "../src/providers/comments.ts";
import { blockPlanSchema, planInputSchema } from "../src/types.ts";
import { parseSource } from "../src/url.ts";

const source = "https://social.example/@alice/123";
const status = {
  id: "123", url: source, uri: "https://social.example/users/alice/statuses/123",
  account: { acct: "alice", url: "https://social.example/@alice", display_name: "Alice" },
  content: '<p>First &amp; second.</p><p><a href="https://example.org/full"><span class="invisible">https://</span><span>example.org/</span><span class="invisible">full</span></a><br>Next line.</p>',
  created_at: "2024-01-01T03:00:00+03:00", visibility: "public",
  media_attachments: [] as unknown[],
};
const image = { id: "m1", type: "image", url: "https://cdn.example/image.png", description: "A diagram", meta: { original: { width: 800, height: 600 } } };
const video = { id: "m2", type: "video", url: "https://cdn.example/clip.mp4", description: "A demonstration", meta: { original: { width: 640, height: 360, duration: 2.5 } } };
const gifv = { id: "m3", type: "gifv", url: null, remote_url: "https://origin.example/loop.mp4", meta: { width: 200, height: 100, duration: 1 } };

function resolver(value: unknown = status, code = 200) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher: Fetcher = async (url, init) => {
    init?.signal?.throwIfAborted();
    calls.push({ url, init });
    return Response.json(value, { status: code });
  };
  return { calls, resolve: new SocialResolver({ mastodon: new MastodonProvider(fetcher) }) };
}

describe("Mastodon URLs", () => {
  test("uses the permalink's server and local status ID", () => {
    for (const path of ["/@alice/123", "/@alice@origin.example/123", "/users/alice/statuses/123", "/ap/users/42/statuses/123", "/web/statuses/123", "/statuses/123"]) {
      expect(parseSource(`https://www.social.example${path}/?tracking=1#fragment`)).toEqual({
        provider: "mastodon", server: "https://www.social.example", id: "123", canonicalUrl: `https://www.social.example${path}`,
      });
    }
  });

  test("rejects profiles, non-post paths, credentials, and insecure schemes", () => {
    for (const url of ["https://social.example/@alice", "https://social.example/@alice/not-a-status", "https://social.example/@alice/123/extra", "http://social.example/@alice/123", "https://secret@social.example/@alice/123", "ftp://social.example/@alice/123"]) {
      expect(() => parseSource(url)).toThrow();
    }
  });
});

describe("Mastodon resolution", () => {
  test("preserves paragraphs and full links without a discovery service or credentials", async () => {
    const { calls, resolve } = resolver();
    const [post] = await resolve.resolve([source]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://social.example/api/v1/statuses/123");
    expect(new Headers(calls[0]!.init?.headers).has("authorization")).toBe(false);
    expect(calls[0]!.init?.redirect).toBe("error");
    expect(post!.text).toContain("First & second.\n\nhttps://example.org/full");
    expect(post!.text).not.toContain("](https://example.org/full)");
    expect(post!.text).toContain("Next line.");
    expect(post!.postedAt).toBe("2024-01-01T00:00:00.000Z");
    const plan = blockPlanSchema.parse(composePlan([post!]));
    expect(plan.block.kind).toBe("text");
    expect(plan.block.title).toBe("Post by @alice@social.example");
    expect(plan.block.canonicalSource).toBe(source);
  });

  test("uses original author and permalink for remote copies", async () => {
    const { resolve } = resolver({ ...status, url: "https://origin.example/@alice/456", account: { ...status.account, acct: "alice@origin.example", url: "https://origin.example/@alice" } });
    const [post] = await resolve.resolve([source]);
    expect(post!.author.handle).toBe("alice@origin.example");
    expect(post!.canonicalUrl).toBe("https://origin.example/@alice/456");
  });

  test("keeps descriptive links while leaving URL labels unescaped", async () => {
    const { resolve } = resolver({ ...status, content: '<p><a href="https://example.org/a_b">https://example.org/a_b</a> and <a href="https://example.org/paper">read the paper</a></p>' });
    const [post] = await resolve.resolve([source]);
    expect(post!.text).toBe("https://example.org/a_b and [read the paper](https://example.org/paper)");
  });

  test("routes images, video, and GIFV through the existing selection and layout policies", async () => {
    const { resolve } = resolver({ ...status, media_attachments: [image, video, gifv] });
    const posts = await resolve.resolve([source]);
    expect(posts[0]!.media.map((item) => [item.ref, item.kind])).toEqual([["1.1", "image"], ["1.2", "video"], ["1.3", "video"]]);
    expect(posts[0]!.media[0]).toMatchObject({ width: 800, height: 600, alt: "A diagram" });
    expect(posts[0]!.media[1]).toMatchObject({ durationSeconds: 2.5, alt: "A demonstration" });
    expect(posts[0]!.media[2]!.url).toBe(gifv.remote_url);
    for (const [media, kind, refs] of [
      ["auto", "video", ["1.2"]], ["all", "video", ["1.1", "1.2", "1.3"]],
      ["images", "link", ["1.1"]], ["video", "video", ["1.2", "1.3"]], ["none", "text", []],
    ] as const) {
      const plan = blockPlanSchema.parse(composePlan(posts, { media }));
      expect(plan.block.kind).toBe(kind);
      expect(plan.block.selectedMedia).toEqual([...refs]);
    }
    expect(composePlan(posts, { media: "all" }).block.layout).toBeDefined();
    expect(composePlan(posts, { media: "selected", selectedMedia: ["1.3"] }).block.selectedMedia).toEqual(["1.3"]);
  });

  test("retains content warnings, emoji alt text, and audio links", async () => {
    const { resolve } = resolver({ ...status, spoiler_text: "A warning", sensitive: true, content: '<p>Hello <img class="emojione" alt=":wave:" src="https://cdn.example/emoji.png"></p>', media_attachments: [{ id: "audio", type: "audio", url: "https://cdn.example/audio.mp3" }] });
    const [post] = await resolve.resolve([source]);
    expect(post!.text).toBe("Content warning: A warning\n\nHello :wave:\n\n[Audio](<https://cdn.example/audio.mp3>)");
    expect(post!.media).toEqual([]);
  });

  test("unwraps boosts and composes accepted quoted posts", async () => {
    const original = { ...status, id: "456", url: "https://origin.example/@bob/456", account: { acct: "bob", url: "https://origin.example/@bob" }, content: "<p>Quoted text.</p>", media_attachments: [image] };
    const boosted = await resolver({ ...status, reblog: original }).resolve.resolve([source]);
    expect(boosted[0]!.canonicalUrl).toBe(original.url);
    expect(boosted[0]!.author.handle).toBe("bob@origin.example");
    const quoteContent = '<p class="quote-inline">RE: <a href="https://origin.example/@bob/456">original</a></p><p>My response.</p>';
    const quoted = await resolver({ ...status, content: quoteContent, quote: { state: "accepted", quoted_status: original } }).resolve.resolve([source]);
    expect(quoted[0]!.quote!.media[0]!.ref).toBe("quote.1");
    const plan = blockPlanSchema.parse(composePlan(quoted));
    expect(plan.block.markdown).toContain("> Quoted text.");
    expect(plan.block.markdown).not.toContain("RE:");
    expect(plan.block.markdown).toContain("My response.");
    expect(plan.block.selectedMedia).toEqual([]);
    expect(composePlan(quoted, { quote: "omit" }).block.markdown).not.toContain("Quoted text.");
    for (const state of ["pending", "revoked", "unauthorized", "future-state"]) {
      const posts = await resolver({ ...status, quote: { state, quoted_status: original } }).resolve.resolve([source]);
      expect(posts[0]!.quote).toBeUndefined();
    }
  });

  test("fails clearly for inaccessible posts, invalid payloads, and missing media", async () => {
    for (const code of [401, 404, 429, 503]) {
      await expect(resolver({ error: "Unavailable" }, code).resolve.resolve([source])).rejects.toThrow(String(code));
    }
    for (const changes of [{ id: "456" }, { visibility: "private" }, { content: undefined }, { created_at: "invalid" }, { media_attachments: [{ ...image, url: null }] }, { url: "file:///private/status" }]) {
      await expect(resolver({ ...status, ...changes }).resolve.resolve([source])).rejects.toThrow();
    }
    await expect(resolver().resolve.resolve([source], AbortSignal.abort())).rejects.toThrow();
  });
});

describe("AT Protocol post URIs", () => {
  test("routes handle and DID records through the existing Bluesky provider", () => {
    for (const handle of ["alice.example", "did:plc:ewvi7nxzyoun6zhxrhs64oiz", "did:web:alice.example"]) {
      const uri = `at://${handle}/app.bsky.feed.post/3kexample`;
      expect(planInputSchema.parse({ refs: [uri] }).refs).toEqual([uri]);
      expect(parseSource(uri)).toEqual(parseSource(`https://bsky.app/profile/${handle}/post/3kexample`));
    }
  });

  test("rejects other application records and incomplete URIs", () => {
    for (const uri of ["at://alice.example/app.bsky.actor.profile/self", "at://alice.example/app.bsky.feed.post/", "at://alice.example/app.bsky.feed.post/..", "at://alice.example/app.bsky.feed.post/id/extra"]) {
      expect(() => parseSource(uri)).toThrow();
    }
  });
});
