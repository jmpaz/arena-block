import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createContext, runInContext } from "node:vm";
import { composePlan, planHash } from "../packages/core/compose.ts";
import { planMedia } from "../packages/core/media-tree.ts";
import { assignMediaRefs } from "../packages/core/providers/provider.ts";
import { blockPlanSchema, type MediaAsset, type ResolvedPost } from "../packages/core/types.ts";
import { mediaSelectionPolicy, resolveCapture, revisePlan } from "../extension/src/core.ts";

const image = (id: string): MediaAsset => ({ ref: "0.0", kind: "image", url: `https://images.example/${id}.jpg`, alt: "Original image", width: 640, height: 480 });
const video = (id: string): MediaAsset => ({ ...image(id), kind: "video", url: `https://video.example/${id}.mp4`, posterUrl: image(id).url, durationSeconds: 5 });
const post = (id: string, media: MediaAsset[], quote?: ResolvedPost, provider: ResolvedPost["provider"] = "x"): ResolvedPost => ({
  provider, id, canonicalUrl: `https://example.com/${id}`, author: { handle: `author${id}` }, text: `Writing ${id}`, media, ...(quote ? { quote } : {}),
});
const tree = (provider: ResolvedPost["provider"] = "x") => assignMediaRefs(post("100", [image("100")], post("200", [image("200")], post("300", [video("300")], undefined, provider), provider), provider), 0);

test.each(["x", "bluesky", "delve", "substack", "reddit", "mastodon"] as const)("%s fresh Auto keeps root media and quote writing, with quoted assets still selectable", provider => {
  const root = tree(provider), before = structuredClone(root);
  const plan = composePlan([root]);
  expect(plan.block.selectedMedia).toEqual(["1.1"]);
  expect(plan.block.kind).toBe("link");
  expect(planMedia(plan).map(asset => asset.ref)).toEqual(["1.1", "1.2", "1.3"]);
  expect(plan.block.markdown).toContain("Writing 200");
  expect(plan.block.markdown).toContain("Writing 300");
  expect(root).toEqual(before);
  expect(composePlan([root], { media: "all" }).block.selectedMedia).toEqual(["1.1", "1.2", "1.3"]);
  const explicit = { media: "selected" as const, selectedMedia: ["1.1", "1.2", "1.3"], mediaOrder: ["1.3", "1.2", "1.1"], videoFrames: ["1.3"] };
  const included = composePlan([root], explicit);
  expect(included.block.selectedMedia).toEqual(explicit.mediaOrder);
  expect(included.block.frameMedia?.map(asset => asset.ref)).toEqual(["1.3"]);
  expect(composePlan(included.sources, included.policy)).toEqual(included);
  expect(composePlan([root], { ...explicit, quoteDepth: 0 }).block.selectedMedia).toEqual(["1.1"]);
});

test("root video behavior and explicit primary/extra media remain unchanged", () => {
  const root = assignMediaRefs(post("100", [video("100"), image("101")], post("200", [image("200")])), 0);
  expect(composePlan([root]).block.selectedMedia).toEqual(["1.1"]);
  expect(composePlan([root]).block.kind).toBe("video");
  const extra = assignMediaRefs(post("400", [image("400")], post("500", [video("500")])), 1);
  expect(composePlan([root, extra], { mediaOnlyPosts: [2] }).block.selectedMedia).toEqual(["1.1", "1.2", "2.1"]);
});

test("quote-only image, video and audio never become an automatic attachment", () => {
  for (const media of [image("200"), video("200"), { ...image("200"), kind: "audio" as const, url: "https://audio.example/200.mp3", acquisition: "substack-public-original" as const }]) {
    const root = assignMediaRefs(post("100", [], post("200", [media])), 0);
    const plan = composePlan([root]);
    expect(plan.block.selectedMedia).toEqual([]);
    expect(plan.block.kind).toBe("text");
    expect(plan.block.markdown).toContain("Writing 200");
    expect(planMedia(plan).map(asset => asset.kind)).toEqual([media.kind]);
  }
});

test("saved Auto drafts retain explicitly named quote order, frame and soundtrack choices", () => {
  const root = tree();
  const ordered = composePlan([root], { mediaOrder: ["1.2", "1.1"] });
  expect(ordered.block.selectedMedia).toEqual(["1.2", "1.1"]);
  const framed = composePlan([root], { videoFrames: ["1.3"] });
  expect(framed.block.selectedMedia).toEqual(["1.1", "1.3"]);
  expect(framed.block.frameMedia?.map(asset => asset.ref)).toEqual(["1.3"]);
  const soundtrack = composePlan([root], { audio: "1.3" });
  expect(soundtrack.block.selectedMedia).toEqual(["1.1", "1.3"]);
  expect(soundtrack.policy.audio).toBe("1.3");
});

