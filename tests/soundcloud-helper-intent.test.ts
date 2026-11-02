import { buildInfo } from "../src/version.ts";
import { expect, test } from "bun:test";
import { composePlan, planHash } from "../packages/core/compose.ts";
import { planInputSchema } from "../packages/core/types.ts";
import { parseSource } from "../packages/core/url.ts";
import { requireSoundCloudAudioResult } from "../packages/core/soundcloud-input.ts";
import { SoundCloudProvider } from "../src/providers/soundcloud.ts";
import { ArenaBlockClient } from "../src/client.ts";
import { resolveCaptureWithHelper } from "../extension/src/native-reddit.ts";
import { CaptureJobRunner, type CaptureJob, type CaptureJobServices } from "../extension/src/capture-job.ts";
import { handle } from "../extension/native-host.ts";

const url = "https://soundcloud.com/rrthielnc/fxxlsgxld";
async function plans(media: "all" | "audio") {
  const post = await new SoundCloudProvider(async () => ({ stdout: JSON.stringify({ id: "2422119177", title: "FXXL'S GXLD [5-N163]",
    webpage_url: url, duration: 240.786, formats: [{ format_id: "hls_aac_160k", ext: "m4a", protocol: "m3u8_native",
      vcodec: "none", url: "https://cf-hls-media.sndcdn.com/synthetic/playlist.m3u8" }] }), stderr: "" })).resolve(parseSource(url));
  const audio = composePlan([post], { media });
  const noAudio = { ...post, media: [] };
  const { hash: _, ...legacyContent } = composePlan([noAudio], { media: "none" });
  legacyContent.policy.media = media;
  const old = { ...legacyContent, hash: planHash(legacyContent) };
  return { audio, old, link: composePlan([noAudio], { media: "none" }) };
}

test("fresh helper replies must retain explicit audio; deliberate None and immutable URL plans stay separate", async () => {
  for (const media of ["all", "audio"] as const) {
    const { audio, old, link } = await plans(media), input = { refs: [url], policy: { media } };
    expect(() => requireSoundCloudAudioResult(input, old)).toThrow("requested SoundCloud audio");
    expect(() => requireSoundCloudAudioResult(input, audio)).not.toThrow();
    expect(() => requireSoundCloudAudioResult({ refs: [url], policy: { media: "none" } }, link)).not.toThrow();
    expect(composePlan(link.sources, link.policy)).toEqual(link);
  }
});

test("the actual browser fallback/job path refuses an older helper link before any create/save", async () => {
  for (const media of ["all", "audio"] as const) {
    const { old } = await plans(media), actions: string[] = [];
    const input = { primary: [url], extras: [], policy: { media } };
    const queued: CaptureJob = { saveId: crypto.randomUUID(), input, destinations: ["901"], phase: "queued" };
    let stored = queued, creates = 0;
    const failLocal = async () => { throw new Error("Use CLI with yt-dlp"); };
    const services: CaptureJobServices = {
      resolve: value => resolveCaptureWithHelper(value, async () => true, async action => { actions.push(action); return action === "ping" ? buildInfo() : old; }, failLocal),
      browserAvailable: async () => true, nativeAvailable: async () => true,
      browserPrepare: async () => { throw new Error("No browser preparation expected"); },
      browserCreate: async () => { creates++; throw new Error("No browser create expected"); },
      browserCheck: async () => { throw new Error("No browser status expected"); },
      nativeSave: async () => { creates++; return { phase: "saved" }; }, nativeRetry: async () => ({ phase: "unknown" }), nativeStatus: async () => ({ phase: "unknown" }),
    };
    const runner = new CaptureJobRunner({ get: async () => stored, put: async value => { stored = value; } }, services);
    const result = await runner.run(queued.saveId);
    expect(result.phase).toBe("failed"); expect(result.error).toContain("requested SoundCloud audio");
    expect(result.plan).toBeUndefined(); expect(creates).toBe(0); expect(actions).toEqual(["ping", "resolve"]);
  }
});

