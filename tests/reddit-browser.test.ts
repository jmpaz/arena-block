import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeRedditCapture, bindRedditCaptures, redditCapturesSchema, REDDIT_CAPTURE_MAX_BYTES } from "../packages/core/reddit-record.ts";
import { readRedditPage } from "../packages/core/reddit-browser-reader.ts";
import { RedditProvider } from "../packages/core/providers/reddit.ts";
import { SocialResolver } from "../packages/core/providers/index.ts";
import { parseSource } from "../packages/core/url.ts";
import { blockPlanSchema } from "../packages/core/types.ts";
import { composePlan } from "../packages/core/compose.ts";
import { requiredPlanCapabilities } from "../src/plan-capabilities.ts";
import { ArenaBlockClient } from "../src/client.ts";
import { createService } from "../src/service.ts";
import { readActiveRedditTab, type RedditTabAPI } from "../extension/src/reddit-tab.ts";
import { requiredOrigins, resolveCapture, revisePlan } from "../extension/src/core.ts";
import fixture from "./fixtures/reddit-browser-capture.json";

const capture = () => normalizeRedditCapture(structuredClone(fixture));
const failNetwork = (async () => { throw new Error("A browser record must resolve without network reads"); }) as unknown as typeof fetch;
async function resolved(value = capture()) {
  return new SocialResolver({ reddit: new RedditProvider(failNetwork, [value]) }).resolve([value.sourceUrl]);
}
function page(value: unknown, response?: (url: URL, init: RequestInit) => Response) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const promise = runInNewContext(`(${readRedditPage.toString()})()`, {
    location: new URL((value as any).sourceUrl), URL, AbortController, TextDecoder, Uint8Array, setTimeout, clearTimeout,
    fetch: async (input: URL, init: RequestInit) => {
      calls.push({ url: input, init });
      if (response) return response(input, init);
      const data = input.searchParams.get("id")?.startsWith("t1_") ? (value as any).comment : (value as any).post;
      const listing = { data: { children: [{ kind: data.link_id ? "t1" : "t3", data }] } };
      return Response.json(input.pathname.includes("/api/info") ? listing : [listing]);
    },
  }) as Promise<unknown>;
  return { promise, calls };
}

test("browser reader strips account fields before handoff and retains the complete body and media", async () => {
  const raw = { ...fixture, post: { ...fixture.post, selftext: fixture.post.selftext + "\n\n" + "A full paragraph.\n".repeat(300), saved: true, user_reports: [["private", 1]], mod_reports: [], likes: true } };
  const { promise, calls } = page(raw);
  const value = normalizeRedditCapture(await promise);
  expect(value.schema === "arena-block/reddit-browser-capture" ? value.post.selftext : undefined).toBe(raw.post.selftext);
  expect(JSON.stringify(value)).not.toContain("user_reports");
  expect(JSON.stringify(value)).not.toContain('"saved"');
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url.origin).toBe("https://www.reddit.com");
  expect(calls[0]!.init.credentials).toBe("same-origin");
  expect(calls[0]!.init.redirect).toBe("error");
  const posts = await resolved(value), plan = composePlan(posts, { media: "all" });
  expect(posts[0]!.text).toBe(raw.post.selftext);
  expect(plan.block.selectedMedia).toEqual(["1.1", "1.2"]);
  expect(posts[0]!.media[1]!.sourcePlacement).toBe("body");
  expect(plan.sources[0]!.redditCapture).toEqual(value);
  expect(blockPlanSchema.parse(plan)).toEqual(plan);
  const changed = capture(); changed.observedAt = "2026-10-02T00:00:00Z";
  expect(composePlan(await resolved(changed), { media: "all" }).hash).not.toBe(composePlan(await resolved(), { media: "all" }).hash);
});

test("selected comment handoff reads only that comment and its parent title, including body images", async () => {
  const raw = { ...fixture, sourceUrl: "https://www.reddit.com/r/test/comments/abc1234/a_post/def4567/", comment: {
    id: "def4567", link_id: "t3_abc1234", author: "commenter", body: "Selected reply\n\n![img](fixtureimageb)",
    permalink: "/r/test/comments/abc1234/a_post/def4567/", created_utc: 1700000001,
    media_metadata: fixture.post.media_metadata,
    saved: true, user_reports: [["private", 1]],
  } };
  const { promise, calls } = page(raw);
  const value = normalizeRedditCapture(await promise), posts = await resolved(value), plan = composePlan(posts, { media: "all" });
  expect(calls.map(call => call.url.searchParams.get("id"))).toEqual(["t1_def4567", "t3_abc1234"]);
  expect(posts[0]!.text).toBe(raw.comment.body);
  expect(posts[0]!.storyTitle).toBe(fixture.post.title);
  expect(posts[0]!.canonicalUrl).toBe(`https://www.reddit.com${raw.comment.permalink}`);
  expect(posts[0]!.media.map(asset => asset.id)).toEqual(["fixtureimageb"]);
  expect(plan.block.selectedMedia).toEqual(["1.1"]);
  expect(plan.block.title).toContain("Comment by /u/commenter");
  expect(JSON.stringify(value)).not.toContain("user_reports");
});

