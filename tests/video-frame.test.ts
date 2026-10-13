import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { composePlan } from "../src/compose.ts";
import { blockPlanSchema } from "../src/types.ts";
import { renderPlan } from "../src/render.ts";
import { captureRenderRecipe } from "../packages/core/render-recipe.ts";

function sources(poster = "https://cdn.example/frame.jpg?token=one", durationSeconds = 1800) {
  return [
    { provider: "x" as const, id: "1", canonicalUrl: "https://x.com/author/status/1", author: { handle: "author" }, text: "Video post",
      media: [{ ref: "1.1", kind: "video" as const, url: "https://cdn.example/full.mp4", posterUrl: poster,
        durationSeconds, width: 640, height: 360, alt: "" }] },
    { provider: "x" as const, id: "2", canonicalUrl: "https://x.com/author/status/2", author: { handle: "author" }, text: "Diagram post",
      media: [{ ref: "2.1", kind: "image" as const, url: "https://cdn.example/diagram.jpg", width: 640, height: 360, alt: "" }] },
  ];
}

test("an over-limit video becomes an observed frame beside a later image without fetching video", async () => {
  const plan = blockPlanSchema.parse(composePlan(sources()));
  expect(plan.block.kind).toBe("link");
  expect(plan.block.selectedMedia).toEqual(["1.1", "2.1"]);
  expect(plan.block.frameMedia).toEqual([{ ref: "1.1", url: "https://cdn.example/frame.jpg?token=one" }]);
  expect(plan.block.markdown).toContain("*[video frame]*");
  expect(plan.sources[0]?.media[0]?.kind).toBe("video");
  const recipe = captureRenderRecipe(plan);
  expect(recipe?.kind).toBe("link");
  expect(recipe?.tiles[0]).toMatchObject({ ref: "1.1", kind: "image", url: "https://cdn.example/frame.jpg?token=one" });
  const canvas = createCanvas(640, 360);
  const picture = await canvas.encode("png");
  const oldFetch = globalThis.fetch, calls: string[] = [];
  const directory = await mkdtemp(join(tmpdir(), "arena-video-frame-"));
  try {
    globalThis.fetch = (async input => {
      const url = String(input); calls.push(url);
      if (url.endsWith(".mp4")) throw new Error("Full video was fetched");
      return new Response(Uint8Array.from(picture), { status: 200, headers: { "content-length": String(picture.length) } });
    }) as typeof fetch;
    const rendered = await renderPlan(plan, directory);
    expect(rendered?.mimeType).toBe("image/jpeg");
    expect(calls.sort()).toEqual(["https://cdn.example/diagram.jpg", "https://cdn.example/frame.jpg?token=one"].sort());
  } finally { globalThis.fetch = oldFetch; await rm(directory, { recursive: true, force: true }); }
});

test("explicit frame works below the size threshold and signed URL rotation keeps its identity", () => {
  const first = composePlan(sources(undefined, 30), { media: "selected", selectedMedia: ["1.1"], videoFrames: ["1.1"] });
  const rotated = composePlan(sources("https://cdn.example/frame.jpg?token=two", 30),
    { media: "selected", selectedMedia: ["1.1"], videoFrames: ["1.1"] });
  expect(first.block.kind).toBe("link");
  expect(first.block.frameMedia).toEqual([{ ref: "1.1", url: "https://cdn.example/frame.jpg?token=one" }]);
  expect(first.hash).toBe(rotated.hash);
  expect(composePlan(sources("https://cdn.example/other.jpg", 30),
    { media: "selected", selectedMedia: ["1.1"], videoFrames: ["1.1"] }).hash).not.toBe(first.hash);
});

test("a post may contribute zero media while a later post contributes its image", () => {
  const plan = composePlan(sources(undefined, 30), { media: "selected", selectedMedia: ["2.1"] });
  expect(plan.block.kind).toBe("link");
  expect(plan.block.selectedMedia).toEqual(["2.1"]);
  expect(plan.block.frameMedia).toBeUndefined();
  expect(plan.block.markdown).toContain("*[video]*");
});

test("frame selection requires an observed poster and cannot be substituted in a submitted plan", () => {
  expect(() => composePlan(sources("", 30), { media: "selected", selectedMedia: ["1.1"], videoFrames: ["1.1"] })).toThrow("observed poster");
  const plan = composePlan(sources(undefined, 30), { media: "selected", selectedMedia: ["1.1"], videoFrames: ["1.1"] });
  expect(() => blockPlanSchema.parse({ ...plan, block: { ...plan.block,
    frameMedia: [{ ref: "1.1", url: "https://unrelated.example/unrelated.jpg" }] } })).toThrow("observed poster");
});

test("frame threshold is explicit and adjustable within the supported video budget", () => {
  const early = composePlan(sources(undefined, 60), { media: "selected", selectedMedia: ["1.1"], videoFrameThresholdSeconds: 30 });
  const later = composePlan(sources(undefined, 60), { media: "selected", selectedMedia: ["1.1"], videoFrameThresholdSeconds: 120 });
  expect(early.block.kind).toBe("link");
  expect(later.block.kind).toBe("video");
  expect(early.policy.videoFrameThresholdSeconds).toBe(30);
});
