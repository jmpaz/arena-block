import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createContext, runInContext } from "node:vm";
import { composePlan, planHash } from "../src/compose.ts";
import { publicationFields } from "../src/capture.ts";
import { previewFields, revisePlan } from "../extension/src/core.ts";
import type { ResolvedPost } from "../src/types.ts";

const bundle = await Bun.file(new URL("../ios/Sources/CaptureRuntime/Resources/capture-core.js", import.meta.url)).text();
const context = createContext({
  nativeSHA256: (value: string) => createHash("sha256").update(value).digest("hex"),
  setTimeout, clearTimeout, nativeHTTP() {}, nativeCancelHTTP() {}, nativeResolveComplete() {},
});
runInContext(bundle, context);

const variants: { provider: ResolvedPost["provider"]; title: string; thread: string; fields?: Partial<ResolvedPost> }[] = [
  { provider: "x", title: "Post by @Writer", thread: "Thread by @Writer" },
  { provider: "bluesky", title: "Post by @Writer", thread: "Thread by @Writer" },
  { provider: "delve", title: "Post by @Writer", thread: "Thread by @Writer" },
  { provider: "substack", title: "Note by @Writer", thread: "Thread by @Writer", fields: { postTitle: "Note by @Writer" } },
  { provider: "forum_magnum", title: "Comment by Writer on “A source title”", thread: "Thread by Writer on “A source title”", fields: { storyTitle: "A source title" } },
];

function sequence(variant = variants[0]!, count = 3): ResolvedPost[] {
  const atproto = variant.provider === "bluesky" || variant.provider === "delve";
  const namespace = variant.provider === "delve" ? "town.delve" : "app.bsky";
  const uri = (index: number) => `at://did:plc:writer/${namespace}.feed.post/${100 + index}`;
  const url = (index: number) => variant.provider === "forum_magnum"
    ? `https://www.lesswrong.com/posts/PostIdentity123/a-source-title?commentId=Comment${100 + index}`
    : atproto ? `https://${variant.provider === "bluesky" ? "bsky.app" : "delve.town"}/profile/Writer.test/post/${100 + index}`
    : `https://example.test/${100 + index}`;
  const id = (index: number) => variant.provider === "forum_magnum" ? `Comment${100 + index}` : String(100 + index);
  return Array.from({ length: count }, (_, index): ResolvedPost => ({
    provider: variant.provider, id: id(index), canonicalUrl: url(index),
    author: { handle: "@Writer", name: "Display name" }, text: `Part ${index + 1}.`, media: [], ...variant.fields,
    selection: { role: "primary", origin: index === Math.min(count - 1, 1) ? "explicit" : "expanded",
      ...(index ? { parentUri: variant.provider === "forum_magnum" ? `forum-magnum:lesswrong:comment:${id(index - 1)}` : atproto ? uri(index - 1) : url(index - 1) } : {}) },
    ...(atproto ? { atproto: { uri: uri(index), cid: `cid-${index}`, authorDid: "did:plc:writer", record: { text: `Part ${index + 1}.` } } }
      : index ? { replyTo: { id: id(index - 1) } } : {}),
  }));
}

test.each(variants)("$provider titles use the included thread count across shared, extension and native composition", variant => {
  for (const count of [1, 2, 3, 4]) {
    const posts = sequence(variant, count), policy = { media: "none" as const, threadExpansion: "on" as const };
    const shared = composePlan(posts, policy), expected = count > 2 ? variant.thread : variant.title;
    expect(shared.block.title).toBe(expected);
    expect(shared.block.canonicalSource).toBe(variant.provider === "forum_magnum" ? posts[Math.min(count - 1, 1)]!.canonicalUrl : posts[0]!.canonicalUrl);
    expect(publicationFields(shared).title).toBe(expected);
    const extension = revisePlan(shared, { policy: {} });
    expect(extension).toEqual(shared);
    expect(previewFields(extension).title).toBe(expected);
    const native = JSON.parse(context.captureCompose(JSON.stringify(posts), JSON.stringify(policy)));
    expect(native.plan).toEqual(shared);
    expect(native.fields).toEqual(publicationFields(shared));
  }
});

test("quotes, assets and media-only sources cannot complete a two-post thread title", () => {
  const posts = sequence(variants[0], 2);
  posts[0]!.quote = { ...sequence()[0]!, id: "quoted", quote: { ...sequence()[1]!, id: "nested" } };
  posts[0]!.media = [1, 2, 3].map(index => ({ ref: `1.${index}`, kind: "image", url: `https://example.test/${index}.jpg`, alt: "" }));
  const extras = sequence().slice(2).map(post => ({ ...post, selection: { role: "extra" as const, origin: "expanded" as const } }));
  expect(composePlan([...posts, ...extras]).block.title).toBe("Post by @Writer");
  expect(composePlan([...posts, ...sequence().slice(2)], { mediaOnlyPosts: [3] }).block.title).toBe("Post by @Writer");
  expect(composePlan(posts, { quote: "sequence" }).block.title).toBe("Post by @Writer");
});

