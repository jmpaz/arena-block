import { test, expect } from "bun:test";
import { SubstackProvider } from "../packages/core/providers/substack.ts";
import { discoverSubstackThread } from "../packages/core/providers/substack-thread.ts";
import { SocialResolver } from "../packages/core/providers/index.ts";
import { parseSource } from "../packages/core/url.ts";
import { composePlan } from "../packages/core/compose.ts";
import { blockPlanSchema } from "../packages/core/types.ts";
import { requiredPlanCapabilities } from "../src/plan-capabilities.ts";
import { resolveWithNative } from "../extension/src/native-reddit.ts";
import { substackPublicJSON } from "../packages/core/substack-public.ts";
import { substackArticleBody, substackOriginalImage } from "../packages/core/providers/substack-article.ts";
import { requireSubstackPublicResult } from "../packages/core/substack-input-capabilities.ts";
import { revisePlan } from "../extension/src/core.ts";

const article = await Bun.file(new URL("./fixtures/substack-article-public.json", import.meta.url)).json();
const articleURL = article.canonical_url;
function publicFetch(value: unknown): typeof fetch { return (async () => Response.json(value)) as unknown as typeof fetch; }
test("public articles retain full authored HTML, all bylines, time, rich text and source-ordered original images", async () => {
  const seen: RequestInit[] = [];
  const fetcher = (async (url: RequestInfo | URL, init?: RequestInit) => { expect(String(url)).toBe("https://www.stevestewartwilliams.com/api/v1/posts/imaginary-enemies"); seen.push(init!); return Response.json(article); }) as unknown as typeof fetch;
  const post = await new SubstackProvider([], fetcher).resolve(parseSource(articleURL));
  expect(post.substackArticle?.bodyHtml).toBe(article.body_html);
  expect(post.substackArticle?.authors.map(a => a.name)).toEqual(["Steve Stewart-Williams"]);
  expect(post.article).toContain("# Imaginary Enemies"); expect(post.article).toContain("By [Steve Stewart-Williams]");
  expect(post.article).toContain("https://www.stevestewartwilliams.com/p/imaginary-enemies");
  expect(post.postedAt).toBe("2024-06-08T10:56:14.125Z");
  expect(post.media.length).toBeGreaterThan(1);
  expect(post.media.every(item => item.kind === "image" && item.sourcePlacement === "body" && !item.url.includes("/image/fetch/"))).toBe(true);
  expect(post.article!.indexOf(post.media[0]!.url)).toBeLessThan(post.article!.indexOf(post.media[1]!.url));
  const plan = composePlan([post], { media: "all" });
  expect(blockPlanSchema.parse(plan)).toEqual(plan);
  expect(plan.block.markdown).toContain("Imaginary Enemies"); expect(plan.block.description).toContain("Complete public Substack article");
  expect(requiredPlanCapabilities(plan)).toContain("substack-public-sources-v2");
  expect(seen.every(init => init.credentials === "omit" && init.redirect === "error")).toBe(true);
});
test("article identity, paywall, partial body and unsafe media fail without a bypass", async () => {
  for (const patch of [{ audience: "only_paid" }, { is_published: false }, { is_geoblocked: true }, { free_unlock_required: true }, { body_html: null },
    { canonical_url: "https://other.com/p/imaginary-enemies" }, { canonical_url: "https://user:credential@www.stevestewartwilliams.com/p/imaginary-enemies" }, { slug: "wrong" }, { body_html: '<img src="http://substackcdn.com/a.jpg">' }]) {
    await expect(new SubstackProvider([], publicFetch({ ...article, ...patch })).resolve(parseSource(articleURL))).rejects.toThrow();
  }
  const coauthored = await new SubstackProvider([], publicFetch({ ...article, publishedBylines: [...article.publishedBylines, { id: 999, name: "Second author", handle: null }] })).resolve(parseSource(articleURL));
  expect(coauthored.article).toContain("Second author"); expect(coauthored.substackArticle?.authors[1]?.profileUrl).toBe("https://substack.com/profile/999");
});
test("article visuals preserve click-through links and cannot promote an unresolved preview or drop a chart", () => {
  expect(() => substackOriginalImage("https://substackcdn.com/image/fetch/w_100/preview.jpg", articleURL)).toThrow("original");
  expect(() => substackArticleBody('<svg role="img"><text>Meaningful chart</text></svg>', articleURL)).toThrow("inline visual");
  const body = substackArticleBody('<p><a href="https://example.com/article">Caption<img alt="Chart" src="https://substack-post-media.s3.amazonaws.com/public/images/chart.png"></a></p>', articleURL);
  expect(body.media[0]?.url).toContain("/chart.png"); expect(body.markdown).toContain("https://example.com/article"); expect(body.markdown).toContain("Caption");
  const mention = substackArticleBody('<p>Hello <span data-component-name="MentionToDOM" data-attrs=\'{"name":"Authored name","url":null}\'></span>.</p>', articleURL);
  expect(mention.markdown).toBe("Hello Authored name.");
  expect(() => substackArticleBody('<div data-component-name="VideoPlaceholder" data-attrs=\'{"mediaUploadId":"abc"}\'></div>', articleURL)).toThrow("unsupported player");
});
test("custom-domain discovery preserves unrelated pages as Links and known publications fail on refusal", async () => {
  const missing = (async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
  const source = parseSource("https://example.com/p/ordinary-page?utm_source=share");
  const post = await new SubstackProvider([], missing).resolve(source);
  expect(post.provider).toBe("web"); expect(composePlan([post], { media: "none" }).block.kind).toBe("url");
  expect(post.canonicalUrl).toBe("https://example.com/p/ordinary-page?utm_source=share");
  for (const fetcher of [missing, publicFetch({ ordinary: true }), (async () => { throw new TypeError("CORS"); }) as unknown as typeof fetch,
    (async () => new Response(null, { status: 403 })) as unknown as typeof fetch, (async () => new Response("broken", { headers: { "content-type": "application/json" } })) as unknown as typeof fetch]) {
    const resolved = await new SocialResolver({ substack: new SubstackProvider([], fetcher) }).resolveComposition(["https://example.com/p/download?format=pdf#download"]);
    const plan = composePlan(resolved.posts, resolved.policy);
    expect(plan.block.kind).toBe("url"); expect(plan.block.canonicalSource).toBe("https://example.com/p/download?format=pdf#download");
  }
  const aliased = await new SubstackProvider([], publicFetch(article)).resolve(parseSource(articleURL + "/?utm_source=share#selected"));
  expect(aliased.canonicalUrl).toBe(articleURL);
  await expect(new SubstackProvider([], missing).resolve(parseSource("https://writer.substack.com/p/missing"))).rejects.toThrow("HTTP 404");
  for (const url of ["https://127.0.0.1/p/a", "https://foo.local/p/a", "http://writer.substack.com/p/a"]) expect(() => parseSource(url)).toThrow();
});

const comment = (id: number, path = "", user = 1) => ({ id, user_id: user, handle: user === 1 ? "writer" : "other", ancestor_path: path, children_count: id < 102 ? 1 : 0, type: "feed", post_id: null });
const url = (id: number) => `https://substack.com/note/c-${id}`;
type ReplyComment = Omit<ReturnType<typeof comment>, "handle"> & { handle: string | null };
function replyPage(root: ReplyComment, children: ReplyComment[] = [], cursor: string | null = null) {
  return { rootComment: root, commentBranches: children.map(c => ({ comment: c, descendantComments: [] })), moreBranches: !!cursor, nextCursor: cursor };
}
const body = async (source: string) => ({ provider: "substack" as const, id: source.split("c-")[1]!, canonicalUrl: source, author: { handle: "writer" }, text: `Body ${source}`, media: [] });
test("reply discovery retains verified ancestor/parent identity and source order, including a non-root seed", async () => {
  const calls: string[] = [];
  const fetcher = (async (request: RequestInfo | URL, init?: RequestInit) => {
    const address = String(request); calls.push(address); expect(init?.credentials).toBe("omit");
    if (address.endsWith("/comment/101")) return Response.json({ item: { comment: comment(101, "100"), parentComments: [comment(100)] } });
    if (address.endsWith("/100/replies")) return Response.json(replyPage(comment(100), [comment(101, "100")]));
    if (address.endsWith("/101/replies")) return Response.json(replyPage(comment(101, "100"), [comment(102, "100.101"), comment(500, "100.101", 2)]));
    if (address.endsWith("/102/replies")) return Response.json(replyPage(comment(102, "100.101")));
    throw Error("Unexpected read");
  }) as unknown as typeof fetch;
  const result = await discoverSubstackThread("101", body, fetcher);
  expect(result.posts.map(p => p.id)).toEqual(["100", "101", "102"]);
  expect(result.posts[1]?.replyTo?.id).toBe("100"); expect(result.posts[2]?.replyTo?.id).toBe("101");
  expect(result.posts[0]?.substackThread).toMatchObject({ seedId: "101", rootId: "100", scope: "same-author-linear", complete: true, pagesRead: 4 });
  expect(result.posts[2]?.substackRelation?.ancestorIds).toEqual(["100", "101"]);
  expect(calls).toHaveLength(4); expect(blockPlanSchema.parse(composePlan(result.posts))).toBeTruthy();
});
test("public response fixture establishes a foreign reply, not an author continuation", async () => {
  const root = await Bun.file(new URL("./fixtures/substack-reader-comment-public.json", import.meta.url)).json();
  const replies = await Bun.file(new URL("./fixtures/substack-reader-replies-public.json", import.meta.url)).json();
  const fetcher = (async (request: RequestInfo | URL) => Response.json(String(request).endsWith("/replies") ? replies : root)) as unknown as typeof fetch;
  const result = await discoverSubstackThread("360829302", async source => ({ ...await body(source), author: { handle: "norvidstudies" } }), fetcher);
  expect(result.posts).toHaveLength(1); expect(result.posts[0]?.substackRelation?.reportedReplies).toBe(1);
  expect(result.posts[0]?.substackThread?.complete).toBe(true);
});
test("contradictory ancestor prefixes, including foreign ancestors, cannot establish a complete chain", async () => {
  const fetcher = publicFetch({ item: { comment: comment(30, "10.20"), parentComments: [comment(10, "", 2), comment(20, "99")] } });
  await expect(discoverSubstackThread("30", body, fetcher)).rejects.toThrow("prefixes disagree");
});
test("null metadata handles cannot conceal inconsistent body authors and changed reply counts cannot imply complete coverage", async () => {
  for (const changed of [false, true]) {
    const root = { ...comment(100), handle: null, children_count: changed ? 0 : 1 };
    const child = { ...comment(101, "100"), handle: null, children_count: 0 };
    const fetcher = (async (request: RequestInfo | URL) => {
      const address = String(request);
      if (!address.includes("/replies")) return Response.json({ item: { comment: root, parentComments: [] } });
      if (address.includes("/100/replies")) return Response.json(replyPage({ ...root, children_count: 1 }, changed ? [] : [child]));
      return Response.json(replyPage(child));
    }) as unknown as typeof fetch;
    await expect(discoverSubstackThread("100", async source => ({ ...await body(source), author: { handle: source.endsWith("101") ? "different" : "writer" } }), fetcher)).rejects.toThrow(changed ? "count changed" : "snapshots disagree");
  }
});
test("newly supplied reply-root author/count fields govern final body binding and retained evidence", async () => {
  const initial: any = { ...comment(100), handle: null }; delete initial.children_count;
  const fetcher = (async (request: RequestInfo | URL) => Response.json(String(request).includes("/replies")
    ? replyPage(comment(100), [comment(500, "100", 2)]) : { item: { comment: initial, parentComments: [] } })) as unknown as typeof fetch;
  await expect(discoverSubstackThread("100", async source => ({ ...await body(source), author: { handle: "different_author" } }), fetcher)).rejects.toThrow("reply identity disagree");
  const result = await discoverSubstackThread("100", body, fetcher);
  expect(result.posts[0]?.substackRelation?.reportedReplies).toBe(1);
});
test("a later null handle cannot erase an observed author binding", async () => {
  const fetcher = (async (request: RequestInfo | URL) => Response.json(String(request).includes("/replies")
    ? replyPage({ ...comment(100), handle: null }, [comment(500, "100", 2)]) : { item: { comment: comment(100), parentComments: [] } })) as unknown as typeof fetch;
  await expect(discoverSubstackThread("100", async source => ({ ...await body(source), author: { handle: "different_author" } }), fetcher)).rejects.toThrow("reply identity disagree");
});
test("reply pagination follows opaque cursors and rejects missing, conflicting, repeated, branched and unrelated evidence", async () => {
  for (const mode of ["branch", "unrelated", "omitted", "cursor", "identity", "missing-descendant"]) {
    const fetcher = (async (request: RequestInfo | URL) => {
      if (!String(request).includes("/replies")) return Response.json({ item: { comment: comment(100), parentComments: [] } });
      const page: any = replyPage(mode === "identity" ? comment(999) : comment(100), mode === "omitted" ? [] : [comment(101, mode === "unrelated" ? "999" : "100")]);
      if (mode === "branch") page.commentBranches.push({ comment: comment(103, "100"), descendantComments: [] });
      if (mode === "cursor") { page.moreBranches = true; page.nextCursor = "same"; }
      if (mode === "missing-descendant") page.commentBranches[0].descendantComments.push({ type: "unavailable", comment: null });
      return Response.json(page);
    }) as unknown as typeof fetch;
    await expect(discoverSubstackThread("100", body, fetcher)).rejects.toThrow();
  }
  const calls: string[] = [];
  const fetcher = (async (request: RequestInfo | URL) => {
    calls.push(String(request));
    if (!String(request).includes("/replies")) return Response.json({ item: { comment: { ...comment(100), children_count: 1 }, parentComments: [] } });
    return Response.json(replyPage(comment(100), [comment(500, "100", 2)], calls.length === 2 ? "cursor /?x" : null));
  }) as unknown as typeof fetch;
  expect((await discoverSubstackThread("100", body, fetcher)).posts).toHaveLength(1);
  expect(calls.at(-1)).toContain("cursor=cursor+%2F%3Fx");
});
test("article and Note thread requests preflight the new receiver contract", async () => {
  for (const input of [{ refs: [articleURL], extraRefs: [], refresh: false }, { refs: [url(100)], extraRefs: [], refresh: false, policy: { threadExpansion: "on" as const } }]) {
    const actions: string[] = [];
    await expect(resolveWithNative(input, async action => { actions.push(action); return { planCapabilities: ["substack-browser-records-v1"] }; })).rejects.toThrow("No source read was submitted");
    expect(actions).toEqual(["ping"]);
  }
});
test("helper replies and edits retain required article evidence instead of silently downgrading", async () => {
  const post = await new SubstackProvider([], publicFetch(article)).resolve(parseSource(articleURL));
  const plan = composePlan([post], { media: "none" }), input = { refs: [articleURL], extraRefs: [], refresh: false };
  requireSubstackPublicResult(input, plan);
  const edited = revisePlan(plan, { title: "Authored title" });
  expect(edited.sources[0]?.substackArticle).toEqual(plan.sources[0]?.substackArticle);
  expect(requiredPlanCapabilities(edited)).toContain("substack-public-sources-v2");
  const stripped = structuredClone(plan); delete stripped.sources[0]!.substackArticle;
  await expect(resolveWithNative(input, async action => action === "ping" ? { planCapabilities: ["substack-public-sources-v2"] } : stripped)).rejects.toThrow("complete source record");
  const mutated = structuredClone(plan); mutated.sources[0]!.article += "changed";
  expect(() => requireSubstackPublicResult(input, mutated)).toThrow("changed the Substack plan");
});
test("public JSON bounds content, type, redirect identity, aggregate budget and cancellation", async () => {
  const address = "https://substack.com/api/v1/reader/comment/100";
  const oversized = (async () => new Response("{}", { headers: { "content-type": "application/json", "content-length": "2097153" } })) as unknown as typeof fetch;
  await expect(substackPublicJSON(address, oversized)).rejects.toThrow("2 MiB");
  const budget = { bytes: 9, maximum: 10 };
  await expect(substackPublicJSON(address, publicFetch({ a: 1 }), undefined, budget)).rejects.toThrow("aggregate");
  const controller = new AbortController(); controller.abort();
  await expect(substackPublicJSON(address, publicFetch({}), controller.signal)).rejects.toThrow("cancelled");
});
