import { expect, test } from "bun:test";
import { composePlan } from "../src/compose.ts";
import { SocialResolver } from "../src/providers/index.ts";
import { XProvider } from "../src/providers/x.ts";
import { blockPlanSchema, MAX_EXPANDED_SOURCE_POSTS } from "../src/types.ts";
import { requiredPlanCapabilities } from "../src/plan-capabilities.ts";
import { parseSource } from "../src/url.ts";
import { captureRenderRecipe } from "../packages/core/render-recipe.ts";

const ids = ["99999999999999999002", "99999999999999999003", "99999999999999999004", "99999999999999999005"];
const tweets = ids.map((id, index) => ({
  id, author: { id: "author-1", screen_name: "mathmaker" }, text: `Part ${index + 1}`,
  ...(index ? { replying_to: { status: ids[index - 1], screen_name: "mathmaker" } } : {}),
  ...(index === 0 ? { media: { all: [{ type: "photo", url: "https://cdn.example/diagram.jpg" }] } } : {}),
}));
const extra = { id: "999", author: { id: "other", screen_name: "other" }, text: "Supplementary prose",
  media: { all: [{ type: "photo", url: "https://cdn.example/extra.jpg" }] } };

function resolverWith(thread: unknown = tweets) {
  const calls: string[] = [];
  const provider = new XProvider("https://source.test", async input => {
    const url = String(input); calls.push(url);
    if (url.includes("/2/thread/")) return Response.json({ code: 200, status: tweets[1], thread });
    const id = url.split("/").at(-1);
    const tweet = [...tweets, extra].find(item => item.id === id);
    return tweet ? Response.json({ code: 200, tweet }) : new Response("missing", { status: 404 });
  });
  return { resolver: new SocialResolver({ x: provider }), calls };
}

test("one x.com seed imports a verified linear same-author chain in source order", async () => {
  const { resolver, calls } = resolverWith();
  const selected = await resolver.resolveComposition([`https://x.com/mathmaker/status/${ids[1]}`], [], { threadExpansion: "on" });
  const plan = composePlan(selected.posts, selected.policy);
  expect(plan.sources.map(post => post.id)).toEqual(ids);
  expect(plan.sources.map(post => post.selection?.origin)).toEqual(["expanded", "explicit", "expanded", "expanded"]);
  expect(plan.sources[1]?.selection?.declaredIndex).toBe(1);
  expect(plan.sources[2]?.selection?.parentUri).toBe(`https://x.com/mathmaker/status/${ids[1]}`);
  expect(plan.block.markdown).toBe("Part 1\n\n*[image]*\n\n---\n\nPart 2\n\n---\n\nPart 3\n\n---\n\nPart 4");
  expect(plan.block.selectedMedia).toEqual(["1.1"]);
  expect(calls).toEqual([`https://source.test/2/thread/${ids[1]}`]);
});

test("x.com thread import is opt-in and does not change a single-post save", async () => {
  const { resolver, calls } = resolverWith();
  const selected = await resolver.resolveComposition([`https://x.com/mathmaker/status/${ids[1]}`]);
  expect(selected.posts).toHaveLength(1);
  expect(calls).toEqual([`https://source.test/mathmaker/status/${ids[1]}`]);
});

test("branch, missing seed, and incomplete author chain fail before composition", async () => {
  const branch = tweets.map((item, index) => index === 2 ? { ...item, replying_to: { status: ids[0], screen_name: "mathmaker" } } : item);
  const incomplete = tweets.slice(1);
  const foreign = tweets.map((item, index) => index === 2 ? { ...item, author: { id: "other", screen_name: "other" } } : item);
  for (const chain of [branch, incomplete, foreign, tweets.concat(tweets[3]!)]) {
    const { resolver } = resolverWith(chain);
    await expect(resolver.resolveComposition([`https://x.com/mathmaker/status/${ids[1]}`], [], { threadExpansion: "on" })).rejects.toThrow();
  }
});

test("media-only extras append after imported text and retain their role", async () => {
  const { resolver } = resolverWith();
  const selected = await resolver.resolveComposition([`https://x.com/mathmaker/status/${ids[1]}`],
    ["https://x.com/other/status/999"], { threadExpansion: "on" });
  expect(selected.posts).toHaveLength(5);
  expect(selected.posts[4]?.selection?.role).toBe("extra");
  expect(selected.policy.mediaOnlyPosts).toEqual([5]);
  const plan = composePlan(selected.posts, selected.policy);
  expect(plan.block.markdown).not.toContain("Supplementary prose");
  expect(plan.block.selectedMedia).toEqual(["1.1", "5.1"]);
});

