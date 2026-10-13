import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { composePlan } from "../packages/core/compose.ts";
import { publicationFields, publicationPayload, publicationPayloadForMedia } from "../packages/core/capture.ts";
import { verifyPublication } from "../packages/core/verification.ts";
import { blockPlanSchema } from "../packages/core/types.ts";
import { parseSource } from "../packages/core/url.ts";
import { SocialResolver } from "../src/providers/index.ts";
import { createYtDlpRunner, isolatedYtDlpArgs, SoundCloudProvider, type YtDlpRunner } from "../src/providers/soundcloud.ts";
import { renderPlan } from "../src/render.ts";
import { createService } from "../src/service.ts";
import { ArenaClient, ArenaPublisher } from "../src/arena.ts";
import { ArenaBlockStore } from "../src/store.ts";
import { MockApi } from "./fixtures/remote-api.ts";

const dirs: string[] = [];
afterAll(async () => { await Promise.all(dirs.map(directory => rm(directory, { recursive: true, force: true }))); });

const trackURL = "https://soundcloud.com/example-artist/night-flight";
const art = "https://i1.sndcdn.com/artworks-test-original.jpg";
const trackInfo = (formats: unknown[] = [{ format_id: "download", ext: "wav", vcodec: "none", url: "https://media.invalid/original.wav" }], extra: Record<string, unknown> = {}) => ({
  id: "91234", title: "Night Flight", track: "Night Flight", description: "First paragraph.\n\nSecond paragraph.",
  uploader: "Example Artist", uploader_id: "example-artist", artists: ["Example Artist", "Guest Artist"],
  duration: 211.25, upload_date: "20250102", availability: "public", webpage_url: trackURL,
  thumbnail: art, formats, like_count: 1234, comment_count: 77, ...extra,
});
const playlistURL = "https://soundcloud.com/example-artist/sets/night-drives";
const playlistInfo = (extra: Record<string, unknown> = {}) => ({
  id: "set-55", title: "Night Drives", description: "A playlist description.", uploader: "Example Artist",
  uploader_id: "example-artist", availability: "public", webpage_url: playlistURL, playlist_count: 2, thumbnail: art,
  entries: [
    { id: "t1", title: "First Track", artists: ["Alpha"], duration: 125.7, webpage_url: "https://soundcloud.com/alpha/first-track", availability: "public" },
    { id: "t2", title: "Second Track", uploader: "Beta", webpage_url: "https://soundcloud.com/beta/second-track", availability: "public" },
  ], ...extra,
});

function provider(output: unknown, calls: string[][] = []) {
  const run: YtDlpRunner = async args => { calls.push(args); return { stdout: JSON.stringify(output), stderr: "" }; };
  return new SoundCloudProvider(run);
}

async function resolve(url: string, output: unknown, media: "auto" | "all" | "none" | "audio" | "images" = "auto") {
  const soundcloud = provider(output);
  const posts = await new SocialResolver({ soundcloud }).resolve([url]);
  return { post: posts[0]!, plan: blockPlanSchema.parse(composePlan(posts, { media })) };
}

describe("SoundCloud source identity", () => {
  test("recognizes public tracks and regular playlists and rejects graph/private routes", () => {
    expect(parseSource("https://www.soundcloud.com/example-artist/night-flight?si=tracking#comments")).toEqual({
      provider: "soundcloud", kind: "track", id: "night-flight", canonicalUrl: trackURL,
    });
    expect(parseSource("https://soundcloud.com/example-artist/sets/night-drives")).toEqual({
      provider: "soundcloud", kind: "playlist", id: "night-drives", canonicalUrl: playlistURL,
    });
    for (const value of ["https://soundcloud.com/example-artist/likes", "https://soundcloud.com/example-artist/reposts",
      "https://soundcloud.com/example-artist/tracks", "https://soundcloud.com/example-artist/albums",
      "https://soundcloud.com/likes", "https://soundcloud.com/example-artist/sets/night-drives/s-secret",
      "https://soundcloud.com/example-artist/night-flight?secret_token=secret", "http://soundcloud.com/example-artist/night-flight",
      "https://user@soundcloud.com/example-artist/night-flight"]) expect(() => parseSource(value)).toThrow();
  });

  test("isolates yt-dlp from user configuration and credential sources", () => {
    const args = isolatedYtDlpArgs(["--simulate", "--dump-single-json", "--", trackURL]);
    expect(args.slice(0, 3)).toEqual(["--ignore-config", "--no-cache-dir", "--no-warnings"]);
    expect(args).not.toContain("--cookies-from-browser");
    expect(args).not.toContain("--netrc");
    expect(args.at(-1)).toBe(trackURL);
  });

  test("bounds a stalled yt-dlp metadata read and honors cancellation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arena-soundcloud-runner-")); dirs.push(directory);
    const binary = join(directory, "yt-dlp-fixture");
    await Bun.write(binary, "#!/bin/sh\nexec sleep 30\n");
    await chmod(binary, 0o700);
    await expect(createYtDlpRunner(binary, { metadataTimeoutMs: 100 })(["--simulate", trackURL])).rejects.toThrow();
    const controller = new AbortController();
    const pending = createYtDlpRunner(binary)(["--simulate", trackURL], controller.signal);
    setTimeout(() => controller.abort(new Error("SoundCloud capture cancelled")), 50);
    await expect(pending).rejects.toThrow("SoundCloud capture cancelled");
  });
});

