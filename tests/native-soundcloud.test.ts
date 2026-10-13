import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createContext, runInContext } from "node:vm";
import { composePlan } from "../packages/core/compose.ts";
import { NativeSoundCloudProvider, soundCloudPostFromPage } from "../packages/core/providers/soundcloud-native.ts";
import { parseSource } from "../packages/core/url.ts";

const trackURL = "https://soundcloud.com/fixture/synthetic-track";
const playlistURL = "https://soundcloud.com/fixture/sets/synthetic-playlist";
const track = {
  kind: "track", id: 1001, title: "Synthetic track", permalink_url: trackURL,
  user: { username: "Fixture artist" }, publisher_metadata: { artist: "Exact artist" },
  duration: 61345, created_at: "2026-10-07T01:02:03Z", description: "Original source description",
  sharing: "public", downloadable: false, has_downloads_left: false,
  artwork_url: "https://i1.sndcdn.com/artworks-fixture-large.jpg",
};
const playlist = {
  kind: "playlist", id: 2001, title: "Synthetic playlist", permalink_url: playlistURL,
  user: { username: "Fixture artist" }, description: "Playlist description", sharing: "public",
  created_at: "2026-10-07T01:02:03Z", artwork_url: "https://i1.sndcdn.com/artworks-playlist-large.jpg",
  track_count: 2, tracks: [
    { ...track, title: "First", id: 1001, duration: 61345, permalink_url: trackURL },
    { ...track, title: "Second", id: 1002, duration: null, permalink_url: "https://soundcloud.com/fixture/second" },
  ],
};
const page = (kind: "sound" | "playlist", data: unknown) => `<html><script>window.__sc_hydration = ${JSON.stringify([{ hydratable: kind, data }])};</script></html>`;
const bundle = await Bun.file(new URL("../ios/Sources/CaptureRuntime/Resources/capture-core.js", import.meta.url)).text();