test("browser refusal, challenge HTML, oversized content and changed identities stop without fallback", async () => {
  for (const response of [new Response(null, { status: 403 }), new Response(null, { status: 429 }), new Response("<html>challenge</html>", { headers: { "content-type": "text/html" } })]) {
    const { promise, calls } = page(fixture, () => response);
    await expect(promise).rejects.toThrow("No fallback was attempted"); expect(calls).toHaveLength(1);
  }
  const huge = page(fixture, () => Response.json({ text: "a".repeat(REDDIT_CAPTURE_MAX_BYTES) }));
  await expect(huge.promise).rejects.toThrow("exceeds 2 MiB"); expect(huge.calls).toHaveLength(1);
  const mismatch = page({ ...fixture, post: { ...fixture.post, id: "different" } });
  await expect(mismatch.promise).rejects.toThrow("different or unavailable");
});

test("record import rejects substitution, missing body, credentials, private records and invalid bounds", () => {
  const mutations = [
    { post: { ...fixture.post, selftext: undefined } }, { post: { ...fixture.post, id: "wrong" } },
    { sourceUrl: "https://www.reddit.com/comments/other/" }, { sourceUrl: "https://user:pass@reddit.com/comments/abc1234/" },
    { sourceUrl: "https://example.com/comments/abc1234/" }, { cookie: "must not persist" },
    { post: { ...fixture.post, subreddit_type: "private" } }, { post: { ...fixture.post, quarantine: true } },
    { observedAt: "2099-01-01T00:00:00Z" }, { post: { ...fixture.post, selftext: "a".repeat(REDDIT_CAPTURE_MAX_BYTES) } },
  ];
  for (const change of mutations) expect(() => normalizeRedditCapture({ ...fixture, ...change })).toThrow();
  expect(() => bindRedditCaptures(["https://www.reddit.com/comments/other/"], [capture()])).toThrow("does not match");
  expect(() => redditCapturesSchema.parse([capture(), capture()])).toThrow("Duplicate");
});

test("extension imports resolve without provider origins and retain edited writing and provenance", async () => {
  const value = capture();
  expect(requiredOrigins([value.sourceUrl], [value])).toEqual([]);
  const plan = await resolveCapture({ primary: [value.sourceUrl], extras: [], policy: { media: "all" }, redditCaptures: [value] }, undefined, failNetwork);
  const edited = revisePlan(plan, { title: "Authored title", markdown: "Authored writing", description: "Authored description" });
  expect(edited.block.title).toBe("Authored title"); expect(edited.block.markdown).toBe("Authored writing");
  expect(blockPlanSchema.parse(edited).sources[0]!.redditCapture).toEqual(value);
  expect(requiredPlanCapabilities(edited)).toEqual(["reddit-browser-records-v1"]);
  const invalid = structuredClone(edited); invalid.sources[0]!.id = "other";
  expect(() => blockPlanSchema.parse(invalid)).toThrow("Mismatched Reddit");
});

test("tab reader requests optional scripting only on invocation and stops on denial", async () => {
  const calls: string[] = [];
  let allowed = false;
  const api: RedditTabAPI = {
    permissions: { async request(input) { calls.push(JSON.stringify(input)); return allowed; } },
    tabs: { async query() { calls.push("tab"); return [{ id: 17, url: fixture.sourceUrl }]; } },
    scripting: { async executeScript(input) { calls.push("read"); expect(input.world).toBe("MAIN"); expect(input.target).toEqual({ tabId: 17 }); return [{ result: fixture }]; } },
  };
  await expect(readActiveRedditTab(api)).rejects.toThrow("not granted");
  expect(calls).toEqual(['{"permissions":["scripting"]}']);
  calls.length = 0; allowed = true;
  expect(await readActiveRedditTab(api)).toEqual(capture());
  expect(calls).toEqual(['{"permissions":["scripting"]}', "tab", "read"]);
});

