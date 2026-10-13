import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composePlan, planHash } from "../src/compose.ts";
import { blockPlanSchema, type ResolvedPost } from "../src/types.ts";

function post(index: number, kinds: ("image" | "video")[] = []): ResolvedPost {
  return {
    provider: "x", id: String(index), canonicalUrl: `https://x.com/example/status/${index}`,
    author: { handle: `author${index}` }, text: `Text ${index}`,
    media: kinds.map((kind, media) => ({ ref: `${index}.${media + 1}`, kind, url: `https://example.test/${index}/${media}`, alt: "", width: 640, height: 480 })),
  };
}

function leaves(node: NonNullable<ReturnType<typeof composePlan>["block"]["layout"]>): string[] {
  return node.kind === "media" ? [node.ref] : node.children.flatMap(leaves);
}

describe("supplementary media", () => {
  test.each([
    [["image"], ["image"]],
    [[], ["image"], ["image"]],
    [["video"], ["video"]],
    [["image", "video"], ["video", "image"], []],
  ] as ("image" | "video")[][][])("combines attachments while preserving base prose: %j", (...kinds) => {
    const posts = kinds.map((items, index) => post(index + 1, items));
    posts[0]!.article = "Base article";
    posts[1]!.article = "Extra article";
    posts[1]!.quote = post(9, ["image"]);
    const base = composePlan([posts[0]!]);
    const plan = composePlan(posts, { mediaOnlyPosts: posts.slice(1).map((_, index) => index + 2) });
    expect(plan.block.markdown).toBe(base.block.markdown);
    expect(plan.block.description).toBe(base.block.description);
    expect(plan.block.title).toBe(base.block.title);
    expect(plan.block.canonicalSource).toBe(base.block.canonicalSource);
    const refs = posts.flatMap(post => post.media.map(asset => asset.ref));
    expect(plan.block.selectedMedia).toEqual(refs);
    expect(leaves(plan.block.layout!).sort()).toEqual([...refs].sort());
    expect(plan.sources).toEqual(posts);
    expect(blockPlanSchema.parse(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
    const { hash, ...content } = plan;
    expect(planHash(content)).toBe(hash);
  });

  test("honors explicit selectors across sources", () => {
    const posts = [post(1, ["image"]), post(2, ["video", "image"])];
    for (const [media, expected] of [["none", []], ["images", ["1.1", "2.2"]], ["video", ["2.1"]], ["all", ["1.1", "2.1", "2.2"]]] as const) {
      expect(composePlan(posts, { mediaOnlyPosts: [2], media }).block.selectedMedia).toEqual([...expected]);
    }
    expect(composePlan(posts, { mediaOnlyPosts: [2], media: "selected", selectedMedia: ["2.2"] }).block.selectedMedia).toEqual(["2.2"]);
    expect(() => composePlan(posts, { mediaOnlyPosts: [2], media: "selected", selectedMedia: ["3.1"] })).toThrow();
  });

  test("validates supplementary indexes and source count", () => {
    for (const index of [0, 1, 3, 2.5]) expect(() => composePlan([post(1), post(2)], { mediaOnlyPosts: [index] })).toThrow();
    expect(() => composePlan(Array.from({ length: 21 }, (_, index) => post(index + 1)))).toThrow(/20/);
  });

  test("empty supplementary posts contribute nothing and ordinary policies stay unchanged", () => {
    const base = composePlan([post(1)]);
    expect(base.policy).not.toHaveProperty("mediaOnlyPosts");
    expect(composePlan([post(1), post(2)], { mediaOnlyPosts: [2] }).block).toEqual(base.block);
    expect(composePlan([post(1, ["image"]), post(2, ["image"])]).block.kind).toBe("link");
  });
});

const directory = await mkdtemp(join(tmpdir(), "arena-block-cli-"));
const preload = join(directory, "fetch.ts");
await Bun.write(preload, `globalThis.fetch = async (input) => {
  const id = String(input).match(/status\\/(\\d+)/)?.[1];
  if (id === "999") throw new Error("Supplement unavailable");
  return Response.json({ tweet: { id, author: { screen_name: "example" }, text: "Text " + id,
    media: { photos: [{ url: "https://example.test/" + id + ".jpg", width: 640, height: 480 }] } } });
};`);
afterAll(() => rm(directory, { recursive: true, force: true }));

async function cli(args: string[]) {
  const process = Bun.spawn([Bun.which("bun")!, "--preload", preload, "src/cli.ts", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  return { stdout, stderr, code };
}
const base = "https://x.com/example/status/1";
const extra = "https://x.com/example/status/2?s=20";

describe("extra CLI", () => {
  test("orders every selected item independently from source numbering, including the base's first attachment", async () => {
    const result = await cli(["plan", base, "--extra", extra, "--extra", "https://x.com/example/status/3", "--media-order", "3.1,1.1,2.1", "--json"]);
    expect(result.code).toBe(0);
    const plan = JSON.parse(result.stdout);
    expect(plan.block.selectedMedia).toEqual(["3.1", "1.1", "2.1"]);
    expect(leaves(plan.block.layout)).toEqual(["3.1", "1.1", "2.1"]);
    expect(plan.sources.map((source: ResolvedPost) => source.id)).toEqual(["1", "2", "3"]);
    const invalid = await cli(["plan", base, "--extra", extra, "--media-order", "2.1,2.1"]);
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain("exactly once");
  });
  test.each([[], ["plan"]])("accepts repeatable extras: %j", async (...command) => {
    const result = await cli([...command, base, "--extra", extra, "--extra", "https://x.com/example/status/3", "--json", "--to", "test-channel"]);
    expect(result.code).toBe(0);
    const plan = JSON.parse(result.stdout);
    expect(plan.policy.mediaOnlyPosts).toEqual([2, 3]);
    expect(plan.block.selectedMedia).toEqual(["1.1", "2.1", "3.1"]);
    expect(plan.block.markdown).not.toContain("Text 2");
  });

  test("keeps two positional sources primary when an extra supplies only media", async () => {
    const result = await cli(["plan", base, "https://x.com/example/status/3", "--extra", extra, "--json"]);
    expect(result.code).toBe(0);
    const plan = JSON.parse(result.stdout);
    expect(plan.sources.map((source: ResolvedPost) => source.id)).toEqual(["1", "3", "2"]);
    expect(plan.sources.map((source: ResolvedPost) => source.selection?.role)).toEqual(["primary", "primary", "extra"]);
    expect(plan.policy.mediaOnlyPosts).toEqual([3]);
    expect(plan.block.markdown).toContain("Text 1");
    expect(plan.block.markdown).toContain("Text 3");
    expect(plan.block.markdown).not.toContain("Text 2");
    expect(plan.block.selectedMedia).toEqual(["1.1", "2.1", "3.1"]);
  });

  test("rejects invalid combinations before resolving or reading a plan", async () => {
    for (const [args, message] of [
      [["--extra", extra], "At least one"],
      [["plan", base, "--extra", "https://example.com/web"], "Unsupported"],
      [["publish", "--plan", "/nonexistent", "--extra", extra], "cannot accompany"],
      [["plan", base, "--extra", extra, "--media", "1"], "Bare media indexes"],
      [["plan", base, ...Array.from({ length: 20 }, () => ["--extra", extra]).flat()], "20"],
    ] as [string[], string][]) {
      const result = await cli(args);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(message);
    }
  });

  test.each([
    [["plan", base, "--extra", extra, "--audio", "1"], "bare audio index"],
    [["plan", base, "--audio", "1"], "Audio source 1.1 is not a selected video"],
  ] as [string[], string][])("resolves a bare --audio index only for a single post: %j", async (args, message) => {
    const result = await cli(args);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(message);
  });

  test("aborts when an extra cannot be resolved", async () => {
    const result = await cli(["plan", base, "--extra", "https://x.com/example/status/999"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Supplement unavailable");
    expect(result.stdout).toBe("");
  });
});
