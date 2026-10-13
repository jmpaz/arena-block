import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { XProvider } from "../src/providers/x.ts";
import { parseSource } from "../src/url.ts";
import { composePlan } from "../src/compose.ts";
import { checkVideoInputBudget, MediaBudgetError, renderPlan, run, videoHeaderSize } from "../src/render.ts";
import { ArenaClient, ArenaPublisher } from "../src/arena.ts";
import { ArenaBlockStore } from "../src/store.ts";
import { SaveGateway } from "../src/save-gateway.ts";
import { prepareSaveIntent } from "../src/save-intent.ts";
import { userConfigSchema } from "../src/config.ts";
import { MockApi } from "./fixtures/remote-api.ts";

test("x.com source duration is retained alongside the chosen video variant", async () => {
  const provider = new XProvider("https://source.invalid", async () => Response.json({ code: 200, tweet: {
    id: "1", author: { screen_name: "fixture" }, text: "Moving original", media: { all: [{
      type: "video", url: "https://video.example.test/low.mp4", duration: 2836.9,
      thumbnail_url: "https://pbs.twimg.com/media/fixture.jpg",
      width: 1248, height: 1246, variants: [
        { bitrate: 256000, url: "https://video.example.test/low.mp4" },
        { bitrate: 10368000, url: "https://video.example.test/high.mp4" },
      ],
    }] },
  } }) as unknown as Response);
  const source = await provider.resolve(parseSource("https://x.com/fixture/status/1"));
  expect(source.media[0]).toMatchObject({ kind: "video", url: "https://video.example.test/high.mp4",
    posterUrl: "https://pbs.twimg.com/media/fixture.jpg", durationSeconds: 2836.9 });
});

test("header inspection reads size without a body and honors caller cancellation", async () => {
  const size = await videoHeaderSize("https://video.example.test/large.mp4", undefined,
    (async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("HEAD");
      return new Response(null, { status: 200, headers: { "content-length": "3507375951" } });
    }) as unknown as typeof fetch);
  expect(size).toBe(3_507_375_951);
  const cancelled = new AbortController(); cancelled.abort();
  await expect(videoHeaderSize("https://video.example.test/large.mp4", cancelled.signal,
    (async () => new Promise<Response>(() => {})) as unknown as typeof fetch)).rejects.toThrow();
});

test("retained plans with missing duration reject an oversized video from headers before probing or creating", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arena-video-head-"));
  const previous = globalThis.fetch;
  const requests: string[] = [];
  try {
    const sources = ["1", "2"].map((id, index) => ({ provider: "x" as const, id,
      canonicalUrl: `https://x.com/fixture/status/${id}`, author: { handle: "fixture" }, text: "Source media",
      media: [{ ref: `${index + 1}.1`, kind: "video" as const, url: `https://video.example.test/${id}.mp4`, width: 640, height: 360, alt: "" }] }));
    const plan = composePlan(sources, { media: "all", mediaOnlyPosts: [2] });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(`${init?.method} ${new URL(String(input)).pathname}`);
      if (init?.method !== "HEAD") throw new Error("Full video download was attempted");
      const length = String(input).includes("/2.mp4") ? "3507375951" : "228765234";
      return new Response(null, { status: 200, headers: { "content-length": length } });
    }) as typeof fetch;
    await expect(renderPlan(plan, directory)).rejects.toThrow(MediaBudgetError);
    expect(requests).toEqual(["HEAD /1.mp4", "HEAD /2.mp4"]);
    expect(() => checkVideoInputBudget("2.1", 2836.9, 3_507_375_951)).toThrow("47 minutes");
  } finally { globalThis.fetch = previous; await rm(directory, { recursive: true, force: true }); }
});

test("cancelling a stalled header read stops preflight without starting media work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arena-video-cancel-"));
  const previous = globalThis.fetch;
  const controller = new AbortController();
  let reads = 0;
  try {
    const plan = composePlan([{ provider: "x", id: "1", canonicalUrl: "https://x.com/fixture/status/1",
      author: { handle: "fixture" }, text: "Source", media: [{ ref: "1.1", kind: "video", url: "https://video.example.test/1.mp4",
        width: 640, height: 360, alt: "" }] }], { media: "all" });
    globalThis.fetch = (async () => { reads++; controller.abort(new Error("Cancelled by fixture"));
      return new Promise<Response>(() => {}); }) as unknown as typeof fetch;
    await expect(renderPlan(plan, directory, { signal: controller.signal })).rejects.toThrow("Cancelled by fixture");
    expect(reads).toBe(1);
  } finally { globalThis.fetch = previous; await rm(directory, { recursive: true, force: true }); }
});

