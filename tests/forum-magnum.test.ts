import { expect, test } from "bun:test";
import examples from "./fixtures/forum-magnum-public.json";
import { parseSource } from "../packages/core/url.ts";
import { explicitSelections } from "../packages/core/source-selection.ts";
import { captureSource } from "../packages/core/capture.ts";
import { SocialResolver } from "../packages/core/providers/index.ts";
import { ForumMagnumProvider } from "../packages/core/providers/forum-magnum.ts";
import { XProvider } from "../packages/core/providers/x.ts";
import { composePlan } from "../packages/core/compose.ts";
import { previewFields, requiredOrigins, resolveCapture } from "../extension/src/core.ts";
import { requiredPlanCapabilities } from "../src/plan-capabilities.ts";
import { publicationFields } from "../packages/core/capture.ts";

type Example = { post: any; comments: any[] };
const publicExamples = examples as Record<string, Example>;
const sample = "https://www.lesswrong.com/posts/6eaKqtmDuo6CmkqMK/loops-s-shortform?commentId=7C9iqsDCdxC2PfKDf";
const ea = "https://forum.effectivealtruism.org/posts/ckj6Moau9qpYArHWc/want-to-be-an-expert-build-deep-models?commentId=Myoki5MsXgG8Jmb2J";
const af = "https://www.alignmentforum.org/posts/bxt7uCiHam4QXrQAA/cyborgism?commentId=2CxekqM5fc87mmqXn";

function fixtureFetch(): { fetcher: typeof fetch; calls: Array<{ url: string; variables: any }> } {
  const calls: Array<{ url: string; variables: any }> = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const { query, variables } = JSON.parse(String(init?.body));
    calls.push({ url, variables });
    const example = Object.values(publicExamples).find(item => new URL(item.post.pageUrl).origin === new URL(url).origin
      && (item.post._id === variables.id || item.post._id === variables.terms?.postId
        || item.comments.some(comment => comment._id === variables.id || comment._id === variables.terms?.parentCommentId)));
    if (!example) throw new Error(`Unfixtureed API request: ${url} ${JSON.stringify(variables)}`);
    if (query.includes("ForumPost")) return Response.json({ data: { post: { result: example.post } } });
    if (query.includes("ForumComment")) return Response.json({ data: { comment: { result: example.comments.find(comment => comment._id === variables.id) ?? null } } });
    if (query.includes("ForumReplies")) return Response.json({ data: { comments: { results: example.comments.filter(comment => comment.parentCommentId === variables.terms.parentCommentId) } } });
    throw new Error("Unexpected GraphQL query");
  }) as typeof fetch;
  return { fetcher, calls };
}

test("canonical Forum Magnum URLs keep comment and post identities separate", () => {
  const urls = [
    sample,
    "https://greaterwrong.com/posts/6eaKqtmDuo6CmkqMK/loops-s-shortform/comment/7C9iqsDCdxC2PfKDf",
    "https://www.lesswrong.com/posts/6eaKqtmDuo6CmkqMK/loops-s-shortform#7C9iqsDCdxC2PfKDf",
    "https://lesswrong.com/p/6eaKqtmDuo6CmkqMK?commentId=7C9iqsDCdxC2PfKDf",
  ];
  expect(urls.map(url => parseSource(url).canonicalUrl)).toEqual(Array(4).fill("https://www.lesswrong.com/posts/6eaKqtmDuo6CmkqMK/?commentId=7C9iqsDCdxC2PfKDf"));
  expect(explicitSelections(urls)).toHaveLength(1);
  expect(explicitSelections([sample, sample.split("?")[0]!])).toHaveLength(2);
  expect(captureSource(sample).kind).toBe("social");
  expect(parseSource(ea)).toMatchObject({ provider: "forum_magnum", site: "ea_forum", commentId: "Myoki5MsXgG8Jmb2J" });
  expect(parseSource(af)).toMatchObject({ provider: "forum_magnum", site: "alignment_forum", commentId: "2CxekqM5fc87mmqXn" });
  expect(() => parseSource(sample + "#anotherCommentId12")).toThrow("Conflicting");
  expect(() => parseSource(sample.split("?")[0]! + "?commentId=")).toThrow("Invalid Forum Magnum comment ID");
  expect(() => captureSource(sample.split("?")[0]! + "#comment-too-short")).toThrow("Invalid Forum Magnum comment ID");
  expect(() => parseSource("http://www.lesswrong.com/posts/6eaKqtmDuo6CmkqMK")).toThrow("HTTPS");
  expect(() => parseSource("https://www.lesswrong.com/quicktakes")).toThrow("post or comment");
});