describe("SoundCloud track adapter", () => {
  test("retains track identity, exact description, credits, duration and artwork without comment/like data", async () => {
    const calls: string[][] = [];
    const soundcloud = provider(trackInfo(), calls);
    const posts = await new SocialResolver({ soundcloud }).resolve([trackURL]);
    const post = posts[0]!;
    expect(calls[0]).toContain("--simulate");
    expect(calls[0]).toContain("--dump-single-json");
    expect(calls[0]).toContain("--no-playlist");
    expect(calls[0]?.at(-1)).toBe(trackURL);
    expect(post).toMatchObject({ provider: "soundcloud", id: "91234", canonicalUrl: trackURL, postTitle: "Night Flight",
      author: { handle: "example-artist", name: "Example Artist" },
      soundcloud: { kind: "track", trackId: "91234", artists: ["Example Artist", "Guest Artist"], description: "First paragraph.\n\nSecond paragraph.",
        durationSeconds: 211.25, artworkUrl: art, originalDownloadAvailable: true } });
    expect(post.media).toHaveLength(1);
    expect(post.media[0]).toMatchObject({ kind: "audio", mimeType: "audio/wav", acquisition: "soundcloud-original-download", durationSeconds: 211.25 });
    expect(post.text).toContain("Artists: Example Artist, Guest Artist");
    expect(post.text).toContain("Duration: 3:31");
    expect(post.text).toContain("First paragraph.\n\nSecond paragraph.");
    expect(post.text).not.toMatch(/like_count|comment_count|1234|77/);
    expect(post.postedAt).toBeUndefined(); // A date-only upload_date is not an exact timestamp.
    expect((await provider(trackInfo(undefined, { timestamp: 1_735_776_000 })).resolve(parseSource(trackURL))).postedAt).toBe("2025-01-02T00:00:00.000Z");
  });

  test("does not substitute a stream when the explicit original download is absent", async () => {
    const streamingOnly = trackInfo([{ format_id: "http_mp3_128", ext: "mp3", vcodec: "none", url: "https://stream.invalid/live.mp3" }]);
    const { post, plan } = await resolve(trackURL, streamingOnly);
    expect(post.media).toEqual([]);
    expect(post.soundcloud).toMatchObject({ originalDownloadAvailable: false });
    expect(plan.block.kind).toBe("url");
    expect(plan.block.canonicalSource).toBe(trackURL);
    expect(plan.block.description).toContain("First paragraph.\n\nSecond paragraph.");
    expect(plan.block.description).toContain("Original audio download is unavailable");
    expect(plan.block.artworkUrl).toBe(art);
    expect(publicationPayload(plan, "https://media.example.test", undefined, []).cover_url).toBe(art);
    expect((await resolve(trackURL, streamingOnly, "none")).plan.block.artworkUrl).toBeUndefined();
    expect((await resolve(trackURL, streamingOnly, "audio")).plan.block.kind).toBe("url");
  });

  test("selects original audio without visual compositing and emits an Are.na audio Attachment", async () => {
    const { plan } = await resolve(trackURL, trackInfo(), "auto");
    expect(plan.block.kind).toBe("audio");
    expect(plan.block.title).toBe("Night Flight");
    expect(plan.block.selectedMedia).toEqual(["1.1"]);
    expect(plan.block.artworkUrl).toBe(art);
    const payload = publicationPayload(plan, "https://media.example.test", { hash: "a".repeat(64), extension: "wav" }, [7, 7]);
    expect(payload).toMatchObject({ value: `https://media.example.test/media/${"a".repeat(64)}.wav`,
      title: "Night Flight", original_source_url: trackURL, cover_url: art,
      channel_ids: [7] });
    expect(payload.description).toBe(`arena-block description ${plan.hash}`);
    expect(publicationFields(plan).description).toBe(plan.block.markdown);
    expect(payload.value).not.toContain("stream.invalid");
    expect(() => verifyPublication(plan, { state: "available", type: "Attachment", title: "Night Flight",
      description: { markdown: plan.block.markdown }, attachment: { content_type: "audio/wav", url: payload.value } }, { state: "available" })).not.toThrow();
    expect(() => verifyPublication(plan, { state: "available", type: "Embed", title: "Night Flight",
      description: { markdown: plan.block.markdown } }, { state: "available" })).toThrow("Expected audio Attachment");
    expect(composePlan(plan.sources, { media: "none" }).block.kind).toBe("url");
  });

  test("copies original file bytes through yt-dlp and exposes the truthful audio MIME type", async () => {
    const { plan } = await resolve(trackURL, trackInfo(), "audio");
    const directory = await mkdtemp(join(tmpdir(), "arena-soundcloud-audio-")); dirs.push(directory);
    const audio = new Uint8Array(44 + 1600);
    const view = new DataView(audio.buffer);
    const ascii = (offset: number, value: string) => [...value].forEach((character, index) => audio[offset + index] = character.charCodeAt(0));
    ascii(0, "RIFF"); view.setUint32(4, audio.length - 8, true); ascii(8, "WAVE"); ascii(12, "fmt ");
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 8000, true);
    view.setUint32(28, 16000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); ascii(36, "data"); view.setUint32(40, 1600, true);
    let argsSeen: string[] = [];
    const media = await renderPlan(plan, directory, { ytDlp: async args => {
      argsSeen = args;
      const output = args[args.indexOf("--output") + 1]!.replace("%(ext)s", "wav");
      await Bun.write(output, audio);
      return { stdout: "", stderr: "" };
    } });
    expect(argsSeen).toContain("--format");
    expect(argsSeen[argsSeen.indexOf("--format") + 1]).toBe("download");
    expect(argsSeen).toContain("--no-playlist");
    expect(argsSeen).toContain("--max-filesize");
    expect(argsSeen[argsSeen.indexOf("--max-filesize") + 1]).toBe("250M");
    expect(argsSeen).not.toContain("--extract-audio");
    expect(media).toMatchObject({ extension: "wav", mimeType: "audio/wav", size: audio.length,
      hash: createHash("sha256").update(audio).digest("hex") });
  });

  test("rejects an original whose bytes disagree with its extension", async () => {
    const { plan } = await resolve(trackURL, trackInfo([{ format_id: "download", ext: "mp3", vcodec: "none" }]));
    const directory = await mkdtemp(join(tmpdir(), "arena-soundcloud-mime-")); dirs.push(directory);
    const audio = new Uint8Array(44 + 1600);
    const view = new DataView(audio.buffer);
    const ascii = (offset: number, value: string) => [...value].forEach((character, index) => audio[offset + index] = character.charCodeAt(0));
    ascii(0, "RIFF"); view.setUint32(4, audio.length - 8, true); ascii(8, "WAVE"); ascii(12, "fmt ");
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 8000, true);
    view.setUint32(28, 16000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); ascii(36, "data"); view.setUint32(40, 1600, true);
    await expect(renderPlan(plan, directory, { ytDlp: async args => {
      await Bun.write(args[args.indexOf("--output") + 1]!.replace("%(ext)s", "mp3"), audio);
      return { stdout: "", stderr: "" };
    } })).rejects.toThrow("does not match its .mp3 file extension");
  });

  test("rejects private, unavailable, mismatched, or unsupported original media metadata", async () => {
    await expect(provider(trackInfo([], { availability: "private" })).resolve(parseSource(trackURL))).rejects.toThrow("only publicly available");
    await expect(provider(trackInfo([], { webpage_url: "https://soundcloud.com/other/track" })).resolve(parseSource(trackURL))).rejects.toThrow("different SoundCloud item");
    const unsupported = trackInfo([{ format_id: "download", ext: "mp4", vcodec: "none", url: "https://media.invalid/audio.mp4" }]);
    const unsupportedPost = await provider(unsupported).resolve(parseSource(trackURL));
    expect(unsupportedPost.media).toEqual([]);
    expect(unsupportedPost.soundcloud).toMatchObject({ originalDownloadAvailable: true, originalDownloadExtension: "mp4" });
    expect(unsupportedPost.text).toContain("downloadable as .mp4");
  });
});