test("the observed 21-post Argon thread keeps every ordered image and its root quote", async () => {
  const observed = await Bun.file(new URL("./fixtures/x-argon-thread-public.json", import.meta.url)).json();
  const quote = observed.thread[0].quote;
  const provider = new XProvider("https://source.test", async input => {
    const url = String(input);
    if (url.includes("/2/thread/")) return Response.json(observed);
    if (url.endsWith(`/status/${quote.id}`)) return Response.json({ code: 200, tweet: quote });
    return new Response("unexpected source read", { status: 404 });
  });
  const selected = await new SocialResolver({ x: provider }).resolveComposition([observed.source], [],
    { media: "all", threadExpansion: "on" });
  const plan = composePlan(selected.posts, selected.policy);
  expect(plan.sources.map(post => post.id)).toEqual(observed.thread.map((tweet: { id: string }) => tweet.id));
  expect(plan.sources).toHaveLength(21);
  expect(plan.sources.every(post => post.media.length === 1)).toBe(true);
  expect(plan.sources[0]?.quote?.id).toBe("2110039322229649783");
  expect(plan.sources[0]?.quote?.author.handle).toBe("GeminiApp");
  expect(plan.sources[20]?.replyTo?.id).toBe(plan.sources[19]?.id);
  expect(plan.sources[20]?.selection?.parentUri).toBe(plan.sources[19]?.canonicalUrl);
  const photoRefs = Array.from({ length: 21 }, (_, index) => `${index + 1}.1`);
  expect(plan.block.selectedMedia).toEqual(["1.1", "1.2", ...photoRefs.slice(1)]);
  const recipe = captureRenderRecipe(plan, { "1.2": { width: 1920, height: 1080, duration: 50.508, fps: 30, audio: true } })!;
  expect(recipe.tiles.map(tile => tile.ref)).toEqual(plan.block.selectedMedia);
  expect(recipe.tiles.filter(tile => tile.kind === "image").map(tile => tile.ref)).toEqual(photoRefs);
  expect(recipe.audio).toEqual(["1.2"]);
  expect(Math.min(...recipe.tiles.map(tile => Math.min(tile.rect.width, tile.rect.height)))).toBeGreaterThanOrEqual(120);
  expect(plan.block.markdown).toContain("Argon is also 34% faster at high effort");
  expect(blockPlanSchema.parse(plan)).toEqual(plan);
  expect(requiredPlanCapabilities(plan)).toEqual(["quoted-video-audio-v1", "expanded-source-count-32-v1"]);
  const images = composePlan(selected.posts, { ...selected.policy, media: "images" });
  expect(images.block.selectedMedia).toEqual(photoRefs);
  const queued = await Bun.file(new URL("./fixtures/x-argon-thread-image-queued-plan.json", import.meta.url)).json();
  expect(queued.hash).toBe("99d148a18238be969afd19676488860cf5d17d81d74ece4ebfdc1d4f1cc920a9");
  expect(composePlan(queued.sources, queued.policy)).toEqual(queued);
});

test("x.com thread failures identify access, discovery, pagination, source mismatch, and genuine cap", async () => {
  const source = parseSource(`https://x.com/mathmaker/status/${ids[1]}`);
  const cases: Array<{ response: Response; error: RegExp }> = [
    { response: new Response("limited", { status: 429 }), error: /rate limited.*429/ },
    { response: new Response("denied", { status: 403 }), error: /denied.*403/ },
    { response: Response.json({ code: 403, status: null }), error: /denied.*403/ },
    { response: Response.json({ code: 200, status: { type: "tombstone", reason: "private", id: ids[1] }, thread: [] }), error: /requested post is private/ },
    { response: Response.json({ code: 404, status: { type: "tombstone", reason: "deleted", id: ids[1] }, thread: [] }), error: /requested post is deleted/ },
    { response: Response.json({ code: 200, status: tweets[1] }), error: /no thread array/ },
    { response: Response.json({ code: 200, status: tweets[1], thread: tweets, cursor: { bottom: "more" } }), error: /paginated or truncated/ },
    { response: Response.json({ code: 200, status: tweets[0], thread: tweets }), error: /different source post/ },
    { response: Response.json({ code: 200, status: tweets[1], thread: Array.from({ length: MAX_EXPANDED_SOURCE_POSTS + 1 }, (_, index) => ({ ...tweets[0], id: String(index + 1) })) }), error: /33 posts, above the 32-post import limit/ },
    { response: Response.json({ code: 200, status: tweets[1], thread: [tweets[0], { type: "tombstone", reason: "deleted", id: ids[1] }] }), error: /contains a deleted post/ },
  ];
  for (const { response, error } of cases) {
    const provider = new XProvider("https://source.test", async () => response.clone());
    await expect(provider.discoverLinear(source)).rejects.toThrow(error);
  }
  await expect(new XProvider("https://source.test", async () => { throw new TypeError("offline"); })
    .discoverLinear(source)).rejects.toThrow(/could not reach the public source/);
  const foreign = tweets.map((tweet, index) => index === 2 ? { ...tweet, author: { id: "foreign", screen_name: "foreign" } } : tweet);
  await expect(new XProvider("https://source.test", async () => Response.json({ code: 200, status: tweets[1], thread: foreign }))
    .discoverLinear(source)).rejects.toThrow(/another author/);
  await expect(new XProvider("https://source.test", async () => Response.json({ code: 200,
    status: { ...tweets[1], author: { id: "foreign", screen_name: "foreign" } }, thread: tweets }))
    .discoverLinear(source)).rejects.toThrow(/source author mismatch/);
});
