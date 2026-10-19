import { describe, expect, test } from "bun:test";
import { composePlan } from "../packages/core/compose.ts";
import { explicitSelections } from "../packages/core/source-selection.ts";
import { parseSource } from "../packages/core/url.ts";
import { SocialResolver } from "../src/providers/index.ts";
import { HackerNewsProvider } from "../packages/core/providers/hackernews.ts";
import { LobstersProvider } from "../packages/core/providers/lobsters.ts";
import { resolveCapture } from "../extension/src/core.ts";
import { fetchJson } from "../packages/core/providers/comments.ts";

const root = "https://lobste.rs/s/ggpwfi";
const reported = "https://lobste.rs/s/ggpwfi/it_s_enough_vibecoding_tag_crossed_from";
const story = { short_id: "ggpwfi", title: "An authored story", created_at: "2026-10-18T05:35:11.525-05:00",
  submitter_user: "writer", description_plain: "First paragraph.\n\nPlease keep **this** story.", url: "", short_id_url: root, comments_url: reported,
  comments: [{ short_id: "other1", commenting_user: "other", comment_plain: "UNSELECTED DISCUSSION" }] };
const hn = "https://news.ycombinator.com/item?id=100";

describe("story and selected-comment dispatch", () => {
  test("recognizes bare/slug/JSON Lobsters stories and retains selected comment aliases", () => {
    for (const ref of [root, reported, root + ".json", reported + "/?tracking=1"]) {
      expect(parseSource(ref)).toEqual({ provider: "lobsters", kind: "story", id: "ggpwfi", canonicalUrl: root });
    }
    for (const ref of [reported + "#c_abc123", "https://lobste.rs/c/abc123", reported + "/comments/abc123"]) {
      expect(parseSource(ref)).toEqual({ provider: "lobsters", id: "abc123", canonicalUrl: "https://lobste.rs/c/abc123" });
    }
    expect(explicitSelections([root, "https://lobste.rs/c/ggpwfi"])).toHaveLength(2);
    expect(() => parseSource("https://lobste.rs/c/abc123#c_other1")).toThrow("Conflicting");
  });

  test.each(["http://lobste.rs/s/ggpwfi", "https://user@lobste.rs/s/ggpwfi", "https://lobste.rs:444/s/ggpwfi",
    "https://lobste.rs/", reported + "#wrong", "https://news.ycombinator.com/", hn + "&id=101", hn + "#123",
    "http://news.ycombinator.com/item?id=100", "https://user@news.ycombinator.com/item?id=100", "https://news.ycombinator.com/user?id=100"])
  ("rejects ambiguous or unsupported root/item URL %s", ref => { expect(() => parseSource(ref)).toThrow(); });

  test("saves only a Lobsters submission, including under -t, with source and submitter attribution", async () => {
    const calls: string[] = [];
    const resolver = new SocialResolver({ lobsters: new LobstersProvider(async url => {
      calls.push(url); expect(url).toBe(root + ".json"); return Response.json(story);
    }) });
    const resolved = await resolver.resolveComposition([reported], [], { media: "all", threadExpansion: "on" });
    const plan = composePlan(resolved.posts, resolved.policy);
    expect(calls).toEqual([root + ".json"]); expect(plan.sources).toHaveLength(1);
    expect(plan.block).toMatchObject({ title: story.title, kind: "text", canonicalSource: root, selectedMedia: [] });
    expect(plan.sources[0]!.postedAt).toBe("2026-10-18T10:35:11.525Z");
    expect(plan.block.markdown).toBe(story.description_plain + "\n\nSubmitted by [writer](<https://lobste.rs/u/writer>)");
    expect(plan.block.markdown).not.toContain("UNSELECTED DISCUSSION");
    const rendered = Bun.markdown.html(plan.block.markdown);
    expect(rendered).toContain("<strong>this</strong>"); expect(rendered).toContain('href="https://lobste.rs/u/writer"');
  });

  test("native/browser uses the same exact root dispatch and an external submission stays a source story", async () => {
    const plan = await resolveCapture({ primary: [reported], extras: [], policy: { media: "all", threadExpansion: "off" } }, undefined,
      (async () => Response.json({ ...story, url: "https://example.com/original" })) as typeof fetch);
    expect(plan.block.canonicalSource).toBe(root); expect(plan.block.markdown).toContain("Link: <https://example.com/original>");
    expect(plan.block.markdown).not.toContain("UNSELECTED DISCUSSION");
  });

  test("rejects missing or substituted Lobsters roots rather than collecting a discussion", async () => {
    for (const changes of [{ short_id: "wrong1" }, { submitter_user: "" }, { description_plain: undefined },
      { short_id_url: "https://lobste.rs/s/wrong1" }, { comments_url: reported + "#c_wrong1" }, { url: "javascript:alert(1)" }]) {
      await expect(new LobstersProvider(async () => Response.json({ ...story, ...changes })).resolve(parseSource(reported))).rejects.toThrow();
    }
  });

  test.each([false, true])("HN dispatches a %s-body story from the fetched item type without walking kids", async withBody => {
    const calls: string[] = [];
    const provider = new HackerNewsProvider(async url => {
      calls.push(url); return Response.json({ id: 100, type: "story", title: "A &quot;story&quot;", by: "writer", time: 1704067200,
        ...(withBody ? { text: "First<p>A <b>complete</b> body" } : { url: "https://example.com/article" }), kids: [101, 102] });
    });
    const posts = await new SocialResolver({ hackernews: provider }).resolve([hn]);
    const plan = composePlan(posts, { media: "all" });
    expect(calls).toHaveLength(1); expect(plan.block.title).toBe('A "story"'); expect(plan.block.canonicalSource).toBe(hn);
    expect(plan.sources[0]!.author.handle).toBe("writer");
    expect(plan.block.markdown).toContain(withBody ? "First\n\nA **complete** body" : "Link: <https://example.com/article>");
    expect(plan.block.markdown).toContain("Submitted by [writer](<https://news.ycombinator.com/user?id=writer>)");
  });

  test("unavailable HN stories and unsupported poll/job items return precise errors", async () => {
    for (const type of ["poll", "job", "pollopt"]) {
      await expect(new HackerNewsProvider(async () => Response.json({ id: 100, type })).resolve(parseSource(hn))).rejects.toThrow("choose a story or comment permalink");
    }
    for (const body of [null, { id: 100, type: "story", title: "Missing author" }, { id: 100, type: "story", title: "Deleted", deleted: true }]) {
      await expect(new HackerNewsProvider(async () => Response.json(body)).resolve(parseSource(hn))).rejects.toThrow();
    }
  });

  test("public item reads reject unchecked redirects and oversized metadata", async () => {
    await expect(fetchJson(root + ".json", async (_url, init) => { expect(init?.redirect).toBe("manual"); return new Response(null, { status: 302 }); })).rejects.toThrow("302");
    await expect(fetchJson(root + ".json", async () => new Response("{}", { headers: { "content-length": "2000001" } }))).rejects.toThrow("2 MB");
    await expect(fetchJson(root + ".json", async () => new Response(" ".repeat(2_000_001)))).rejects.toThrow("2 MB");
    await expect(fetchJson(root + ".json", async () => Response.json({ body: "界".repeat(700_000) }))).rejects.toThrow("2 MB");
  });
});