test("excluded sources cannot supply expansion evidence while included empty-text posts count", () => {
  const explicit = sequence().map(post => ({ ...post, selection: { ...post.selection!, origin: "explicit" as const } }));
  const extra = { ...sequence()[0]!, id: "extra", selection: { role: "extra" as const, origin: "expanded" as const } };
  expect(composePlan([...explicit, extra]).block.title).toBe("Post by @Writer");
  expect(composePlan([...explicit, { ...extra, selection: { ...extra.selection, role: "primary" } }], { mediaOnlyPosts: [4] }).block.title).toBe("Post by @Writer");
  const included = sequence().map(post => ({ ...post, text: "" }));
  expect(composePlan(included).block.title).toBe("Thread by @Writer");
});

test("an unrelated primary or disconnected expanded source cannot extend a thread title", () => {
  for (const sameAuthor of [true, false]) {
    const unrelated = { ...sequence()[2]!, author: { handle: sameAuthor ? "Writer" : "other" },
      selection: { role: "primary" as const, origin: "explicit" as const } };
    expect(composePlan([...sequence(variants[0], 2), unrelated]).block.title).toBe("Post by @Writer");
  }
  const disconnected = sequence();
  disconnected[2]!.replyTo = { id: "unrelated" };
  expect(composePlan(disconnected).block.title).toBe("Post by @Writer");
  const otherAuthor = sequence(); otherAuthor[2]!.author.handle = "other";
  expect(composePlan(otherAuthor).block.title).toBe("Post by @Writer");
});

test("authored titles remain literal while legacy generated Note titles use the thread label", () => {
  const posts = sequence(variants.find(variant => variant.provider === "substack"));
  posts[0]!.postTitle = "A source's chosen title";
  expect(composePlan(posts).block.title).toBe("A source's chosen title");
  posts[0]!.postTitle = "Substack Note by @Writer";
  expect(composePlan(posts).block.title).toBe("Thread by @Writer");
  posts[0]!.postTitle = "Note by @another";
  expect(composePlan(posts).block.title).toBe("Note by @another");
});

test.each(["bluesky", "delve"] as const)("%s binds parent references to the preceding actor as well as record key", provider => {
  const namespace = provider === "bluesky" ? "app.bsky" : "town.delve";
  const posts = sequence(variants.find(variant => variant.provider === provider));
  for (const [index, post] of posts.entries()) {
    delete post.replyTo;
    if (index) post.selection!.parentUri = `at://did:plc:writer/${namespace}.feed.post/${posts[index - 1]!.id}`;
  }
  expect(composePlan(posts).block.title).toBe("Thread by @Writer");
  posts[2]!.selection!.parentUri = `at://did:plc:other/${namespace}.feed.post/${posts[1]!.id}`;
  expect(composePlan(posts).block.title).toBe("Post by @Writer");
  posts[2]!.selection!.parentUri = `at://did:plc:writer/${namespace}.feed.post/unrelated`;
  expect(composePlan(posts).block.title).toBe("Post by @Writer");
  for (const [index, post] of posts.entries()) {
    delete post.atproto;
    if (index) post.selection!.parentUri = `at://Writer.test/${namespace}.feed.post/${posts[index - 1]!.id}`;
  }
  expect(composePlan(posts).block.title).toBe("Thread by @Writer");
  posts[2]!.selection!.parentUri = `at://did:plc:writer/${namespace}.feed.post/${posts[1]!.id}`;
  expect(composePlan(posts).block.title).toBe("Post by @Writer");
});

test("Forum parent and source site identities must agree for a thread title", () => {
  const posts = sequence(variants.find(variant => variant.provider === "forum_magnum"));
  expect(composePlan(posts).block.title).toBe("Thread by Writer on “A source title”");
  posts[2]!.selection!.parentUri = `forum-magnum:alignment_forum:comment:${posts[1]!.id}`;
  expect(composePlan(posts).block.title).toBe("Comment by Writer on “A source title”");
  posts[2]!.selection!.parentUri = `forum-magnum:lesswrong:comment:${posts[1]!.id}`;
  posts[2]!.canonicalUrl = posts[2]!.canonicalUrl.replace("www.lesswrong.com", "www.alignmentforum.org");
  expect(composePlan(posts).block.title).toBe("Comment by Writer on “A source title”");
});

test("replaying a retained title and editing a custom title preserve the chosen text", () => {
  const { hash: _, ...base } = composePlan(sequence());
  base.block.title = "Post by @Writer";
  const retained = { ...base, hash: planHash(base) };
  expect(revisePlan(retained, {})).toEqual(retained);
  expect(JSON.parse(context.captureFields(JSON.stringify(retained))).title).toBe("Post by @Writer");
  expect(JSON.parse(context.captureEdit(JSON.stringify(retained), "{}")).plan).toEqual(retained);
  expect(revisePlan(retained, { title: "Chosen title" }).block.title).toBe("Chosen title");
});
