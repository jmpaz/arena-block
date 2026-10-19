import { describe, expect, test } from "bun:test";
import { captureSource } from "../packages/core/capture.ts";
import { composePlan } from "../packages/core/compose.ts";
import { SocialResolver } from "../src/providers/index.ts";
import { resolveSoundCloudShareURL, resolveSourceRefs } from "../packages/core/source-redirects.ts";
import { explicitSelections } from "../packages/core/source-selection.ts";
import { parseSource, soundCloudShareURL } from "../packages/core/url.ts";
import { requiredOrigins, resolveCapture } from "../extension/src/core.ts";
import { permissionManifest } from "../extension/permission-policy.ts";

const share = "https://on.soundcloud.com/L0Z8FDzZWKyJQqIyHN";
const track = "https://soundcloud.com/rrthielnc/fxxlsgxld";
const redirect = (location: string, status = 302) => new Response(null, { status, headers: { location } });
const metadata = { kind: "track", id: 2422119177, title: "Fixture track", permalink_url: track,
  sharing: "public", downloadable: false, has_downloads_left: false, user: { username: "Fixture artist" } };
const html = `<script>window.__sc_hydration = ${JSON.stringify([{ hydratable: "sound", data: metadata }])};</script>`;

describe("bounded SoundCloud share routing", () => {
  test("classifies the exact share input for native capture without synchronous network access", () => {
    expect(captureSource(share)).toEqual({ kind: "social", url: share });
    expect(soundCloudShareURL(share + "/?si=tracking#ignored")).toBe(share);
    expect(() => parseSource(share)).toThrow("Unsupported social post URL");
    expect(captureSource("https://example.com/article").kind).toBe("url");
  });

  test.each([301, 302, 303, 307, 308])("validates a manual HEAD %s and strips canonical tracking", async status => {
    const calls: string[] = [];
    const result = await resolveSoundCloudShareURL(share, async (url, init) => {
      calls.push(url); expect(init).toMatchObject({ method: "HEAD", redirect: "manual", credentials: "omit" });
      expect(init?.signal?.aborted).toBe(false);
      return redirect(track + "?utm_source=clipboard&si=source", status);
    });
    expect(result).toBe(track); expect(calls).toEqual([share]);
  });

  test("follows only allowed short-link hops and preserves playlist identity", async () => {
    const calls: string[] = [], playlist = "https://soundcloud.com/artist/sets/playlist";
    expect(await resolveSoundCloudShareURL(share, async url => {
      calls.push(url); return redirect(calls.length === 1 ? "/next" : playlist);
    })).toBe(playlist);
    expect(calls).toEqual([share, "https://on.soundcloud.com/next"]);
  });

  test.each(["http://soundcloud.com/artist/track", "https://evil.test/artist/track", "https://soundcloud.com.evil.test/artist/track",
    "https://user@soundcloud.com/artist/track", "https://soundcloud.com:444/artist/track", "https://soundcloud.com/artist/track?secret_token=s-private",
    "https://soundcloud.com/artist/track/s-private", "https://soundcloud.com/artist/likes", "https://soundcloud.com/artist", "https://on.soundcloud.com:444/next"])
  ("refuses redirect destination %s before requesting it", async target => {
    const calls: string[] = [];
    await expect(resolveSoundCloudShareURL(share, async url => { calls.push(url); return redirect(target); })).rejects.toThrow();
    expect(calls).toEqual([share]);
  });

  test.each(["http://on.soundcloud.com/token", "https://user@on.soundcloud.com/token", "https://on.soundcloud.com:444/token",
    "https://on.soundcloud.com/two/segments", "https://on.soundcloud.com/token?secret_token=private"])
  ("rejects malformed share input %s without a request", async input => {
    let calls = 0;
    await expect(resolveSoundCloudShareURL(input, async () => { calls++; return redirect(track); })).rejects.toThrow();
    expect(calls).toBe(0); expect(() => captureSource(input)).toThrow();
  });

  test("bounds loops, request count, missing/long Locations and non-redirect responses", async () => {
    await expect(resolveSoundCloudShareURL(share, async () => redirect(share))).rejects.toThrow("loop");
    let calls = 0;
    await expect(resolveSoundCloudShareURL(share, async () => redirect(`https://on.soundcloud.com/step${++calls}`))).rejects.toThrow("three");
    expect(calls).toBe(3);
    for (const response of [new Response(null, { status: 200 }), new Response(null, { status: 302 }), redirect("x".repeat(8193))]) {
      await expect(resolveSoundCloudShareURL(share, async () => response)).rejects.toThrow();
    }
    const followed = redirect(track); Object.defineProperty(followed, "url", { value: track });
    await expect(resolveSoundCloudShareURL(share, async () => followed)).rejects.toThrow("unchecked redirect");
  });

  test("settles timeout and cancellation even when a test fetcher ignores abort", async () => {
    let requestSignal: AbortSignal | undefined;
    await expect(resolveSoundCloudShareURL(share, async (_url, init) => {
      requestSignal = init?.signal ?? undefined; return new Promise<Response>(() => {});
    }, { timeoutMs: 10 })).rejects.toThrow("timed out");
    expect(requestSignal?.aborted).toBe(true);
    const controller = new AbortController();
    const pending = resolveSoundCloudShareURL(share, async () => new Promise<Response>(() => {}), { signal: controller.signal });
    controller.abort(); await expect(pending).rejects.toThrow("cancelled");
    let calls = 0;
    await expect(resolveSoundCloudShareURL(share, async () => { calls++; return redirect(track); }, { signal: AbortSignal.abort() })).rejects.toThrow("cancelled");
    expect(calls).toBe(0);
  });

  test("normalizes before primary/extra deduplication and keeps actor-scoped SoundCloud IDs", async () => {
    let reads = 0;
    const refs = await resolveSourceRefs([share, track, share + "?si=other"], async () => { reads++; return redirect(track); });
    expect(reads).toBe(1);
    expect(explicitSelections(refs.slice(0, 1), refs.slice(1))).toEqual([{ ref: track, role: "primary", origin: "explicit", declaredIndex: 1 }]);
    expect(explicitSelections(["https://soundcloud.com/one/same", "https://soundcloud.com/two/same"])).toHaveLength(2);
    const soundcloud = { resolve: async (source: ReturnType<typeof parseSource>) => ({ provider: "soundcloud" as const,
      id: "2422119177", canonicalUrl: source.canonicalUrl, author: { handle: "rrthielnc" }, text: "Original writing", media: [],
      soundcloud: { kind: "track" as const, trackId: "2422119177", artists: ["Fixture artist"], description: "Original writing", originalDownloadAvailable: false } }) };
    const resolver = new SocialResolver({ soundcloud }, async () => redirect(track));
    const resolved = await resolver.resolveComposition([share], [track], { media: "none", threadExpansion: "off" });
    expect(resolved.posts).toHaveLength(1); expect(resolved.posts[0]!.selection?.role).toBe("primary");
    expect(composePlan(resolved.posts, resolved.policy).block.canonicalSource).toBe(track);
  });

  test("native/browser composition uses the injected reader for both redirect and source page", async () => {
    const calls: string[] = [];
    const plan = await resolveCapture({ primary: [share], extras: [], policy: { media: "none", threadExpansion: "off" } }, undefined,
      (async (input, init) => { const url = String(input); calls.push(url);
        if (url === share) { expect(init?.method).toBe("HEAD"); return redirect(track); }
        if (url === track) { expect(init?.redirect).toBe("manual"); return new Response(html, { headers: { "content-type": "text/html" } }); }
        throw new Error("Unexpected request " + url);
      }) as typeof fetch);
    expect(calls).toEqual([share, track]); expect(plan.block.kind).toBe("url"); expect(plan.block.canonicalSource).toBe(track);
    expect(plan.sources[0]!.soundcloud?.kind).toBe("track");
    expect(requiredOrigins([share])).toEqual(["https://on.soundcloud.com/*", "https://soundcloud.com/*"]);
    const manifest = permissionManifest("named-sources", true, []);
    for (const origin of requiredOrigins([share])) expect(manifest.optional_host_permissions).toContain(origin);
  });
});