test("real public Quick Take receives its own author, date, rich links, and no container body", async () => {
  const { fetcher, calls } = fixtureFetch();
  const provider = new ForumMagnumProvider(fetcher);
  const post = await provider.resolve(parseSource(sample));
  expect(post).toMatchObject({ provider: "forum_magnum", id: "7C9iqsDCdxC2PfKDf", author: { handle: "smitop", name: "loops" },
    storyTitle: "loops's Shortform", postedAt: "2026-10-13T19:59:43.684Z", media: [] });
  expect(post.canonicalUrl).toBe(sample);
  expect(post.text).toContain("Concise Research Roadmap");
  expect(post.text).toContain("https://i.sm4.ca/concise-research-roadmap.pdf");
  expect(post.text).not.toContain("This is a special post for quick takes");
  expect(calls.map(call => call.url)).toEqual(Array(2).fill("https://www.lesswrong.com/graphql"));
  const quoted = await provider.resolve(parseSource(publicExamples.lesswrong_thread!.comments.find(item => item._id === "qTyoKrT8s9NT8octc")!.pageUrl));
  expect(quoted.text).toContain("> ");
  await expect(provider.resolve(parseSource(sample.split("?")[0]!))).rejects.toThrow("Shortform post is a container");
});

test("contrasting public EA and Alignment Forum comments use their own API origins", async () => {
  const f = fixtureFetch();
  const provider = new ForumMagnumProvider(f.fetcher);
  const [eaPost, afPost] = await Promise.all([provider.resolve(parseSource(ea)), provider.resolve(parseSource(af))]);
  expect(eaPost.author.handle).toBe("Bluefalcon");
  expect(eaPost.storyTitle).toBe("Want To Be An Expert? Build Deep Models");
  expect(afPost.author.handle).toBe("sharmake-farah");
  expect(afPost.storyTitle).toBe("Cyborgism");
  expect(new Set(f.calls.map(call => call.url))).toEqual(new Set(["https://forum.effectivealtruism.org/graphql", "https://www.alignmentforum.org/graphql"]));
});

test("multiple real comment permalinks preserve declared order and actual reply relationship", async () => {
  const parent = publicExamples.lesswrong_thread!.comments.find(item => item._id === "jFB6xwANhpqJkkvc4")!;
  const child = publicExamples.lesswrong_thread!.comments.find(item => item._id === "Nzpimbubshmb2dxnL")!;
  const { fetcher } = fixtureFetch();
  const resolved = await new SocialResolver({ forum_magnum: new ForumMagnumProvider(fetcher) })
    .resolveComposition([child.pageUrl, parent.pageUrl, sample, child.pageUrl], [], { threadExpansion: "on" });
  expect(resolved.posts.map(post => post.id)).toEqual([child._id, parent._id, "7C9iqsDCdxC2PfKDf"]);
  expect(resolved.posts[0]!.replyTo?.id).toBe(parent._id);
  expect(resolved.posts.map(post => post.selection?.declaredIndex)).toEqual([1, 2, 3]);
  const plan = composePlan(resolved.posts, resolved.policy);
  expect(plan.block.markdown).toContain(`Reply to comment ${parent._id}`);
  expect(plan.block.markdown.indexOf("`@Nanashi`")).toBeLessThan(plan.block.markdown.indexOf("`@estimator`"));
});

