import { expect, test } from "bun:test";
import { composePlan } from "../src/compose.ts";
import { SocialResolver } from "../src/providers/index.ts";
import { XProvider } from "../src/providers/x.ts";

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
