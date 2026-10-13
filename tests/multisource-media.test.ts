import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { arenaMediaPost, ArenaMediaProvider } from "../packages/core/providers/arena-media.ts";
import { SocialResolver } from "../packages/core/providers/index.ts";
import { sourceComposition } from "../src/capture.ts";
import { composePlan, planHash } from "../src/compose.ts";
import { parseSource, arenaDestination } from "../src/url.ts";
import { blockPlanSchema, planInputSchema, type ResolvedPost, type LayoutNode } from "../src/types.ts";
import { captureRenderRecipe } from "../packages/core/render-recipe.ts";
import { createService } from "../src/service.ts";

const image = { src: "https://images.are.na/original.png", content_type: "image/png", width: 640, height: 480, alt_text: "Source alt text", updated_at: "2026-10-02T00:00:00Z" };
const block = { id: 123, type: "Image", state: "available", title: "Source title", user: { slug: "curator", name: "Curator" },
  description: { markdown: "Source caption\n\nSecond paragraph." }, source: { url: "https://example.com/original" }, image,
  updated_at: "2026-10-03T00:00:00Z" };
const base: ResolvedPost = { provider: "x", id: "1", canonicalUrl: "https://x.com/person/status/1", author: { handle: "person" }, text: "Base prose",
  media: [{ ref: "1.1", kind: "image", url: "https://example.com/base.jpg", width: 640, height: 480, alt: "" },
    { ref: "1.2", kind: "video", url: "https://example.com/base.mp4", width: 640, height: 480, alt: "" }] };
const leaves = (node: LayoutNode): string[] => node.kind === "media" ? [node.ref] : node.children.flatMap(leaves);