test("reply links from path-style comments resolve to the actual parent", () => {
  const child = "ChildCommentABC";
  const parent = "ParentCommentABC";
  const plan = composePlan([{ provider: "forum_magnum", id: child,
    canonicalUrl: `https://www.alignmentforum.org/posts/PostID1234/example/comment/${child}`,
    author: { handle: "commenter" }, text: "A reply", media: [], replyTo: { id: parent } }]);
  const link = plan.block.markdown.match(/\[Reply to comment ParentCommentABC\]\(<([^>]+)>\)/)?.[1];
  expect(link).toBeDefined();
  expect(parseSource(link!)).toMatchObject({ provider: "forum_magnum", id: "PostID1234", commentId: parent });
});

test("auto includes only real ancestors; on adds bounded replies without siblings", async () => {
  const parent = publicExamples.shortform_thread!.comments.find(item => item._id === "hLcibt3RxuQXGhRK3")!;
  const child = publicExamples.shortform_thread!.comments.find(item => item._id === "eFwRurEDaCxCLTyR4")!;
  const resolver = new SocialResolver({ forum_magnum: new ForumMagnumProvider(fixtureFetch().fetcher) });
  const auto = await resolver.resolveComposition([child.pageUrl]);
  expect(auto.posts.map(post => post.id)).toEqual([parent._id, child._id]);
  expect(auto.posts[1]!.selection).toMatchObject({ origin: "explicit", parentUri: `forum-magnum:lesswrong:comment:${parent._id}` });
  const off = await resolver.resolveComposition([child.pageUrl], [], { threadExpansion: "off" });
  expect(off.posts.map(post => post.id)).toEqual([child._id]);
  const on = await resolver.resolveComposition([parent.pageUrl], [], { threadExpansion: "on" });
  expect(on.posts.map(post => post.id)).toEqual([parent._id, child._id]);
});

test("opt-in expansion stops at eight direct replies and follows same-author continuation edges", async () => {
  const example = publicExamples.shortform_thread!;
  const parent = example.comments.find(item => item._id === "hLcibt3RxuQXGhRK3")!;
  const children = Array.from({ length: 12 }, (_, index) => ({ ...parent,
    _id: `child${index}ABCDE`, parentCommentId: parent._id,
    pageUrl: parent.pageUrl.replace(parent._id, `child${index}ABCDE`),
    postedAt: new Date(Date.parse(parent.postedAt) + (index + 1) * 60_000).toISOString(),
    user: { username: index === 0 ? parent.user.username : `other${index}`, displayName: null },
    contents: { html: `<p>Reply ${index}</p>` },
  }));
  const grandchild = { ...children[0]!, _id: "grandchildABCDE", parentCommentId: children[0]!._id,
    pageUrl: parent.pageUrl.replace(parent._id, "grandchildABCDE"), contents: { html: "<p>Continued thought</p>" } };
  const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const { query, variables } = JSON.parse(String(init?.body));
    if (query.includes("ForumPost")) return Response.json({ data: { post: { result: example.post } } });
    if (query.includes("ForumComment")) return Response.json({ data: { comment: { result: parent } } });
    if (query.includes("ForumReplies")) return Response.json({ data: { comments: { results:
      variables.terms.parentCommentId === parent._id ? children : variables.terms.parentCommentId === children[0]!._id ? [grandchild] : [] } } });
    throw new Error("Unexpected query");
  }) as typeof fetch;
  const source = parseSource(parent.pageUrl);
  if (source.provider !== "forum_magnum") throw new Error("Fixture source is not Forum Magnum");
  const result = await new ForumMagnumProvider(fetcher).discoverRelated(source, "on");
  expect(result.posts).toHaveLength(10);
  expect(result.posts.map(item => item.id)).toContain(grandchild._id);
  expect(result.posts.map(item => item.id)).not.toContain(children[8]!._id);
  expect(result.posts.find(item => item.id === grandchild._id)?.replyTo?.id).toBe(children[0]!._id);
});