describe("SoundCloud playlist adapter", () => {
  test("preserves ordered playlist text in a native Image description when artwork is selected", async () => {
    const { post, plan } = await resolve(playlistURL, playlistInfo());
    expect(post.soundcloud).toMatchObject({ kind: "playlist", declaredTrackCount: 2,
      description: "A playlist description.", artworkUrl: art,
      tracks: [{ title: "First Track", artists: ["Alpha"], durationSeconds: 125.7 }, { title: "Second Track", artists: ["Beta"] }] });
    expect(plan.block.kind).toBe("image");
    expect(plan.block.title).toBe("Night Drives");
    expect(plan.block.canonicalSource).toBe(playlistURL);
    expect(plan.block.markdown).toContain("A playlist description.");
    expect(plan.block.markdown).toContain("1. [First Track — Alpha](https://soundcloud.com/alpha/first-track) (2:05)");
    expect(plan.block.markdown).toContain("2. [Second Track — Beta](https://soundcloud.com/beta/second-track)");
    expect(plan.block.markdown.indexOf("First Track")).toBeLessThan(plan.block.markdown.indexOf("Second Track"));
    expect(plan.block.artworkUrl).toBe(art);
    expect(plan.block.markdown).not.toContain("Playlist artwork");
    expect(plan.block.markdown).toContain(`Source: [SoundCloud playlist](${playlistURL})`);
    expect(plan.block.markdown).toContain(" (2:05)\n2. [Second Track");
    expect(plan.block.selectedMedia).toEqual([]);
    const payload = publicationPayload(plan, "https://media.example.test", undefined, [7]);
    expect(payload).toMatchObject({ value: art,
      original_source_url: playlistURL, channel_ids: [7] });
    expect(payload.description).toBe(`arena-block description ${plan.hash}`);
    expect(publicationFields(plan).description).toBe(plan.block.markdown);
    expect(payload).not.toHaveProperty("cover_url"); // An Image uses its source artwork as value.
    expect(JSON.stringify(payload)).not.toContain("/media/");
    expect(publicationPayloadForMedia(plan, undefined, undefined, [7])).toEqual(payload);
    const received = { state: "available", type: "Image", title: "Night Drives",
      description: { markdown: plan.block.markdown }, image: { src: "https://arena-copied.invalid/art.jpg" },
      source: { url: playlistURL } };
    expect(() => verifyPublication(plan, received, { state: "available" })).not.toThrow();
    expect(() => verifyPublication(plan, { ...received, description: { markdown: plan.block.markdown.replace("First Track", "Other Track") } },
      { state: "available" })).toThrow("Markdown does not match");
    expect(() => verifyPublication(plan, { ...received, image: null }, { state: "available" })).toThrow("copied artwork");
    expect(() => verifyPublication(plan, { ...received, source: { url: "https://other.invalid" } },
      { state: "available" })).toThrow("source does not match");
    expect(() => blockPlanSchema.parse({ ...plan, block: { ...plan.block, artworkUrl: "https://evil.example/remote.jpg" } })).toThrow("sndcdn.com");
    const withoutMedia = (await resolve(playlistURL, playlistInfo(), "none")).plan;
    expect(withoutMedia.block.kind).toBe("text");
    expect(withoutMedia.block.markdown).not.toContain("SoundCloud playlist](");
    expect((await resolve(playlistURL, playlistInfo(), "images")).plan.block.kind).toBe("image");
    expect((await resolve(playlistURL, playlistInfo(), "all")).plan.block.kind).toBe("image");
    const noArtwork = await resolve(playlistURL, playlistInfo({ thumbnail: undefined, thumbnails: [] }));
    expect(noArtwork.post.soundcloud).not.toHaveProperty("artworkUrl");
    expect(noArtwork.plan.block.kind).toBe("text");
    expect(noArtwork.plan.block.markdown).toContain("First Track");
  });

  test("refuses partial, reordered-by-omission, private-entry, and over-limit playlists", async () => {
    const calls: string[][] = [];
    await provider(playlistInfo(), calls).resolve(parseSource(playlistURL));
    expect(calls[0]).toContain("--ignore-no-formats-error");
    expect(calls[0]!.slice(calls[0]!.indexOf("--playlist-end"), calls[0]!.indexOf("--playlist-end") + 2)).toEqual(["--playlist-end", "1001"]);
    await expect(provider(playlistInfo({ entries: [playlistInfo().entries[0]] })).resolve(parseSource(playlistURL))).rejects.toThrow("incomplete");
    await expect(provider(playlistInfo({ entries: [playlistInfo().entries[0], null] })).resolve(parseSource(playlistURL))).rejects.toThrow("entry 2 is unavailable");
    await expect(provider(playlistInfo({ entries: [{ ...playlistInfo().entries[0], availability: "private" }, playlistInfo().entries[1]] })).resolve(parseSource(playlistURL))).rejects.toThrow("only publicly available");
    await expect(provider(playlistInfo({ playlist_count: 1001 })).resolve(parseSource(playlistURL))).rejects.toThrow("safe complete-capture limit");
    await expect(provider(playlistInfo({ webpage_url: "https://soundcloud.com/other/sets/not-this-set" })).resolve(parseSource(playlistURL))).rejects.toThrow("different SoundCloud item");
  });
});