test("receiver imports records read-only and legacy receiver receives no publication submission", async () => {
  const plan = composePlan(await resolved(), { media: "all" });
  const calls: string[] = [];
  const client = new ArenaBlockClient("https://receiver.invalid", "fixture", (async input => {
    calls.push(new URL(String(input)).pathname);
    return Response.json({ version: "0.1.0", revision: null, sourceId: "older", platform: "fixture", schemaVersion: 1, packagePath: null, planCapabilities: [] });
  }) as typeof fetch);
  await expect(client.publish(plan, ["never-published"])).rejects.toThrow("No save was submitted");
  expect(calls).toEqual(["/v1/version"]);
  const directory = await mkdtemp(join(tmpdir(), "arena-reddit-record-receiver-"));
  const service = createService({ host: "localhost", port: 8790, publicBaseUrl: "https://receiver.invalid", stateDirectory: directory, mediaDirectory: directory, accessToken: "fixture", arenaToken: "never-used" });
  try {
    for (const path of ["/v1/resolve", "/v1/plans"]) {
      const response = await service.handler(new Request(`http://localhost${path}`, { method: "POST", headers: { authorization: "Bearer fixture", "content-type": "application/json" }, body: JSON.stringify({ refs: [fixture.sourceUrl], redditCaptures: [fixture], policy: { media: "all" } }) }));
      expect(response.status).toBe(200);
      const result = await response.json();
      expect((result.sources ?? result.posts)[0].redditCapture).toEqual(capture());
    }
  } finally { service.close(); await rm(directory, { recursive: true, force: true }); }
});