test("Are.na block sources retain original media, caption, identity and returned timestamps", () => {
  for (const url of ["https://are.na/block/123?context=channel", "https://www.are.na/block/123"]) {
    expect(parseSource(url)).toEqual({ provider: "arena", id: "123", canonicalUrl: "https://www.are.na/block/123" });
    expect(arenaDestination(url)).toBeUndefined();
  }
  const post = arenaMediaPost(block, 123);
  expect(post.text).toBe(block.description.markdown);
  expect(post.media[0]).toMatchObject({ id: "123", kind: "image", url: image.src, alt: image.alt_text, width: 640, height: 480, sourceRole: "original" });
  expect(post.arenaBlock).toEqual({ type: "Image", sourceURL: block.source.url, updatedAt: block.updated_at, mediaUpdatedAt: image.updated_at });
  const plan = composePlan([{ ...post, media: post.media.map(media => ({ ...media, ref: "1.1" })) }]);
  expect(plan.block).toMatchObject({ title: block.title, canonicalSource: post.canonicalUrl, markdown: block.description.markdown, selectedMedia: ["1.1"], kind: "link" });
  expect(blockPlanSchema.parse(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
});

test("non-text previews remain distinguishable from original video/image media", () => {
  const link = arenaMediaPost({ ...block, type: "Link" }, 123);
  expect(link.media[0]).toMatchObject({ kind: "image", url: image.src, sourceRole: "preview" });
  const video = arenaMediaPost({ ...block, type: "Attachment", attachment: { url: "https://attachments.are.na/film.mp4", content_type: "video/mp4", image } }, 123);
  expect(video.media).toHaveLength(1);
  expect(video.media[0]).toMatchObject({ kind: "video", url: "https://attachments.are.na/film.mp4", sourceRole: "original" });
  const pdf = arenaMediaPost({ ...block, type: "Attachment", attachment: { url: "https://attachments.are.na/document.pdf", content_type: "application/pdf", image } }, 123);
  expect(pdf.media[0]).toMatchObject({ kind: "image", url: image.src, sourceRole: "preview" });
  const embed = arenaMediaPost({ ...block, type: "Embed", image: null, embed: { thumbnail_url: "https://example.com/thumbnail.jpg" } }, 123);
  expect(embed.media[0]).toMatchObject({ kind: "image", sourceRole: "preview", url: "https://example.com/thumbnail.jpg" });
});

test("Are.na text, absent media, unavailable state, mismatched identity and credential URLs fail", () => {
  for (const [value, expected] of [
    [{ ...block, type: "Text" }, "Text block"], [{ ...block, image: null }, "no usable"],
    [{ ...block, type: "Attachment", attachment: { url: "https://example.com/audio.mp3", content_type: "audio/mpeg" } }, "no usable"],
    [{ ...block, id: 124 }, "different source"], [{ ...block, state: "processing" }, "available"],
    [{ ...block, image: { ...image, src: "https://user:secret@example.com/image.jpg" } }, "HTTPS"],
  ] as const) expect(() => arenaMediaPost(value, 123)).toThrow(expected);
  for (const url of ["http://are.na/block/123", "https://are.na/block/0", "https://are.na:444/block/123", "https://are.na/block/123/extra"])
    expect(() => parseSource(url)).toThrow();
});

test("public Are.na resolution uses only its fixed v3 read endpoint and preserves input order", async () => {
  const provider = new ArenaMediaProvider(async (url, init) => {
    expect(url).toBe("https://api.are.na/v3/blocks/123");
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    await Promise.resolve();
    return Response.json(block);
  });
  const resolver = new SocialResolver({ arena: provider, x: { resolve: async () => base } });
  const posts = await resolver.resolve(["https://www.are.na/block/123", base.canonicalUrl]);
  expect(posts.map(post => post.id)).toEqual(["123", "1"]);
  expect(posts.flatMap(post => post.media.map(item => item.ref))).toEqual(["1.1", "2.1", "2.2"]);
  await expect(new ArenaMediaProvider(async () => new Response("", { status: 403 })).resolve(parseSource("https://www.are.na/block/123"))).rejects.toThrow("403");
});

test("complete media order can move the first source behind extras and interleave media kinds", () => {
  const extra = { ...arenaMediaPost(block, 123), media: [{ ...arenaMediaPost(block, 123).media[0]!, ref: "2.1" }] };
  const posts = [base, extra], before = JSON.stringify(posts);
  const order = ["2.1", "1.2", "1.1"];
  const plan = composePlan(posts, { mediaOnlyPosts: [2], mediaOrder: order, audio: "1.2" });
  expect(plan.block.selectedMedia).toEqual(order);
  expect(leaves(plan.block.layout!)).toEqual(order);
  expect(plan.sources).toEqual(posts);
  expect(JSON.stringify(posts)).toBe(before);
  expect(plan.block.markdown).toBe(composePlan([base]).block.markdown);
  const recipe = captureRenderRecipe(plan, { "1.2": { width: 640, height: 480, duration: 2, fps: 30, audio: true } })!;
  expect(recipe.tiles.map(tile => tile.ref)).toEqual(order);
  expect(recipe.audio).toEqual(["1.2"]);
  expect(blockPlanSchema.parse(plan)).toEqual(plan);
  const { hash, ...content } = plan;
  expect(hash).toBe(planHash(content));
  expect(hash).not.toBe(composePlan(posts, { mediaOnlyPosts: [2] }).hash);
  for (const mediaOrder of [["1.1"], ["2.1", "1.1", "1.1"], ["2.1", "1.1", "3.1"]])
    expect(() => composePlan(posts, { mediaOnlyPosts: [2], mediaOrder })).toThrow("exactly once");
  expect(() => composePlan(posts, { media: "images", mediaOrder: order })).toThrow("exactly once");
  expect(composePlan(posts, { media: "none", mediaOrder: [] }).block.selectedMedia).toEqual([]);
});

test("ordered mosaics follow left-to-right row reading order rather than automatic column grouping", () => {
  const media = Array.from({ length: 4 }, (_, index) => ({ ref: `1.${index + 1}`, kind: "image" as const,
    url: `https://example.com/${index + 1}.jpg`, width: 640, height: 480, alt: "" }));
  const order = ["1.4", "1.2", "1.3", "1.1"];
  const plan = composePlan([{ ...base, media }], { media: "all", mediaOrder: order });
  const recipe = captureRenderRecipe(plan)!;
  const visualOrder = [...recipe.tiles].sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x).map(tile => tile.ref);
  expect(visualOrder).toEqual(order);
});

test("supplementary inputs retain base prose and validate complete scope before resolution", () => {
  const input = sourceComposition([base.canonicalUrl], ["https://are.na/block/123"], { media: "selected", selectedMedia: ["2.1"] });
  expect(input.policy).toEqual({ media: "selected", selectedMedia: ["2.1"], mediaOnlyPosts: [2] });
  expect(input.refs).toEqual([base.canonicalUrl, "https://www.are.na/block/123"]);
  expect(sourceComposition([base.canonicalUrl, `${base.canonicalUrl}?s=20`], ["https://are.na/block/123"]).refs).toEqual(input.refs);
  expect(() => sourceComposition([base.canonicalUrl], Array(20).fill(base.canonicalUrl))).toThrow("20");
  expect(() => sourceComposition([base.canonicalUrl], ["https://example.com/web"])).toThrow("Unsupported");
  expect(planInputSchema.safeParse({ refs: [base.canonicalUrl], extraRefs: Array(20).fill(base.canonicalUrl) }).success).toBe(false);
});

test("backend capture and plan routes accept additional media with ordered stable refs and no Are.na writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arena-multisource-"));
  const originalFetch = globalThis.fetch;
  const reads: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    reads.push(String(url));
    expect(init?.method ?? "GET").toBe("GET");
    if (String(url).startsWith("https://api.are.na/v3/blocks/")) return Response.json(block);
    const id = String(url).match(/status\/(\d+)/)?.[1] ?? "1";
    return Response.json({ tweet: { id, author: { screen_name: "person" }, text: `Base prose ${id}`, media: { photos: [{ url: `https://example.com/${id}.jpg`, width: 640, height: 480 }] } } });
  }) as typeof fetch;
  const service = createService({ host: "127.0.0.1", port: 0, publicBaseUrl: "https://engine.invalid", stateDirectory: directory,
    mediaDirectory: join(directory, "media"), accessToken: "fixture-engine", arenaToken: "fixture-account" });
  try {
    for (const path of ["/v1/capture/preview", "/v1/plans"]) {
      const response = await service.handler(new Request(`https://engine.invalid${path}`, { method: "POST", headers: { authorization: "Bearer fixture-engine", "content-type": "application/json" },
        body: JSON.stringify({ ...(path.endsWith("preview") ? { url: base.canonicalUrl } : { refs: [base.canonicalUrl] }), extraRefs: ["https://are.na/block/123"], policy: { mediaOrder: ["2.1", "1.1"] } }) }));
      expect(response.status).toBe(200);
      const body = await response.json();
      const plan = path.endsWith("preview") ? body.plan : body;
      expect(plan.block.selectedMedia).toEqual(["2.1", "1.1"]);
      expect(plan.block.markdown).not.toContain("Source caption");
      expect(plan.sources[1].arenaBlock.sourceURL).toBe(block.source.url);
    }
    const combined = await service.handler(new Request("https://engine.invalid/v1/capture/preview", { method: "POST",
      headers: { authorization: "Bearer fixture-engine", "content-type": "application/json" },
      body: JSON.stringify({ refs: [base.canonicalUrl, "https://x.com/person/status/2"], extraRefs: ["https://are.na/block/123"] }) }));
    expect(combined.status).toBe(200);
    const combinedPlan = (await combined.json()).plan;
    expect(combinedPlan.sources.map((source: ResolvedPost) => source.selection?.role)).toEqual(["primary", "primary", "extra"]);
    expect(combinedPlan.block.selectedMedia).toEqual(["1.1", "2.1", "3.1"]);
    expect(combinedPlan.block.markdown).toContain("Base prose 2");
    expect(combinedPlan.block.markdown).not.toContain("Source caption");
    // The service's resolver reuses the base source snapshot; each explicit Are.na read remains fresh.
    expect(reads.filter(url => url.includes("api.fxtwitter.com"))).toHaveLength(2);
    expect(reads.filter(url => url.includes("api.are.na"))).toHaveLength(3);
  } finally { await service.close(); globalThis.fetch = originalFetch; await rm(directory, { recursive: true, force: true }); }
});
