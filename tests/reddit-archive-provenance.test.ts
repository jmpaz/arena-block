import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createContext, runInContext } from "node:vm";
import { RedditProvider } from "../packages/core/providers/reddit.ts";
import { parseSource } from "../packages/core/url.ts";
import { redditCapturesSchema } from "../packages/core/reddit-record.ts";
import { requiredOrigins } from "../extension/src/core.ts";
import { captureAccessScope, permissionManifest } from "../extension/permission-policy.ts";
import captureFixture from "./fixtures/reddit-browser-capture.json";

const post = { id: "abc", title: "Current fixture title", author: "fixture", permalink: "/r/test/comments/abc/title/", selftext: "Current fixture text", created_utc: 1700000000 };
const comment = { id: "def", author: "commenter", body: "Current reply", permalink: "/r/test/comments/abc/title/def/", link_id: "t3_abc", created_utc: 1700000100 };
const postURL = "https://www.reddit.com/comments/abc.json?raw_json=1";
const commentURL = "https://www.reddit.com/api/info.json?id=t1_def&raw_json=1";
const parentURL = "https://www.reddit.com/api/info.json?id=t3_abc&raw_json=1";

test("503 never substitutes archived writing or an archived parent title for a live source", async () => {
  for (const failed of ["post", "comment", "parent"] as const) {
    const calls: string[] = [];
    const provider = new RedditProvider(async input => {
      const url = String(input); calls.push(url);
      if (url.includes("arctic-shift")) return Response.json({ data: [{ ...post, selftext: "Outdated archived text", title: "Outdated parent title", retrieved_on: 1700000200 }] });
      if ((failed === "post" && url === postURL) || (failed === "comment" && url === commentURL) || (failed === "parent" && url === parentURL))
        return new Response(null, { status: 503 });
      return Response.json({ data: { children: [{ data: comment }] } });
    });
    await expect(provider.resolve(parseSource(failed === "post" ? "https://redd.it/abc" : "https://www.reddit.com/r/test/comments/abc/title/def/")))
      .rejects.toThrow("HTTP 503");
    expect(calls).toEqual(failed === "post" ? [postURL] : failed === "comment" ? [commentURL] : [commentURL, parentURL]);
  }
});

test("a successful live comment keeps its live parent title and retained records still bypass acquisition", async () => {
  const calls: string[] = [];
  const provider = new RedditProvider(async input => {
    const url = String(input); calls.push(url);
    return Response.json({ data: { children: [{ data: url === commentURL ? comment : post }] } });
  });
  const resolved = await provider.resolve(parseSource("https://www.reddit.com/r/test/comments/abc/title/def/"));
  expect(resolved.text).toBe(comment.body); expect(resolved.storyTitle).toBe(post.title);
  expect(calls).toEqual([commentURL, parentURL]);
  const capture = redditCapturesSchema.parse([captureFixture])[0]!;
  if (capture.schema !== "arena-block/reddit-browser-capture") throw new Error("Expected the retained JSON record fixture");
  const retained = new RedditProvider(async () => { throw new Error("Retained records must not fetch"); }, [capture]);
  const result = await retained.resolve(parseSource(capture.sourceUrl));
  expect(result.redditCapture).toEqual(capture);
  expect(result.text).toBe(capture.post.selftext);
});

test("browser preflight and batch consent no longer request unused archive access", () => {
  expect(requiredOrigins(["https://redd.it/abc"])).toEqual(["https://www.reddit.com/*"]);
  const manifest = permissionManifest("named-sources", true, []);
  expect(manifest.optional_host_permissions).toHaveLength(12);
  expect(manifest.optional_host_permissions).not.toContain("https://arctic-shift.photon-reddit.com/*");
  expect(captureAccessScope(manifest).request.origins).not.toContain("https://arctic-shift.photon-reddit.com/*");
});

test("the regenerated native bundle rejects post and parent-metadata 503 without an archive or browser bridge", async () => {
  const bundle = await Bun.file(new URL("../ios/Sources/CaptureRuntime/Resources/capture-core.js", import.meta.url)).text();
  for (const parentFailure of [false, true]) {
    const calls: string[] = []; let browserCalls = 0;
    let finish!: (value: { result: string | null; error: string | null }) => void;
    const done = new Promise<{ result: string | null; error: string | null }>(resolve => { finish = resolve; });
    const context = createContext({
      nativeSHA256: (value: string) => createHash("sha256").update(value).digest("hex"),
      setTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay).unref(), clearTimeout,
      nativeCancelHTTP: () => {}, nativeAcquireRedditPublicPage: () => { browserCalls++; },
      nativeHTTP: (id: number, raw: string) => {
        const request = JSON.parse(raw); calls.push(request.url);
        const isLiveComment = parentFailure && request.url === commentURL;
        const response = { status: isLiveComment ? 200 : 503, headers: { "content-type": "application/json" },
          body: isLiveComment ? JSON.stringify({ data: { children: [{ data: comment }] } }) : "Unavailable", url: request.url };
        queueMicrotask(() => context.captureHTTPComplete(id, JSON.stringify(response)));
      },
      nativeResolveComplete: (_id: string, result: string | null, error: string | null) => finish({ result, error }),
    });
    runInContext(bundle, context);
    context.captureResolve("reddit-503", JSON.stringify([parentFailure ? "https://www.reddit.com/r/test/comments/abc/title/def/" : "https://redd.it/abc"]), "{}");
    const result = await done;
    expect(result.result).toBeNull(); expect(result.error).toContain("HTTP 503");
    expect(calls).toEqual(parentFailure ? [commentURL, parentURL] : [postURL]);
    expect(browserCalls).toBe(0);
  }
});
