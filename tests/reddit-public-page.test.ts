import { test, expect } from "bun:test";
import { runInNewContext } from "node:vm";
import { createDocument } from "@mixmark-io/domino";
import { readRedditPublicPage } from "../packages/core/reddit-public-page-reader.ts";
import { redditPublicPageCaptureSchema, redditPublicPagePost } from "../packages/core/reddit-public-page.ts";
import { normalizeRedditCapture, requireRetainedRedditCaptures } from "../packages/core/reddit-record.ts";
import { RedditProvider } from "../packages/core/providers/reddit.ts";
import { SocialResolver } from "../packages/core/providers/index.ts";
import { parseSource } from "../packages/core/url.ts";
import { planInputSchema } from "../packages/core/types.ts";
import { composePlan } from "../packages/core/compose.ts";
import { requiredPlanCapabilities } from "../src/plan-capabilities.ts";
import { handle } from "../extension/native-host.ts";
import postFixture from "./fixtures/reddit-public-page-post.json";
import commentFixture from "./fixtures/reddit-public-page-comment.json";

const post = redditPublicPageCaptureSchema.parse(postFixture), comment = redditPublicPageCaptureSchema.parse(commentFixture);
const escape = (s: string) => s.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
function page(capture = post, mutate: (document: Document) => void = () => {}) {
  const p = capture.post, c = capture.comment;
  const document = createDocument(`<shreddit-post id="t3_${p.id}" post-title="${escape(p.title)}" author="${p.author}" permalink="${p.permalink}" created-timestamp="${p.postedAt}" post-type="${p.postType}" content-href="${p.externalUrl ?? p.permalink}" show-full-content><div id="t3_${p.id}-post-rtjson-content">${p.body.html}</div></shreddit-post>${c ? `<shreddit-comment thingid="t1_${c.id}" postid="t3_${p.id}" author="${c.author}" permalink="${c.permalink}" created="${c.postedAt}"><div id="t1_${c.id}-post-rtjson-content">${c.body.html}</div></shreddit-comment>` : ""}`) as unknown as Document;
  mutate(document);
  return () => normalizeRedditCapture(runInNewContext(`(${readRedditPublicPage.toString()})(expected)`, {
    document, location: { href: capture.sourceUrl }, expected: capture.sourceUrl, URL, Date, Set, Array, JSON,
  }));
}
test("public DOM record retains complete selected post rich writing and exactly its three observed images", () => {
  const value = page()();
  expect(value.schema).toBe("arena-block/reddit-public-page-capture");
  if (value.schema !== "arena-block/reddit-public-page-capture") throw new Error("Wrong transport");
  const resolved = redditPublicPagePost(value);
  expect(resolved.author.handle).toBe("u/This_Cell_1829");
  expect(resolved.text).toContain("I'd especially love to hear how you're auditing agent-written analysis");
  expect(resolved.text).toContain("**Claude Code with Opus 5.5**");
  expect(resolved.text).toContain("https://doi.org/10.5281/zenodo.23175179");
  expect(resolved.media.map(m => m.id)).toEqual(["zwekq4q0m1uh1", "jr67x1wfk1uh1", "3848thnhk1uh1"]);
  expect(resolved.text).toContain(value.post.media[0]!.url);
  expect(resolved.media.every(m => m.sourceRole === "preview" && m.sourcePlacement === "body")).toBe(true);
  expect(value.post.body.html).not.toContain('class="');
  expect(JSON.stringify(value)).not.toContain("cookie");
});
test("selected public comment retains own complete body, exact author/date and parent title without parent content", () => {
  const value = page(comment)();
  if (value.schema !== "arena-block/reddit-public-page-capture") throw new Error("Wrong transport");
  const resolved = redditPublicPagePost(value);
  expect(resolved.id).toBe("pf30wuc"); expect(resolved.author.handle).toBe("/u/bibliophile785");
  expect(resolved.postedAt).toBe("2026-10-10T17:28:26.997Z");
  expect(resolved.storyTitle).toBe("Terence Tao's actual current thoughts on AI and math");
  expect(resolved.text).toStartWith("Ooh, what a sharply bifurcated talk.");
  expect(resolved.text).toEndWith("intellectual fulfillment in being a part of the process.");
  expect(resolved.media).toEqual([]); expect(value.post.body).toEqual({ status: "context-only", html: "" });
  expect(value.post.evidence.fullContent).toBe(false);
});
test("public reader refuses a challenge, incomplete page, unknown media and substituted comment identity", () => {
  for (const mutate of [
    (d: Document) => { const form = d.createElement("form"); form.id = "challenge-form"; d.body.appendChild(form); },
    (d: Document) => { d.querySelector("shreddit-post")!.removeAttribute("show-full-content"); },
    (d: Document) => { d.querySelector("shreddit-post")!.appendChild(d.createElement("video")); },
    (d: Document) => { d.querySelector("shreddit-post")!.setAttribute("moderation-verdict", "removed"); },
  ]) expect(page(post, mutate)).toThrow();
  expect(page(comment, d => d.querySelector("shreddit-comment")!.setAttribute("postid", "t3_other"))).toThrow("different parent");
  expect(page(comment, d => d.querySelector("shreddit-comment")!.remove())).toThrow("not ready");
});
test("public record bounds and provenance reject mismatched or executable source evidence", () => {
  for (const value of [
    { ...comment, comment: { ...comment.comment!, postId: "other" } },
    { ...post, post: { ...post.post, body: { status: "complete", html: "<script>bad()</script>" } } },
    { ...post, post: { ...post.post, media: [{ ...post.post.media[0]!, id: "other" }] } },
    { ...post, post: { ...post.post, media: [{ ...post.post.media[0]!, sourceRole: "original" }] } },
    { ...post, post: { ...post.post, media: [post.post.media[0]!, post.post.media[0]!] } },
    { ...post, post: { ...post.post, evidence: { root: "shreddit-post", fullContent: false } } },
  ]) expect(() => normalizeRedditCapture(value)).toThrow();
});
test("selected comments do not acquire or reject their parent's unrelated media", () => {
  const value = page(comment, d => {
    const parent = d.querySelector("shreddit-post")!;
    parent.setAttribute("post-type", "video");
    parent.appendChild(d.createElement("video"));
  })();
  if (value.schema !== "arena-block/reddit-public-page-capture") throw new Error("Wrong transport");
  expect(redditPublicPagePost(value).text).toStartWith("Ooh, what a sharply bifurcated talk.");
  expect(value.post.media).toEqual([]);
});
test("a missing authored post body or unverified GIF does not become a complete capture", () => {
  expect(page(post, d => d.querySelector(`[id="t3_${post.post.id}-post-rtjson-content"]`)!.remove())).toThrow("omitted its complete authored body");
  expect(page(post, d => d.querySelector("img")!.setAttribute("src", "https://i.redd.it/animated.gif"))).toThrow("image identity");
});
test("public records compose with existing media controls, retain evidence and require the new receiver capability", async () => {
  const resolver = new SocialResolver({ reddit: new RedditProvider(async () => { throw new Error("No network expected"); }, [post]) });
  const all = await resolver.resolveComposition([post.sourceUrl], [], { media: "all" });
  const plan = composePlan(all.posts, all.policy);
  expect(plan.block.selectedMedia).toHaveLength(3); expect(plan.sources[0]!.redditCapture).toEqual(post);
  expect(requiredPlanCapabilities(plan)).toContain("reddit-public-page-records-v1");
  expect(requiredPlanCapabilities(plan)).toContain("reddit-browser-records-v1");
  requireRetainedRedditCaptures(plan, [post]);
  expect(() => requireRetainedRedditCaptures({ sources: [{}] }, [post])).toThrow("did not retain");
  const none = await resolver.resolveComposition([post.sourceUrl], [], { media: "none" });
  const noMedia = composePlan(none.posts, none.policy);
  expect(noMedia.block.selectedMedia).toEqual([]);
  expect(noMedia.block.markdown).toContain(post.post.media[0]!.url);
  const selected = await resolver.resolveComposition([post.sourceUrl], [], { media: "selected", selectedMedia: ["1.2"] });
  expect(composePlan(selected.posts, selected.policy).block.selectedMedia).toEqual(["1.2"]);
  const selectedComment = await new RedditProvider(async () => { throw new Error("No network expected"); }, [comment]).resolve(parseSource(comment.sourceUrl));
  expect(selectedComment.text).toContain("a sharply bifurcated talk"); expect(selectedComment.media).toEqual([]);
});
test("native host refuses a receiver that would strip public-page evidence before submitting a plan", async () => {
  const before = process.env.ARENA_BLOCK_ACCESS_TOKEN;
  process.env.ARENA_BLOCK_ACCESS_TOKEN = "fixture-only";
  const paths: string[] = [];
  try {
    await expect(handle({ id: "public", action: "resolve", input: planInputSchema.parse({ refs: [post.sourceUrl], redditCaptures: [post] }) }, (async url => {
      paths.push(new URL(String(url)).pathname);
      return Response.json({ version: "0.1.0", revision: null, sourceId: "fixture", platform: "fixture", schemaVersion: 1, packagePath: null,
        planCapabilities: ["reddit-browser-records-v1"] });
    }) as typeof fetch)).rejects.toThrow("cannot retain Reddit public page");
    expect(paths).toEqual(["/v1/version"]);
  } finally { if (before === undefined) delete process.env.ARENA_BLOCK_ACCESS_TOKEN; else process.env.ARENA_BLOCK_ACCESS_TOKEN = before; }
});

test("authored discussion of access errors is not mistaken for a site challenge", () => {
  expect(() => page(post, d => { d.querySelector(`[id="t3_${post.post.id}-post-rtjson-content"]`)!.appendChild(d.createTextNode("An access denied error was part of my analysis.")); })()).not.toThrow();
});
