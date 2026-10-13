import { describe, expect, test } from "bun:test";
import { composePlan } from "../src/compose.ts";
import { SocialResolver } from "../src/providers/index.ts";
import { HackerNewsProvider } from "../src/providers/hackernews.ts";
import { LobstersProvider } from "../src/providers/lobsters.ts";
import type { Fetcher } from "../src/providers/comments.ts";
import { blockPlanSchema } from "../src/types.ts";
import { parseSource } from "../src/url.ts";

function api(fixtures: Record<string, unknown>) {
  const calls: string[] = [];
  const fetcher: Fetcher = async (url, init) => {
    init?.signal?.throwIfAborted();
    calls.push(url);
    const path = new URL(url).pathname;
    return path in fixtures ? Response.json(fixtures[path]) : new Response(null, { status: 404 });
  };
  return { calls, fetcher };
}

const hnUrl = "https://news.ycombinator.com/item?id=3";
const hnFixtures = {
  "/v0/item/3.json": { id: 3, type: "comment", by: "alice", time: 1704067200, parent: 2, text: '@bob First &amp; second.<p>Read <a href="https://example.com/">this</a>.<pre><code>let x = 1;\n</code></pre>' },
  "/v0/item/2.json": { id: 2, type: "comment", deleted: true, parent: 1 },
  "/v0/item/1.json": { id: 1, type: "story", title: "A &quot;better&quot; story" },
};
const lobsterComment = {
  short_id: "abc123", created_at: "2024-01-01T03:00:00.000+03:00",
  is_deleted: false, is_moderated: false, commenting_user: "alice",
  comment_plain: "@bob A **thought**.\n\n> A quote\n\n`code`",
  url: "https://lobste.rs/s/story1/a_story#c_abc123",
};
const lobsterFixtures = {
  "/c/abc123.json": lobsterComment,
  "/s/story1.json": { short_id: "story1", title: "A story" },
};

describe("comment URLs", () => {
  test("normalizes comment permalinks", () => {
    expect(parseSource(`${hnUrl}&utm_source=test`).canonicalUrl).toBe(hnUrl);
    for (const url of ["https://lobste.rs/c/abc123", "https://lobste.rs/c/abc123.json", lobsterComment.url, "https://lobste.rs/s/story1/a_story/comments/abc123"]) {
      expect(parseSource(url)).toEqual({ provider: "lobsters", id: "abc123", canonicalUrl: "https://lobste.rs/c/abc123" });
    }
  });

  test("rejects story-only Lobsters URLs and malformed HN links", () => {
    for (const url of ["https://lobste.rs/s/story1/a_story", "https://lobste.rs/s/story1/a_story#other", "https://news.ycombinator.com/item?id=oops", "https://news.ycombinator.com/user?id=3"]) {
      expect(() => parseSource(url)).toThrow();
    }
  });
});

describe("comment resolution", () => {
  test("walks HN parents through a deleted ancestor and preserves rich text", async () => {
    const { calls, fetcher } = api(hnFixtures);
    const resolver = new SocialResolver({ hackernews: new HackerNewsProvider(fetcher) });
    const plan = blockPlanSchema.parse(composePlan(await resolver.resolve([hnUrl])));
    expect(calls).toHaveLength(3);
    expect(plan.block.kind).toBe("text");
    expect(plan.block.title).toBe('Comment by alice on “A "better" story”');
    expect(plan.block.markdown).toContain("@bob First & second.\n\nRead [this](https://example.com/).");
    expect(plan.block.markdown).toContain("```\nlet x = 1;\n```");
    expect(plan.block.description).toBe("Posted at: 2024-01-01T00:00:00.000Z");
    expect(plan.block.canonicalSource).toBe(hnUrl);
    expect(plan.block.selectedMedia).toEqual([]);
  });

  test("preserves Lobsters source Markdown and normalizes timestamp", async () => {
    const { fetcher } = api(lobsterFixtures);
    const resolver = new SocialResolver({ lobsters: new LobstersProvider(fetcher) });
    const plan = blockPlanSchema.parse(composePlan(await resolver.resolve([lobsterComment.url]), { media: "all" }));
    expect(plan.block.kind).toBe("text");
    expect(plan.block.title).toBe("Comment by alice on “A story”");
    expect(plan.block.markdown).toBe(lobsterComment.comment_plain);
    expect(plan.block.description).toBe("Posted at: 2024-01-01T00:00:00.000Z");
    expect(plan.block.canonicalSource).toBe("https://lobste.rs/c/abc123");
  });

  test("rejects dead, deleted, missing, and non-comment HN items", async () => {
    for (const replacement of [null, { ...hnFixtures["/v0/item/3.json"], deleted: true }, { ...hnFixtures["/v0/item/3.json"], dead: true }, { id: 3, type: "story", title: "Story" }]) {
      const { fetcher } = api({ ...hnFixtures, "/v0/item/3.json": replacement });
      await expect(new HackerNewsProvider(fetcher).resolve(parseSource(hnUrl))).rejects.toThrow();
    }
  });

  test("rejects cyclic HN ancestry", async () => {
    const { fetcher } = api({ ...hnFixtures, "/v0/item/2.json": { id: 2, type: "comment", parent: 3 } });
    await expect(new HackerNewsProvider(fetcher).resolve(parseSource(hnUrl))).rejects.toThrow("cycle");
  });

  test("rejects deleted or moderated Lobsters comments and unsafe story URLs", async () => {
    for (const changes of [{ is_deleted: true }, { is_moderated: true }, { url: "https://example.com/s/story1" }]) {
      const { calls, fetcher } = api({ ...lobsterFixtures, "/c/abc123.json": { ...lobsterComment, ...changes } });
      await expect(new LobstersProvider(fetcher).resolve(parseSource(lobsterComment.url))).rejects.toThrow();
      expect(calls).toHaveLength(1);
    }
  });

  test("surfaces HTTP failures and cancellation", async () => {
    const provider = new HackerNewsProvider(api({}).fetcher);
    await expect(provider.resolve(parseSource(hnUrl))).rejects.toThrow("404");
    await expect(provider.resolve(parseSource(hnUrl), AbortSignal.abort())).rejects.toThrow();
  });
});