test("browser fresh resolution excludes quoted images and its existing checkbox opts in", async () => {
  const fetcher = (async (input: RequestInfo | URL) => {
    const id = new URL(String(input)).pathname.split("/").at(-1)!;
    if (!["100", "200"].includes(id)) throw new Error("Unexpected fixture request");
    return Response.json({ tweet: { id, author: { screen_name: `author${id}` }, text: `Writing ${id}`,
      media: { all: [{ type: "photo", url: image(id).url, width: 640, height: 480 }] },
      ...(id === "100" ? { quote: { id: "200", author: { screen_name: "author200" }, text: "Writing 200" } } : {}) } });
  }) as typeof fetch;
  const fresh = await resolveCapture({ primary: ["https://x.com/author100/status/100"], extras: [], policy: {} }, undefined, fetcher);
  expect(fresh.block.selectedMedia).toEqual(["1.1"]);
  const chosen = revisePlan(fresh, { policy: mediaSelectionPolicy(fresh, "1.2", true) });
  expect(chosen.block.selectedMedia).toEqual(["1.1", "1.2"]);
  expect(revisePlan(chosen, { policy: { quoteAuthorLink: "source" } }).block.selectedMedia).toEqual(["1.1", "1.2"]);
  expect(revisePlan(chosen, { policy: mediaSelectionPolicy(chosen, "1.2", false) }).block.selectedMedia).toEqual(["1.1"]);
});

test("CLI Auto and All exclude quote-only media while exact refs opt in", () => {
  const invoke = (...args: string[]) => {
    const output = Bun.spawnSync([Bun.which("bun")!, "--preload", `${import.meta.dir}/fixtures/quote-depth-cli.ts`, "src/cli.ts", "plan", "https://x.com/author100/status/100", ...args, "--json"], {
      cwd: `${import.meta.dir}/..`, env: { ...process.env, ARENA_BLOCK_ACCESS_TOKEN: "" }, stdout: "pipe", stderr: "pipe",
    });
    expect(output.exitCode, new TextDecoder().decode(output.stderr)).toBe(0);
    return JSON.parse(new TextDecoder().decode(output.stdout));
  };
  expect(invoke().block.selectedMedia).toEqual(["1.1"]);
  expect(invoke("--media", "all").block.selectedMedia).toEqual(["1.1"]);
  expect(invoke("--media", "1.2").block.selectedMedia).toEqual(["1.2"]);
});

test("frozen queued quoted-media plans retain their exact schema, fields and hash", async () => {
  const frozen = await Bun.file(new URL("./fixtures/quoted-image-v1-queued-plan.json", import.meta.url)).json();
  const before = JSON.stringify(frozen), { hash, ...content } = frozen;
  expect(blockPlanSchema.parse(frozen)).toEqual(frozen);
  expect(planHash(content)).toBe(hash);
  expect(revisePlan(frozen, { title: "Edited title" }).block.selectedMedia).toEqual(frozen.block.selectedMedia);
  expect(JSON.stringify(frozen)).toBe(before);
});

test("bundled native composer used by iOS and Share keeps Auto off and explicit selection on", async () => {
  const context = createContext({ nativeSHA256: (value: string) => createHash("sha256").update(value).digest("hex"),
    setTimeout: (fn: () => void, delay: number) => setTimeout(fn, delay).unref(), clearTimeout,
    nativeHTTP: () => { throw new Error("No native network reads expected"); }, nativeCancelHTTP: () => {}, nativeResolveComplete: () => {} });
  runInContext(await Bun.file(new URL("../ios/Sources/CaptureRuntime/Resources/capture-core.js", import.meta.url)).text(), context);
  const sources = JSON.stringify([tree()]);
  expect(JSON.parse(context.captureCompose(sources, "{}")).plan.block.selectedMedia).toEqual(["1.1"]);
  const policy = { media: "selected", selectedMedia: ["1.2", "1.3"], videoFrames: ["1.3"] };
  expect(JSON.parse(context.captureCompose(sources, JSON.stringify(policy))).plan.block.selectedMedia).toEqual(policy.selectedMedia);
});