test("matching delegated audio follows the existing helper save route with the same retained UUID", async () => {
  const { audio } = await plans("all"), input = { primary: [url], extras: [], policy: { media: "all" as const } };
  let stored: CaptureJob = { saveId: crypto.randomUUID(), input, destinations: ["901"], phase: "queued" };
  const saveId = stored.saveId; let saves = 0;
  const services: CaptureJobServices = {
    resolve: value => resolveCaptureWithHelper(value, async () => true, async action => action === "ping" ? buildInfo() : audio,
      async () => { throw new Error("local-only resolver has no yt-dlp"); }),
    browserAvailable: async () => true, nativeAvailable: async () => true,
    browserPrepare: async () => { throw new Error("Audio cannot use browser-only publication"); },
    browserCreate: async () => { throw new Error("No browser create expected"); }, browserCheck: async () => { throw new Error("No browser status expected"); },
    nativeSave: async (id, plan) => { expect(id).toBe(saveId); expect(plan).toEqual(audio); saves++; return { phase: "saved" }; },
    nativeRetry: async () => ({ phase: "unknown" }), nativeStatus: async () => ({ phase: "unknown" }),
  };
  const runner = new CaptureJobRunner({ get: async () => stored, put: async value => { stored = value; } }, services);
  expect((await runner.run(saveId)).phase).toBe("saved"); expect(stored.method).toBe("native"); expect(saves).toBe(1);
  expect((await runner.run(saveId)).phase).toBe("saved"); expect(saves).toBe(1);
});

test("unavailable helper access preserves the local refusal without a native request", async () => {
  let calls = 0;
  await expect(resolveCaptureWithHelper({ primary: [url], extras: [], policy: { media: "all" } }, async () => false,
    async () => { calls++; }, async () => { throw new Error("local audio unavailable"); })).rejects.toThrow("local audio unavailable");
  expect(calls).toBe(0);
});

test("native host and remote CLI plan clients refuse old-daemon URL replies independently", async () => {
  const previous = process.env.ARENA_BLOCK_ACCESS_TOKEN, previousEndpoint = process.env.ARENA_BLOCK_ENDPOINT;
  process.env.ARENA_BLOCK_ACCESS_TOKEN = "fixture-only"; process.env.ARENA_BLOCK_ENDPOINT = "https://daemon.invalid";
  try {
    for (const media of ["all", "audio"] as const) {
      const { old } = await plans(media), requests: string[] = [];
      const fetcher = (async (input: RequestInfo | URL) => { requests.push(new URL(String(input)).pathname); return Response.json(new URL(String(input)).pathname === "/v1/version" ? buildInfo() : old); }) as typeof fetch;
      await expect(handle({ id: "source", action: "resolve", input: planInputSchema.parse({ refs: [url], policy: { media } }) }, fetcher)).rejects.toThrow("requested SoundCloud audio");
      await expect(new ArenaBlockClient("https://daemon.invalid", "fixture-only", fetcher).plan([url], { media })).rejects.toThrow("requested SoundCloud audio");
      expect(requests).toEqual(["/v1/version", "/v1/plans", "/v1/version", "/v1/plans"]);
    }
  } finally {
    if (previous === undefined) delete process.env.ARENA_BLOCK_ACCESS_TOKEN; else process.env.ARENA_BLOCK_ACCESS_TOKEN = previous;
    if (previousEndpoint === undefined) delete process.env.ARENA_BLOCK_ENDPOINT; else process.env.ARENA_BLOCK_ENDPOINT = previousEndpoint;
  }
});

test("native host accepts a matching full-audio response and an explicit source-link response", async () => {
  const previous = process.env.ARENA_BLOCK_ACCESS_TOKEN, previousEndpoint = process.env.ARENA_BLOCK_ENDPOINT;
  process.env.ARENA_BLOCK_ACCESS_TOKEN = "fixture-only"; process.env.ARENA_BLOCK_ENDPOINT = "https://daemon.invalid";
  try {
    const { audio, link } = await plans("all");
    for (const [media, plan] of [["all", audio], ["none", link]] as const) {
      const requests: string[] = [];
      const fetcher = (async (input: RequestInfo | URL) => { requests.push(new URL(String(input)).pathname); return Response.json(new URL(String(input)).pathname === "/v1/version" ? buildInfo() : plan); }) as typeof fetch;
      expect(await handle({ id: "source", action: "resolve", input: planInputSchema.parse({ refs: [url], policy: { media } }) }, fetcher)).toEqual(plan);
      expect(requests).toEqual(["/v1/version", "/v1/plans"]);
    }
  } finally {
    if (previous === undefined) delete process.env.ARENA_BLOCK_ACCESS_TOKEN; else process.env.ARENA_BLOCK_ACCESS_TOKEN = previous;
    if (previousEndpoint === undefined) delete process.env.ARENA_BLOCK_ENDPOINT; else process.env.ARENA_BLOCK_ENDPOINT = previousEndpoint;
  }
});