test("a staged probe overrides a stale short provider duration before encoding", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arena-video-staged-"));
  const log = join(directory, "ffmpeg-calls.txt");
  try {
    const ffmpeg = join(directory, "ffmpeg"), ffprobe = join(directory, "ffprobe");
    await Bun.write(ffmpeg, `#!/bin/sh\nprintf 'call\\n' >> "$ARENA_TEST_FFMPEG_LOG"\nfor target do :; done\nprintf 'staged-video' > "$target"\n`);
    await Bun.write(ffprobe, `#!/bin/sh\nprintf '%s\\n' '{"streams":[{"codec_type":"video","width":640,"height":360,"duration":"2836.9"}],"format":{"duration":"2836.9"}}'\n`);
    await chmod(ffmpeg, 0o755); await chmod(ffprobe, 0o755);
    const child = join(directory, "exercise.ts");
    await Bun.write(child, `
import { composePlan } from ${JSON.stringify(join(import.meta.dir, "../src/compose.ts"))};
import { renderPlan, MediaBudgetError } from ${JSON.stringify(join(import.meta.dir, "../src/render.ts"))};
globalThis.fetch = (async () => new Response(null, { status: 200, headers: { "content-length": "1024" } })) as typeof fetch;
const plan = composePlan([{ provider: "x", id: "1", canonicalUrl: "https://x.com/fixture/status/1",
  author: { handle: "fixture" }, text: "Source", media: [{ ref: "1.1", kind: "video", url: "https://video.example.test/1.mp4",
    width: 640, height: 360, durationSeconds: 30, alt: "" }] }], { media: "all" });
try { await renderPlan(plan, ${JSON.stringify(join(directory, "media"))}); process.exitCode = 2; }
catch (error) { if (!(error instanceof MediaBudgetError) || !error.message.includes("47 minutes")) { console.error(error); process.exitCode = 1; } }
`);
    const processUnderTest = Bun.spawn([process.execPath, child], { env: { ...process.env,
      PATH: `${directory}:${process.env.PATH ?? ""}`, ARENA_TEST_FFMPEG_LOG: log }, stdout: "pipe", stderr: "pipe" });
    const [exitCode, stderr] = await Promise.all([processUnderTest.exited, new Response(processUnderTest.stderr).text()]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect((await readFile(log, "utf8")).trim().split("\n")).toHaveLength(1); // staging only; no composition encode
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a staged copy exceeding its byte budget is killed and fails instead of returning a truncated video", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arena-video-budget-"));
  try {
    const command = join(directory, "write-video"), output = join(directory, "staged.mp4");
    await Bun.write(command, `#!/bin/sh\nprintf '%0128d' 0 > "$1"\nexec sleep 5\n`);
    await chmod(command, 0o755);
    const started = performance.now();
    await expect(run([command, output], undefined, { path: output, bytes: 64, ref: "1.1" })).rejects.toThrow(MediaBudgetError);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect((await readFile(output)).byteLength).toBeGreaterThan(64);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("multiple destinations retain one UUID and no block on an oversized second video", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arena-video-save-"));
  const previous = globalThis.fetch;
  const store = new ArenaBlockStore(join(directory, "state.sqlite"), { private: true });
  const api = new MockApi();
  const client = new ArenaClient("fixture-never-live", "https://arena.invalid/v3", (...args) => api.fetch(...args), 100);
  const publisher = new ArenaPublisher(client, store, { publicBaseUrl: "https://fixture.invalid", mediaDirectory: join(directory, "media") });
  const gateway = new SaveGateway(client, publisher, store, { profile: "shared", expectedAccountId: 47 }, undefined, 2_000);
  try {
    const sources = ["1", "2"].map((id, index) => ({ provider: "x" as const, id,
      canonicalUrl: `https://x.com/fixture/status/${id}`, author: { handle: "fixture" }, text: "Source media",
      media: [{ ref: `${index + 1}.1`, kind: "video" as const, url: `https://video.example.test/${id}.mp4`, width: 640, height: 360, alt: "" }] }));
    const plan = composePlan(sources, { media: "all", mediaOnlyPosts: [2] });
    const intent = prepareSaveIntent(plan, userConfigSchema.parse({ defaultDestinations: [], provenance: { local: false, remoteSnapshot: "none" } }),
      { origin: "cli", initiator: { kind: "human" }, operation: "publish", destinations: ["901", "902"] });
    const submission = { plan, snapshot: intent.snapshot, snapshotSha256: intent.snapshotSha256 };
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== "HEAD") throw new Error("Full media request was attempted");
      return new Response(null, { status: 200, headers: { "content-length": String(String(input).includes("/2.mp4") ? 3_507_375_951 : 228_765_234) } });
    }) as typeof fetch;
    await expect(gateway.save(submission, "cli")).rejects.toThrow(MediaBudgetError);
    expect(gateway.status(intent.snapshot.saveId)).toMatchObject({ phase: "not_saved", active: false,
      failure: { code: "media_budget", retryable: false } });
    await expect(gateway.replay(intent.snapshot.saveId)).rejects.toThrow(MediaBudgetError);
    expect(store.operationState(intent.snapshot.saveId)).toEqual({ operationId: intent.snapshot.saveId });
    expect(api.creates()).toBe(0);
    expect(api.connects()).toBe(0);
    expect(gateway.intent(intent.snapshot.saveId).snapshot.routing.destinations).toEqual(["901", "902"]);
  } finally { globalThis.fetch = previous; await gateway.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});
