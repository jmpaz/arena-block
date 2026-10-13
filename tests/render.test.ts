import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { composePlan } from "../src/compose.ts";
import { canvasSize, even, mosaicArguments, probe, renderPlan, tileRects, videoBitrate, type Mosaic, type Tile } from "../src/render.ts";
import type { LayoutNode, MediaAsset, ResolvedPost } from "../src/types.ts";

const ffmpeg = Bun.which("ffmpeg");
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function asset(ref: string, kind: MediaAsset["kind"], width: number, height: number): MediaAsset {
  return { ref, kind, url: `https://example.test/${ref}`, width, height, alt: "" };
}

const videoBesideStackedImages: LayoutNode = {
  kind: "split",
  axis: "horizontal",
  children: [
    { kind: "media", ref: "1.1" },
    { kind: "split", axis: "vertical", children: [{ kind: "media", ref: "1.2" }, { kind: "media", ref: "1.3" }] },
  ],
};
const videoBesideStackedImagesAssets = new Map([
  ["1.1", asset("1.1", "video", 2846, 2160)],
  ["1.2", asset("1.2", "image", 2048, 1536)],
  ["1.3", asset("1.3", "image", 2048, 1536)],
]);

describe("video normalization", () => {
  test("snaps dimensions to even pixels", () => {
    expect(even(1275.2)).toBe(1276);
    expect(even(967.6)).toBe(968);
    expect(even(3)).toBe(4);
  });

  test("sizes the canvas from the long edge", () => {
    expect(canvasSize(2556 / 1396, 1920)).toEqual({ width: 1920, height: 1048 });
    expect(canvasSize(0.5, 1920)).toEqual({ width: 960, height: 1920 });
    expect(canvasSize(10, 1920)).toEqual({ width: 1920, height: 480 });
  });

  test("budgets the bitrate under the attachment limit for any duration", () => {
    expect(videoBitrate(185.4)).toBe(9881750);
    for (const duration of [2, 35.333, 185.4, 600]) {
      expect(videoBitrate(duration) * (duration + 2) + 192_000 * duration)
        .toBeLessThanOrEqual(250 * 1024 * 1024 * 8 * 0.9);
    }
  });

  test("tiles a video beside stacked images on even edges", () => {
    const { size, rects } = tileRects(videoBesideStackedImages, videoBesideStackedImagesAssets, 1920, 120);
    expect(size).toEqual({ width: 1920, height: 968 });
    expect(rects.get("1.1")).toEqual({ x: 0, y: 0, width: 1274, height: 968 });
    expect(rects.get("1.2")).toEqual({ x: 1274, y: 0, width: 646, height: 484 });
    expect(rects.get("1.3")).toEqual({ x: 1274, y: 484, width: 646, height: 484 });
  });

  test("rejects illegible tiles", () => {
    const refs = Array.from({ length: 20 }, (_, index) => `1.${index + 1}`);
    const layout: LayoutNode = { kind: "split", axis: "horizontal", children: refs.map((ref) => ({ kind: "media", ref })) };
    const assets = new Map(refs.map((ref) => [ref, asset(ref, "image", 100, 100)]));
    expect(() => tileRects(layout, assets, 1920, 120)).toThrow(/too dense/);
  });

  test("builds a looping overlay graph budgeted to the longest video", () => {
    const mosaic: Mosaic = {
      width: 1920,
      height: 968,
      fps: 30,
      duration: 35.333,
      bitrate: 50375080,
      audio: [0],
      tiles: [
        { path: "/s/1.1.mp4", kind: "video", rect: { x: 0, y: 0, width: 1274, height: 968 } },
        { path: "/s/1.2", kind: "image", rect: { x: 1274, y: 0, width: 646, height: 484 } },
        { path: "/s/1.3", kind: "image", rect: { x: 1274, y: 484, width: 646, height: 484 } },
      ],
    };
    const argv = mosaicArguments(mosaic, "/s/mosaic.mp4");
    expect(argv.slice(argv.indexOf("-stream_loop"), argv.indexOf("-filter_complex"))).toEqual([
      "-stream_loop", "-1", "-i", "/s/1.1.mp4",
      "-loop", "1", "-framerate", "30", "-i", "/s/1.2",
      "-loop", "1", "-framerate", "30", "-i", "/s/1.3",
    ]);
    expect(argv[argv.indexOf("-filter_complex") + 1]).toBe([
      "color=c=black:s=1920x968:r=30[b0]",
      "[0:v]scale=1274:968:force_original_aspect_ratio=increase,crop=1274:968,setsar=1[t0]",
      "[1:v]scale=646:484:force_original_aspect_ratio=increase,crop=646:484,setsar=1[t1]",
      "[2:v]scale=646:484:force_original_aspect_ratio=increase,crop=646:484,setsar=1[t2]",
      "[b0][t0]overlay=0:0[b1]",
      "[b1][t1]overlay=1274:0[b2]",
      "[b2][t2]overlay=1274:484[b3]",
      "[b3]format=yuv420p[out]",
    ].join(";"));
    expect(argv.slice(argv.indexOf("-map"), argv.indexOf("-map") + 4)).toEqual(["-map", "[out]", "-map", "0:a:0"]);
    expect(argv[argv.indexOf("-t") + 1]).toBe("35.333");
    expect(argv[argv.indexOf("-maxrate") + 1]).toBe("50375080");
    expect(argv[argv.indexOf("-bufsize") + 1]).toBe("100750160");
    const silent = mosaicArguments({ ...mosaic, audio: undefined }, "/s/mosaic.mp4");
    expect(silent).toContain("-an");
    expect(silent).not.toContain("-c:a");
  });

  test("mixes several videos' audio into one track", () => {
    const tile = (path: string, x: number): Tile => ({ path, kind: "video", rect: { x, y: 0, width: 640, height: 480 } });
    const mosaic: Mosaic = {
      width: 1280,
      height: 480,
      fps: 30,
      duration: 3,
      bitrate: 1_000_000,
      audio: [0, 1],
      tiles: [tile("/s/a.mp4", 0), tile("/s/b.mp4", 640)],
    };
    const argv = mosaicArguments(mosaic, "/s/mosaic.mp4");
    expect(argv[argv.indexOf("-filter_complex") + 1])
      .toContain("[0:a][1:a]amix=inputs=2:duration=longest[aout]");
    expect(argv.slice(argv.indexOf("-map"), argv.indexOf("-map") + 4)).toEqual(["-map", "[out]", "-map", "[aout]"]);
    expect(argv).not.toContain("-an");
    const single = mosaicArguments({ ...mosaic, audio: [1] }, "/s/mosaic.mp4");
    expect(single[argv.indexOf("-filter_complex") + 1]).not.toContain("amix");
    expect(single.slice(single.indexOf("-map"), single.indexOf("-map") + 4)).toEqual(["-map", "[out]", "-map", "1:a:0"]);
  });
});