describe("native SoundCloud page resolver", () => {
  test("track preserves identity, exact credit and duration, with an honest Link fallback", () => {
    const source = parseSource(trackURL);
    if (source.provider !== "soundcloud") throw new Error("bad fixture");
    const post = soundCloudPostFromPage(source, page("sound", track));
    expect(post.postTitle).toBe("Synthetic track");
    expect(post.soundcloud).toMatchObject({ kind: "track", artists: ["Exact artist"], durationSeconds: 61.345, originalDownloadAvailable: false });
    expect(post.media).toEqual([]);
    const plan = composePlan([post], { media: "all" });
    expect(plan.block.kind).toBe("url");
    expect(plan.block.canonicalSource).toBe(trackURL);
  });

  test("offered download remains a Link without a verified original file URL", () => {
    const source = parseSource(trackURL);
    if (source.provider !== "soundcloud") throw new Error("bad fixture");
    const post = soundCloudPostFromPage(source, page("sound", { ...track, downloadable: true, has_downloads_left: true }));
    expect(post.soundcloud).toMatchObject({ originalDownloadAvailable: true });
    expect(post.media).toEqual([]);
    expect(post.text).toContain("did not provide a verified original file URL");
  });

  test("playlist keeps exact order, absent duration and artwork; media none omits artwork", () => {
    const source = parseSource(playlistURL);
    if (source.provider !== "soundcloud") throw new Error("bad fixture");
    const post = soundCloudPostFromPage(source, page("playlist", playlist));
    expect(post.soundcloud).toMatchObject({ declaredTrackCount: 2, tracks: [{ title: "First", durationSeconds: 61.345 }, { title: "Second" }] });
    const all = composePlan([post], { media: "all" });
    expect(all.block.kind).toBe("image");
    expect(all.block.kind).toBe("image");
    expect(all.block.artworkUrl).toBe("https://i1.sndcdn.com/artworks-playlist-large.jpg");
    expect(all.block.markdown).toContain("Source: [SoundCloud playlist](");
    expect(all.block.markdown.indexOf("First")).toBeLessThan(all.block.markdown.indexOf("Second"));
    const none = composePlan([post], { media: "none" });
    expect(none.block.kind).toBe("text");
    expect(none.block.artworkUrl).toBeUndefined();
    expect(none.block.markdown).toContain("Second");
  });

  test("refuses truncation, private entries, wrong identities and missing hydration", () => {
    const source = parseSource(playlistURL);
    if (source.provider !== "soundcloud") throw new Error("bad fixture");
    expect(() => soundCloudPostFromPage(source, page("playlist", { ...playlist, track_count: 3 }))).toThrow("incomplete");
    expect(() => soundCloudPostFromPage(source, page("playlist", { ...playlist, tracks: [{ ...track, sharing: "private" }, playlist.tracks[1]] }))).toThrow("private or unavailable");
    expect(() => soundCloudPostFromPage(source, page("playlist", { ...playlist, permalink_url: trackURL }))).toThrow();
    expect(() => soundCloudPostFromPage(source, "<html></html>")).toThrow("no source metadata");
  });

  test("fetches only the source page and rejects redirects or non-HTML responses", async () => {
    const requests: string[] = [];
    const provider = new NativeSoundCloudProvider(async (input) => {
      requests.push(String(input));
      return new Response(page("sound", track), { headers: { "content-type": "text/html" } });
    });
    const resolved = await provider.resolve(parseSource(trackURL));
    expect(resolved.id).toBe("1001");
    expect(requests).toEqual([trackURL]);
    const redirected = new NativeSoundCloudProvider(async () => new Response("", { status: 302 }));
    await expect(redirected.resolve(parseSource(trackURL))).rejects.toThrow("redirected");
  });

  test("completes an ID-only playlist row with public oEmbed and a matching track page", async () => {
    const stub = { id: 1002, kind: "track" };
    const partial = { ...playlist, tracks: [playlist.tracks[0], stub] };
    const secondURL = "https://soundcloud.com/fixture/second";
    const calls: string[] = [];
    const provider = new NativeSoundCloudProvider(async (url) => {
      calls.push(url);
      if (url === playlistURL) return new Response(page("playlist", partial), { headers: { "content-type": "text/html" } });
      if (url.startsWith("https://soundcloud.com/oembed?")) return new Response(JSON.stringify({
        provider_name: "SoundCloud", title: "Second by Fixture artist", author_name: "Fixture artist", author_url: "https://soundcloud.com/fixture",
      }), { headers: { "content-type": "application/json" } });
      if (url === secondURL) return new Response(page("sound", { ...track, id: 1002, title: "Second", permalink_url: secondURL }), { headers: { "content-type": "text/html" } });
      throw new Error(`Unexpected ${url}`);
    });
    const resolved = await provider.resolve(parseSource(playlistURL));
    expect(resolved.soundcloud).toMatchObject({ kind: "playlist", tracks: [{ title: "First" }, { title: "Second" }] });
    expect(calls).toEqual([playlistURL, expect.stringContaining("/oembed?"), secondURL]);
  });

  test("rebuilt JavaScriptCore bundle resolves a playlist through one public page read", async () => {
    const calls: string[] = [];
    let complete!: (value: { value: string | null; error: string | null }) => void;
    const done = new Promise<{ value: string | null; error: string | null }>(resolve => { complete = resolve; });
    const context = createContext({
      nativeSHA256: (value: string) => createHash("sha256").update(value).digest("hex"),
      setTimeout, clearTimeout, nativeCancelHTTP: () => {},
      nativeHTTP: (id: number, raw: string) => {
        const request = JSON.parse(raw);
        calls.push(request.url);
        expect(request.redirect).toBe("manual");
        queueMicrotask(() => context.captureHTTPComplete(id, JSON.stringify({ status: 200, headers: { "content-type": "text/html" }, body: page("playlist", playlist), url: request.url })));
      },
      nativeResolveComplete: (_id: string, value: string | null, error: string | null) => complete({ value, error }),
    });
    runInContext(bundle, context);
    context.captureResolve("soundcloud", JSON.stringify([playlistURL]), "{}");
    const result = await done;
    expect(result.error).toBeNull();
    expect(JSON.parse(result.value!).plan.block.kind).toBe("image");
    expect(JSON.parse(result.value!).plan.block.markdown).toContain("Second");
    expect(calls).toEqual([playlistURL]);
  });
});
