import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createContext, runInContext } from "node:vm";
import { RedditProvider } from "../packages/core/providers/reddit.ts";
import { redditLiveReadUnavailable } from "../packages/core/reddit-record.ts";
import { parseSource } from "../packages/core/url.ts";

const short = "https://www.reddit.com/r/neovim/s/jNsGjBVn9A";
const canonical = "https://www.reddit.com/r/neovim/comments/1x6nuin/whatsappnvim_handwritten_code_with_zero_ai/";
// Synthetic content tests the source contract; it is not an acquired live post.
const post = { id: "1x6nuin", title: "Fixture", author: "fixture-author", selftext: "Full fixture body", created_utc: 1700000000,
  permalink: new URL(canonical).pathname };

for (const status of [401, 403, 429]) {
  test(`ordinary share stops at HTTP ${status} without a browser, archive or manual-capture suggestion`, async () => {
    const calls: string[] = [];
    const provider = new RedditProvider(async (url, init) => {
      calls.push(String(url));
      expect(init?.credentials).toBe("omit");
      expect(new Headers(init?.headers).get("user-agent")).toBe("arena-block/0.1");
      if (init?.method === "HEAD") return new Response(null, { status: 301, headers: { location: canonical } });
      return new Response(null, { status });
    });
    const error = await provider.resolve(parseSource(short)).catch(error => error as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(`HTTP ${status}`);
    expect((error as Error).message).not.toMatch(/browser|Safari|Read Reddit|import/i);
    expect(calls).toEqual([short, "https://www.reddit.com/comments/1x6nuin.json?raw_json=1"]);
  });
  test(`share-link HTTP ${status} refusal cannot offer a local-helper fallback`, async () => {
    const calls: string[] = [];
    const provider = new RedditProvider(async url => { calls.push(String(url)); return new Response(null, { status }); });
    const error = await provider.resolve(parseSource(short)).catch(error => error as Error);
    expect(error).toBeInstanceOf(Error); expect((error as Error).message).toContain(`share-link read returned HTTP ${status}`);
    expect(redditLiveReadUnavailable(error)).toBe(true);
    expect(calls).toEqual([short]);
  });
  test(`selected comment stops at HTTP ${status} without a parent or fallback read`, async () => {
    const calls: string[] = [];
    const provider = new RedditProvider(async url => { calls.push(String(url)); return new Response(null, { status }); });
    await expect(provider.resolve(parseSource(`${canonical}abc/`))).rejects.toThrow(`HTTP ${status}`);
    expect(calls).toEqual(["https://www.reddit.com/api/info.json?id=t1_abc&raw_json=1"]);
  });
}

test("cross-post identity must have its matching full parent record", async () => {
  const resolve = (value: unknown) => new RedditProvider(async () => Response.json([{ data: { children: [{ data: value }] } }])).resolve(parseSource(canonical));
  for (const value of [
    { ...post, crosspost_parent: "t3_parent" },
    { ...post, crosspost_parent: "t3_other", crosspost_parent_list: [{ ...post, id: "parent", permalink: "/comments/parent/", author: "original" }] },
  ]) await expect(resolve(value)).rejects.toThrow("parent identity");
  const result = await resolve({ ...post, crosspost_parent: "t3_parent", crosspost_parent_list: [{ ...post, id: "parent", permalink: "/comments/parent/", author: "original" }] });
  expect(result.id).toBe("1x6nuin"); expect(result.author.handle).toBe("u/fixture-author");
  expect(result.quote).toMatchObject({ id: "parent", canonicalUrl: "https://www.reddit.com/comments/parent/", author: { handle: "u/original" }, text: post.selftext });
});

test("declared gallery/video and unknown audio state cannot silently become a complete text or silent-video capture", async () => {
  const resolve = (value: unknown) => new RedditProvider(async () => Response.json([{ data: { children: [{ data: value }] } }])).resolve(parseSource(canonical));
  await expect(resolve({ ...post, is_gallery: true })).rejects.toThrow("ordered media");
  await expect(resolve({ ...post, is_video: true })).rejects.toThrow("stream metadata");
  await expect(resolve({ ...post, is_video: true, crosspost_parent: "t3_parent", crosspost_parent_list: [{ ...post, id: "parent", permalink: "/comments/parent/" }] })).rejects.toThrow("stream metadata");
  const reddit_video = { fallback_url: "https://v.redd.it/fixture/DASH_720.mp4", width: 720, height: 1280 };
  await expect(resolve({ ...post, media: { reddit_video } })).rejects.toThrow("preserving its audio");
  const silent = await resolve({ ...post, media: { reddit_video: { ...reddit_video, has_audio: false } } });
  expect(silent.media[0]?.url).toBe(reddit_video.fallback_url);
});

test("the actual bundled native resolver never invokes an available browser bridge on a denied ordinary share", async () => {
  const bundle = await Bun.file(new URL("../ios/Sources/CaptureRuntime/Resources/capture-core.js", import.meta.url)).text();
  const calls: string[] = [];
  let browserCalls = 0, finish!: (value: { result: string | null; error: string | null }) => void;
  const done = new Promise<{ result: string | null; error: string | null }>(resolve => { finish = resolve; });
  const context = createContext({
    nativeSHA256: (value: string) => createHash("sha256").update(value).digest("hex"),
    setTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay).unref(), clearTimeout,
    nativeCancelHTTP: () => {}, nativeAcquireRedditPublicPage: () => { browserCalls++; },
    nativeHTTP: (id: number, raw: string) => {
      const request = JSON.parse(raw); calls.push(request.url);
      const response = request.method === "HEAD"
        ? { status: 301, headers: { location: canonical }, body: "", url: request.url }
        : { status: 403, headers: { "content-type": "text/html" }, body: "Denied", url: request.url };
      queueMicrotask(() => context.captureHTTPComplete(id, JSON.stringify(response)));
    },
    nativeResolveComplete: (_id: string, result: string | null, error: string | null) => finish({ result, error }),
  });
  runInContext(bundle, context);
  context.captureResolve("direct-reddit", JSON.stringify([short]), "{}");
  const result = await done;
  expect(result.result).toBeNull(); expect(result.error).toContain("HTTP 403");
  expect(result.error).not.toMatch(/browser|Safari|import/i);
  expect(browserCalls).toBe(0);
  expect(calls).toEqual([short, "https://www.reddit.com/comments/1x6nuin.json?raw_json=1"]);
  expect(context.captureRedditPublicPageComplete).toBeUndefined();
});
