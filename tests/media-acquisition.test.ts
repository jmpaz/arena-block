import { expect, test } from "bun:test";
import { resolveMediaURL } from "../packages/core/media-acquisition.ts";
const did = "did:plc:ewvi7nxzyoun6zhxrhs64oiz";
const video = `https://video.bsky.app/watch/${did}/bafkreitest123/playlist.m3u8`;

test("Bluesky HLS maps to original blob through matching PDS identity", async () => {
  for (const id of ["#atproto_pds", `${did}#atproto_pds`]) {
    const result = await resolveMediaURL(video, async url => {
      expect(url).toBe(`https://plc.directory/${did}`);
      return Response.json({ id: did, service: [{ id, type: "AtprotoPersonalDataServer", serviceEndpoint: "https://pds.example.com" }] });
    });
    expect(result).toBe(`https://pds.example.com/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(did)}&cid=bafkreitest123`);
  }
});

test("media acquisition leaves unrelated URLs untouched and validates identity and server", async () => {
  expect(await resolveMediaURL("https://example.com/video.mp4", async () => { throw new Error("Unexpected fetch"); })).toBe("https://example.com/video.mp4");
  for (const serviceEndpoint of ["http://pds.example.com", "https://user:pass@pds.example.com", "https://pds.example.com/path", "https://pds.example.com/?query=1"]) {
    await expect(resolveMediaURL(video, async () => Response.json({ id: did, service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint }] }))).rejects.toThrow("Invalid Bluesky personal data server URL");
  }
  await expect(resolveMediaURL(video, async () => Response.json({ id: "did:plc:other" }))).rejects.toThrow("does not match");
  await expect(resolveMediaURL(video, async () => new Response("", { status: 503 }))).rejects.toThrow("503");
});

import { redditMediaSources, resolveMediaSources } from "../packages/core/media-acquisition.ts";
const dash = `<MPD><Period><AdaptationSet mimeType="video/mp4" codecs="avc1.64001f"><Representation bandwidth="100"><BaseURL>DASH_240.mp4</BaseURL></Representation><Representation bandwidth="500"><BaseURL>DASH_720.mp4?source=fallback&amp;test=1</BaseURL></Representation></AdaptationSet><AdaptationSet mimeType="audio/mp4" codecs="mp4a.40.2"><Representation bandwidth="128"><BaseURL>audio.actual.mp4</BaseURL></Representation></AdaptationSet></Period></MPD>`;

test("Reddit uses manifest-declared video and audio sources without guessed filenames", async () => {
  const result = await resolveMediaSources("https://v.redd.it/abc/HLSPlaylist.m3u8", async url => {
    expect(url).toBe("https://v.redd.it/abc/DASHPlaylist.mpd");
    return new Response(dash);
  });
  expect(result).toEqual({ url: "https://v.redd.it/abc/DASH_720.mp4?source=fallback&test=1", audioURL: "https://v.redd.it/abc/audio.actual.mp4" });
  expect(() => redditMediaSources(dash.replace("mp4a.40.2", "unsupported"), "https://v.redd.it/abc/DASHPlaylist.mpd")).toThrow("audio has no supported");
  expect(() => redditMediaSources(dash.replace("DASH_240.mp4", "https://evil.test/video.mp4"), "https://v.redd.it/abc/DASHPlaylist.mpd")).toThrow("Invalid Reddit DASH media URL");
});