describe("video rendering", () => {
  test.skipIf(!ffmpeg).each([false, true])("composites a clip and a still into one mp4 (supplementary: %s)", async (supplementary) => {
    const directory = await mkdtemp(join(tmpdir(), "arena-block-render-"));
    directories.push(directory);
    const clip = join(directory, "clip.mp4");
    const encode = Bun.spawn([
      ffmpeg!, "-nostdin", "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc=duration=2:size=640x360:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-y", clip,
    ], { stdout: "ignore", stderr: "inherit" });
    expect(await encode.exited).toBe(0);
    const still = join(directory, "still.png");
    const canvas = createCanvas(360, 360);
    const context = canvas.getContext("2d");
    context.fillStyle = "#c04030";
    context.fillRect(0, 0, 360, 360);
    await Bun.write(still, await canvas.encode("png"));

    const posts: ResolvedPost[] = [{
      provider: "x",
      id: "1",
      canonicalUrl: "https://x.com/example/status/1",
      author: { handle: "example" },
      text: "Hello",
      media: [
        { ref: "1.1", kind: "video", url: Bun.pathToFileURL(clip).href, alt: "" },
        { ref: "1.2", kind: "image", url: Bun.pathToFileURL(still).href, width: 360, height: 360, alt: "" },
      ],
    }];
    if (supplementary) {
      const image = posts[0]!.media.pop()!;
      posts.push({ ...posts[0]!, id: "2", canonicalUrl: "https://x.com/example/status/2", text: "Extra", media: [{ ...image, ref: "2.1" }] });
    }
    const plan = composePlan(posts, supplementary ? { mediaOnlyPosts: [2] } : { media: "all" });
    const rendered = join(directory, "rendered");
    const media = await renderPlan(plan, rendered);
    expect(media?.extension).toBe("mp4");
    const report = await probe(media!.path);
    expect(report.width).toBe(640);
    expect(report.height).toBe(230);
    expect(report.duration).toBeGreaterThan(1.9);
    expect(report.duration).toBeLessThan(2.2);
    expect(report.audio).toBe(true);
    expect(await readdir(join(rendered, ".staging"))).toEqual([]);
  }, 60_000);
});