test("rich text keeps authored quote boundaries and stable body media refs", async () => {
  const post = publicExamples.alignment_forum!.post;
  const html = "<p>Intro <strong>bold</strong> and <a href='/posts/x'>link</a>.</p><blockquote><p>Quoted source words</p></blockquote>" +
    "<figure><img src='https://images.example.test/one.png' alt='Diagram'><figcaption>Figure note</figcaption></figure>" +
    "<p><img data-src='/two.png' alt='Second'></p><iframe src='https://www.youtube.com/embed/abc'></iframe>";
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const { query } = JSON.parse(String(init?.body));
    if (query.includes("ForumPost")) return Response.json({ data: { post: { result: { ...post, contents: { html } } } } });
    throw new Error(`Unexpected request: ${input}`);
  }) as typeof fetch;
  const ref = post.pageUrl;
  const plan = await new SocialResolver({ forum_magnum: new ForumMagnumProvider(fetcher) }).resolveComposition([ref], [], { media: "selected", selectedMedia: ["1.1", "1.2"] });
  expect(plan.posts[0]!.media.map(item => item.url)).toEqual(["https://images.example.test/one.png", "https://www.alignmentforum.org/two.png"]);
  expect(plan.posts[0]!.media.map(item => item.ref)).toEqual(["1.1", "1.2"]);
  expect(plan.posts[0]!.text).toContain("> Quoted source words");
  expect(plan.posts[0]!.text).toContain("*Caption:* Figure note");
  expect(plan.posts[0]!.mediaIssues).toMatchObject([{ status: "unsupported" }]);
  expect(composePlan(plan.posts, plan.policy).block.selectedMedia).toEqual(["1.1", "1.2"]);
});

test("unavailable and mismatched content fails closed", async () => {
  const post = publicExamples.lesswrong!.post;
  const comment = publicExamples.lesswrong!.comments[0]!;
  const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const { query } = JSON.parse(String(init?.body));
    return Response.json({ data: query.includes("ForumPost") ? { post: { result: post } } : { comment: { result: { ...comment, deleted: true } } } });
  }) as typeof fetch;
  await expect(new ForumMagnumProvider(fetcher).resolve(parseSource(sample))).rejects.toThrow("unavailable, private, or deleted");
  const missing = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const { query } = JSON.parse(String(init?.body));
    return Response.json({ data: query.includes("ForumPost") ? { post: { result: post } } : { comment: { result: null } } });
  }) as typeof fetch;
  await expect(new ForumMagnumProvider(missing).resolve(parseSource(sample))).rejects.toThrow("unavailable or private");
  const privatePost = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const { query } = JSON.parse(String(init?.body));
    return Response.json({ data: query.includes("ForumPost") ? { post: { result: { ...post, draft: true } } } : { comment: { result: comment } } });
  }) as typeof fetch;
  await expect(new ForumMagnumProvider(privatePost).resolve(parseSource(sample))).rejects.toThrow("unavailable, private, or deleted");
  const wrongPost = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const { query } = JSON.parse(String(init?.body));
    return Response.json({ data: query.includes("ForumPost") ? { post: { result: post } } : { comment: { result: { ...comment, postId: "WrongPostABC123" } } } });
  }) as typeof fetch;
  await expect(new ForumMagnumProvider(wrongPost).resolve(parseSource(sample))).rejects.toThrow("different post");
  const denied = (async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("Forbidden", { status: 403 })) as typeof fetch;
  await expect(new ForumMagnumProvider(denied).resolve(parseSource(sample))).rejects.toThrow("HTTP 403");
});