test("Image playlist publication uses original artwork without a public render and reuses its verified block", async () => {
  const { plan } = await resolve(playlistURL, playlistInfo());
  const directory = await mkdtemp(join(tmpdir(), "arena-soundcloud-image-publisher-")); dirs.push(directory);
  const api = new MockApi();
  const original = api.fetch;
  api.fetch = async (input, init) => {
    const response = await original(input, init);
    if (init?.method === "POST" && new URL(String(input)).pathname.endsWith("/blocks")) {
      const block = [...api.blocks.values()].at(-1)!;
      block.type = "Image";
      block.content = null;
      block.image = { src: "https://arena-copied.invalid/synthetic-art.jpg" };
      block.source = { url: playlistURL };
    }
    return response;
  };
  const store = new ArenaBlockStore(join(directory, "state.sqlite"));
  let rendered = 0;
  try {
    const client = new ArenaClient("fixture-never-live", "https://arena.invalid/v3", (...args) => api.fetch(...args), 100);
    const publisher = new ArenaPublisher(client, store, { publicBaseUrl: "https://fixture.invalid",
      mediaDirectory: join(directory, "media"), render: async () => { rendered++; throw new Error("Artwork must not be rendered to public media"); },
      verifyTimeoutMs: 100, pollIntervalMs: 1 });
    const first = await publisher.publish({ plan, destinations: ["901"], force: false });
    expect(first.status).toBe("verified");
    expect(rendered).toBe(0);
    expect(api.creates()).toBe(1);
    expect(api.calls.find(call => call.method === "POST" && call.path === "/blocks")?.body)
      .toMatchObject({ value: art, original_source_url: playlistURL });
    expect(api.calls.find(call => call.method === "POST" && call.path === "/blocks")?.body)
      .toHaveProperty("description", `arena-block description ${plan.hash}`);
    expect(api.calls.find(call => call.method === "PUT" && call.path.endsWith(`/blocks/${first.blockId}`))?.body)
      .toMatchObject({ description: plan.block.markdown });
    const second = await publisher.publish({ plan, destinations: ["901", "902"], force: false });
    expect(second.blockId).toBe(first.blockId);
    expect(second.status).toBe("verified");
    expect(api.creates()).toBe(1);
    expect(api.rows.filter(row => row.block === first.blockId).map(row => row.channel).sort()).toEqual([901, 902]);
  } finally { store.close(); }
});

test("public media endpoint serves an audio artifact with its original MIME type", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arena-soundcloud-route-")); dirs.push(directory);
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const mediaDirectory = join(directory, "media");
  await mkdir(join(mediaDirectory, hash.slice(0, 2)), { recursive: true });
  await Bun.write(join(mediaDirectory, hash.slice(0, 2), `${hash}.mp3`), bytes);
  const service = createService({ host: "localhost", port: 8790, publicBaseUrl: "https://engine.example", stateDirectory: directory,
    mediaDirectory, accessToken: "engine-key", arenaToken: "not-used" });
  try {
    const response = await service.handler(new Request(`https://engine.example/media/${hash}.mp3`, { method: "HEAD" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
    expect(response.headers.get("content-length")).toBe(String(bytes.length));
  } finally { service.close(); }
});