test("CLI consumes a file-only browser handoff, preserves media-all and rejects mismatched sources", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arena-reddit-record-cli-"));
  try {
    const path = join(directory, "capture.json"); await writeFile(path, JSON.stringify(fixture));
    const run = (args: string[]) => Bun.spawn([process.execPath, "run", "src/cli.ts", ...args], { cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" });
    const child = run(["plan", "--reddit-capture", path, "--media", "all", "--json"]);
    const output = await new Response(child.stdout).text(), error = await new Response(child.stderr).text();
    expect(await child.exited, error).toBe(0);
    const plan = JSON.parse(output);
    expect(plan.block.selectedMedia).toEqual(["1.1", "1.2"]);
    expect(plan.sources[0].redditCapture).toEqual(capture());
    const mismatch = run(["plan", "https://www.reddit.com/comments/other/", "--reddit-capture", path]);
    const failure = await new Response(mismatch.stderr).text();
    expect(await mismatch.exited).not.toBe(0); expect(failure).toContain("does not match");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("the page reader refuses private records before returning any payload", async () => {
  const { promise, calls } = page({ ...fixture, post: { ...fixture.post, subreddit_type: "private" } });
  await expect(promise).rejects.toThrow("Only public"); expect(calls).toHaveLength(1);
});

test("local-helper acquisition checks capabilities and refuses a stripped browser record", async () => {
  const { resolveWithNative } = await import("../extension/src/native-reddit.ts");
  const value = capture(), plan = composePlan(await resolved(value), { media: "all" });
  const input = { refs: [value.sourceUrl], extraRefs: [], refresh: false, redditCaptures: [value] };
  let capabilities: string[] = [];
  const calls: string[] = [];
  let returned = plan;
  const native = async (action: string) => { calls.push(action); return action === "ping" ? { planCapabilities: capabilities } : returned; };
  await expect(resolveWithNative(input, native)).rejects.toThrow("matching local helper");
  expect(calls).toEqual(["ping"]);
  calls.length = 0; capabilities = ["reddit-browser-records-v1"];
  returned = structuredClone(plan); delete returned.sources[0]!.redditCapture;
  await expect(resolveWithNative(input, native)).rejects.toThrow("did not retain");
  returned = plan;
  expect(await resolveWithNative(input, native)).toEqual(plan);
});

test("import rejects unsupported player containers before stripping, including cross-post parents", () => {
  for (const field of ["media", "secure_media"]) for (const nested of [false, true]) {
    const post = { ...fixture.post, [field]: { oembed: { provider_name: "Embedded player" } } };
    const raw = { ...fixture, post: nested ? { ...fixture.post, crosspost_parent_list: [post] } : post };
    expect(() => normalizeRedditCapture(raw)).toThrow();
  }
});

test("complete-media validation follows only the included quote ancestry", async () => {
  const parent = { ...fixture.post, id: "parent1", permalink: "/comments/parent1/", post_hint: undefined, url: undefined,
    selftext: "![gif](anim123)", media_metadata: { anim123: { status: "valid", e: "AnimatedImage", s: { gif: "https://i.redd.it/anim123.gif" } } } };
  const posts = await resolved(normalizeRedditCapture({ ...fixture, post: { ...fixture.post, crosspost_parent_list: [parent] } }));
  expect(posts[0]!.quote!.mediaIssues?.[0]?.status).toBe("unsupported");
  for (const media of ["all", "images"] as const) {
    expect(() => composePlan(posts, { media })).toThrow("anim123");
    expect(() => composePlan(posts, { media, quote: "omit" })).not.toThrow();
    const deeper = structuredClone(posts); deeper[0]!.quote = { ...deeper[0]!.quote!, mediaIssues: undefined, quote: posts[0]!.quote };
    expect(() => composePlan(deeper, { media, quoteDepth: 1 })).not.toThrow();
    expect(() => composePlan(deeper, { media, quoteDepth: 2 })).toThrow("anim123");
  }
});

test("imported media stays on matching Reddit asset origins and bounded metadata", async () => {
  for (const href of ["https://127.0.0.1:8443/private/image.png", "https://preview.redd.it:8443/fixtureimageb.png",
    "https://user:pass@i.redd.it/fixtureimageb.png", "https://i.redd.it/other.png", "https://example.com/fixtureimageb.png"]) {
    const media_metadata = { fixtureimageb: { status: "valid", e: "Image", s: { u: href } } };
    expect(() => normalizeRedditCapture({ ...fixture, post: { ...fixture.post, gallery_data: { items: [{ media_id: "fixtureimageb" }] }, media_metadata } })).toThrow();
  }
  for (const href of ["https://127.0.0.1:8443/private/video.m3u8", "https://v.redd.it:8443/id/HLSPlaylist.m3u8", "https://example.com/id/HLSPlaylist.m3u8"]) {
    expect(() => normalizeRedditCapture({ ...fixture, post: { ...fixture.post, media: { reddit_video: { hls_url: href, width: 640, height: 480 } } } })).toThrow();
  }
  expect(() => normalizeRedditCapture({ ...fixture, post: { ...fixture.post, post_hint: "image", url: "https://127.0.0.1/image.png" } })).toThrow();
  const video = normalizeRedditCapture({ ...fixture, post: { ...fixture.post, media: { reddit_video: {
    hls_url: "https://v.redd.it/clip1/HLSPlaylist.m3u8?a=1", fallback_url: "https://v.redd.it/clip1/DASH_720.mp4", width: 640, height: 480,
  } } } });
  expect(composePlan(await resolved(video), { media: "all" }).sources[0]!.media[0]!.url).toContain("v.redd.it/clip1/");
  const raw = { ...fixture, sourceUrl: "https://www.reddit.com/comments/abc1234/comment/def4567/", comment: {
    id: "def4567", link_id: "t3_abc1234", author: "commenter", body: "A reply", created_utc: 1700000001,
    permalink: "/comments/abc1234/comment/def4567/", media_metadata: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`img${i}`, { status: "valid", e: "Image" }])),
  } };
  expect(() => normalizeRedditCapture(raw)).toThrow("Too many Reddit media records");
  const external = normalizeRedditCapture({ ...fixture, post: { ...fixture.post, url: "https://example.com/story", post_hint: "link", selftext: "", media_metadata: undefined } });
  expect((await resolved(external))[0]!.text).toBe("https://example.com/story");
});

test("reopening an imported draft preserves its snapshot, policy and destinations across URL aliases or tabs", async () => {
  const { containsDraftSource, shouldReplaceAutomaticDraft } = await import("../extension/src/draft-retention.ts");
  const saved = { primary: fixture.sourceUrl, redditCaptures: [capture()], media: "all", selectedChannels: ["retained"] };
  expect(containsDraftSource(saved.primary, "https://www.reddit.com/r/test/comments/abc1234/a_post/")).toBe(true);
  expect(shouldReplaceAutomaticDraft(saved, "https://www.reddit.com/r/test/comments/abc1234/a_post/", false)).toBe(false);
  expect(shouldReplaceAutomaticDraft(saved, "https://www.reddit.com/comments/another/", false)).toBe(false);
  expect(shouldReplaceAutomaticDraft({ ...saved, redditCaptures: [] }, "https://www.reddit.com/comments/another/", false)).toBe(true);
  expect(shouldReplaceAutomaticDraft({ primary: fixture.sourceUrl }, "https://www.reddit.com/r/test/comments/abc1234/a_post/", false)).toBe(false);
});


test("import preserves supported animated gallery videos on matching Reddit image origins", async () => {
  for (const mp4 of ["https://i.redd.it/anim123.mp4", "https://preview.redd.it/anim123.gif?format=mp4&s=fixture"]) {
    const value = normalizeRedditCapture({ ...fixture, post: { ...fixture.post, selftext: "Gallery animation", post_hint: undefined, url: undefined,
      gallery_data: { items: [{ media_id: "anim123" }] }, media_metadata: {
        anim123: { status: "valid", e: "AnimatedImage", s: { gif: "https://i.redd.it/anim123.gif", mp4, x: 640, y: 480 } },
      },
    } });
    const plan = composePlan(await resolved(value), { media: "all" });
    expect(plan.block.selectedMedia).toEqual(["1.1"]);
    expect(plan.sources[0]!.media[0]).toMatchObject({ id: "anim123", kind: "video", url: mp4 });
  }
});