test("extension preview receives Forum Magnum sources and requests exact public API origins", async () => {
  expect(requiredOrigins([sample, ea, af, "https://greaterwrong.com/posts/6eaKqtmDuo6CmkqMK/loops-s-shortform"])).toEqual([
    "https://www.lesswrong.com/*", "https://forum.effectivealtruism.org/*", "https://www.alignmentforum.org/*",
  ]);
  const { fetcher } = fixtureFetch();
  const plan = await resolveCapture({ primary: [sample, ea], extras: [], policy: { threadExpansion: "off" } }, undefined, fetcher);
  const cliResolved = await new SocialResolver({ forum_magnum: new ForumMagnumProvider(fixtureFetch().fetcher) })
    .resolveComposition([sample, ea], [], { threadExpansion: "off" });
  expect(plan).toEqual(composePlan(cliResolved.posts, cliResolved.policy));
  expect(previewFields(plan)).toEqual(publicationFields(plan));
  expect(plan.sources.map(post => post.id)).toEqual(["7C9iqsDCdxC2PfKDf", "Myoki5MsXgG8Jmb2J"]);
  expect(plan.block.kind).toBe("text");
  expect(plan.block.canonicalSource).toBe(sample);
  expect(requiredPlanCapabilities(plan)).toEqual(["forum-magnum-posts-v1"]);
});

test("extension and CLI agree when an observed x.com thread includes a Forum Magnum source", async () => {
  const observed = await Bun.file(new URL("./fixtures/x-argon-thread-public.json", import.meta.url)).json();
  const forumFetch = fixtureFetch().fetcher;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("api.fxtwitter.com/2/thread/")) return Response.json(observed);
    if (url.endsWith(`/status/${observed.thread[0].quote.id}`))
      return Response.json({ code: 200, tweet: observed.thread[0].quote });
    return forumFetch(input, init);
  }) as typeof fetch;
  const policy = { threadExpansion: "on" as const, media: "none" as const };
  const extensionPlan = await resolveCapture({ primary: [observed.source], extras: [sample], policy }, undefined, fetcher);
  const cliResolved = await new SocialResolver({ x: new XProvider(undefined, fetcher),
    forum_magnum: new ForumMagnumProvider(fetcher) }).resolveComposition([observed.source], [sample], policy);
  const cliPlan = composePlan(cliResolved.posts, cliResolved.policy);
  expect(extensionPlan).toEqual(cliPlan);
  expect(extensionPlan.sources).toHaveLength(22);
  expect(extensionPlan.sources[21]?.provider).toBe("forum_magnum");
  expect(requiredPlanCapabilities(extensionPlan)).toEqual(["expanded-source-count-32-v1", "forum-magnum-posts-v1"]);
  expect(requiredOrigins([observed.source, sample])).toEqual(["https://api.fxtwitter.com/*", "https://www.lesswrong.com/*"]);
  expect(previewFields(extensionPlan)).toEqual(publicationFields(cliPlan));
});

const liveTest = process.env.FORUM_MAGNUM_LIVE === "1" ? test : test.skip;
liveTest("live public receiving examples across three Forum Magnum sites", async () => {
  const provider = new ForumMagnumProvider();
  for (const [ref, id, handle] of [[sample, "7C9iqsDCdxC2PfKDf", "smitop"], [ea, "Myoki5MsXgG8Jmb2J", "Bluefalcon"], [af, "2CxekqM5fc87mmqXn", "sharmake-farah"]]) {
    const result = await provider.resolve(parseSource(ref!));
    expect(result).toMatchObject({ id, author: { handle } });
    expect(result.text.trim().length).toBeGreaterThan(20);
  }
  const article = await provider.resolve(parseSource("https://www.alignmentforum.org/posts/bxt7uCiHam4QXrQAA/cyborgism"));
  expect(article.postTitle).toBe("Cyborgism");
  expect(article.media.length).toBeGreaterThan(10);
  expect(article.text).toContain("> ");
});
