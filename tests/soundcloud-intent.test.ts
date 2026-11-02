import { expect, test } from "bun:test";
import { composePlan } from "../packages/core/compose.ts";
import { publicationFields, publicationPayload } from "../packages/core/capture.ts";
import { verifyPublication } from "../packages/core/verification.ts";
import { blockPlanSchema } from "../packages/core/types.ts";
import { SocialResolver } from "../src/providers/index.ts";
import { SoundCloudProvider } from "../src/providers/soundcloud.ts";
import { selectedPostMediaPolicy } from "../src/cli-media.ts";
import { resolveCapture, revisePlan } from "../extension/src/core.ts";

const url = "https://soundcloud.com/fixture/original-track";
const info = (formats: unknown[] = []) => ({ id: "123", title: "Original track", track: "Original track", webpage_url: url,
  uploader: "Original artist", artists: ["Original artist"], availability: "public", duration: 60,
  description: "Authored description", thumbnail: "https://i1.sndcdn.com/artworks-fixture-original.jpg", formats });
const original = { format_id: "download", ext: "wav", vcodec: "none", url: "https://media.invalid/original.wav" };
const provider = (formats: unknown[] = []) => new SoundCloudProvider(async () => ({ stdout: JSON.stringify(info(formats)), stderr: "" }));

test("fresh All and Audio refuse unavailable full audio before any publication", async () => {
  for (const media of ["all", "audio"] as const) for (const formats of [[], [{ format_id: "hls_aac_160", ext: "m4a", vcodec: "none" }]]) {
    const resolver = new SocialResolver({ soundcloud: provider(formats) });
    await expect(resolver.resolveComposition([url], [], { media, threadExpansion: "off" })).rejects.toThrow("No supported full SoundCloud audio");
  }
  const converted = await new SocialResolver({ soundcloud: provider([{ ...original, ext: "mp4" }]) })
    .resolveComposition([url], [], { media: "audio" });
  expect(composePlan(converted.posts, converted.policy).block.kind).toBe("audio");
  expect(converted.posts[0]!.media[0]!.acquisition).toBe("soundcloud-mp3");
});

test("Auto retains its documented source-link fallback and explicit None/Images remain distinct", async () => {
  const resolver = new SocialResolver({ soundcloud: provider() });
  for (const media of ["auto", "none", "images"] as const) {
    const resolved = await resolver.resolveComposition([url], [], { media, threadExpansion: "off" });
    const policy = selectedPostMediaPolicy(resolved.posts, resolved.policy);
    expect(policy.media).toBe(media);
    const plan = composePlan(resolved.posts, policy);
    expect(plan.block.kind).toBe("url"); expect(plan.block.selectedMedia).toEqual([]);
    expect(plan.block.artworkUrl).toBe(media === "none" ? undefined : info().thumbnail);
    const received = { state: "available", type: "Embed", title: plan.block.title,
      description: { markdown: publicationFields(plan).description }, source: { url } };
    expect(() => verifyPublication(plan, received, received)).not.toThrow();
  }
});

test("available original audio retains identity, exact attribution and attachment payload", async () => {
  const resolved = await new SocialResolver({ soundcloud: provider([original]) }).resolveComposition([url], [], { media: "all", threadExpansion: "off" });
  const plan = composePlan(resolved.posts, selectedPostMediaPolicy(resolved.posts, resolved.policy));
  expect(plan.policy.media).toBe("all"); expect(plan.block.kind).toBe("audio"); expect(plan.block.selectedMedia).toEqual(["1.1"]);
  expect(plan.block.canonicalSource).toBe(url); expect(plan.sources[0]!.author.name).toBe("Original artist");
  expect(plan.block.markdown).toContain("Artist: Original artist"); expect(plan.block.markdown).toContain("Authored description");
  const payload = publicationPayload(plan, "https://media.invalid", { hash: "a".repeat(64), extension: "wav" }, [7]);
  expect(payload.original_source_url).toBe(url); expect(payload.value).toBe(`https://media.invalid/media/${"a".repeat(64)}.wav`);
  const received = { state: "available", type: "Attachment", title: plan.block.title, description: { markdown: publicationFields(plan).description },
    source: { url }, attachment: { content_type: "audio/wav", url: payload.value } };
  expect(() => verifyPublication(plan, received, received)).not.toThrow();
  expect(() => verifyPublication(plan, { ...received, source: { url: "https://soundcloud.com/other/track" } }, received)).toThrow("SoundCloud source");
  expect(() => verifyPublication(plan, { ...received, type: "Embed" }, received)).toThrow("Expected audio Attachment");
  expect(() => verifyPublication(plan, { ...received, attachment: { content_type: "video/mp4" } }, received)).toThrow("audio content type");
});

test("an explicit source-link choice can verify a SoundCloud Embed with its exact source", async () => {
  const resolved = await new SocialResolver({ soundcloud: provider() }).resolveComposition([url], [], { media: "none" });
  const plan = composePlan(resolved.posts, resolved.policy);
  const received = { state: "available", type: "Embed", title: plan.block.title, description: { markdown: publicationFields(plan).description }, source: { url } };
  expect(() => verifyPublication(plan, received, received)).not.toThrow();
  expect(() => verifyPublication(plan, { ...received, source: { url: "https://soundcloud.com/other/track" } }, received)).toThrow("SoundCloud source");
});

test("cached source recomposition cannot turn missing audio into an All/Audio URL fallback", async () => {
  const resolved = await new SocialResolver({ soundcloud: provider() }).resolveComposition([url], [], { media: "auto" });
  const cached = composePlan(resolved.posts, resolved.policy);
  for (const media of ["all", "audio"] as const) {
    expect(() => composePlan(cached.sources, { ...cached.policy, media })).toThrow("No supported full SoundCloud audio");
    expect(() => revisePlan(cached, { policy: { media } })).toThrow("No supported full SoundCloud audio");
  }
  expect(composePlan(cached.sources, { media: "none" }).block.kind).toBe("url");
});

test("native capture uses MP3 acquisition independently of original availability", async () => {
  for (const enabled of [false, true]) {
    const html = `<script>window.__sc_hydration = ${JSON.stringify([{ hydratable: "sound", data: { kind: "track", id: 123,
      title: "Original track", permalink_url: url, sharing: "public", user: { username: "Original artist" }, downloadable: enabled } }])};</script>`;
    const read = (async () => new Response(html, { headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    const plan = await resolveCapture({ primary: [url], extras: [], policy: { media: "all" } }, undefined, read);
    expect(plan.block.kind).toBe("audio");
    expect(plan.sources[0]!.media[0]!.acquisition).toBe("soundcloud-mp3");
    expect((await resolveCapture({ primary: [url], extras: [], policy: { media: "none" } }, undefined, read)).block.kind).toBe("url");
  }
});

test("the retained URL plan replays exactly and does not verify an Embed as requested audio", async () => {
  const plan = blockPlanSchema.parse(await Bun.file(new URL("fixtures/soundcloud-url-legacy-plan.json", import.meta.url)).json());
  expect(plan.hash).toBe("5f274f4c563f060fa3cea71cd6a4a34bb46c4e6e29c19f672882d3d56b9a6c11");
  expect(composePlan(plan.sources, plan.policy)).toEqual(plan);
  expect(plan.policy.media).toBe("selected"); expect(plan.policy.selectedMedia).toEqual([]);
  const received = { state: "available", type: "Embed", title: plan.block.title, description: { markdown: publicationFields(plan).description },
    source: { url: plan.block.canonicalSource } };
  expect(() => verifyPublication(plan, received, received)).toThrow("Expected Link block");
});
