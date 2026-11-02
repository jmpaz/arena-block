import { describe, expect, test } from "bun:test";
import { AtmosphereProvider } from "../src/providers/atmosphere.ts";
import { SocialResolver } from "../src/providers/index.ts";
import { parseSource } from "../src/url.ts";
import { composePlan } from "../src/compose.ts";
import { blockPlanSchema, type LayoutNode } from "../src/types.ts";

const photo = { type: "photo", url: "https://cdn.example/photo.jpg", width: 1080, height: 1350 };
const video = { type: "video", url: "https://cdn.example/video.mp4", thumbnail_url: "https://cdn.example/poster.jpg", width: 720, height: 1280, duration: 12 };
const status = {
  id: "Ab_c-123", url: "https://www.instagram.com/p/Ab_c-123/", text: "Caption\n\nhttps://example.com",
  created_at: "2026-08-01T12:00:00Z", author: { screen_name: "alice", name: "Alice" },
  media: { all: [photo, video, photo, video] },
};
const leaves = (node: LayoutNode): string[] => node.kind === "media" ? [node.ref] : node.children.flatMap(leaves);

describe("Instagram and TikTok", () => {
  test("canonicalizes post links and accepts bounded short-link shapes", () => {
    expect(parseSource("https://www.instagram.com/alice/p/Ab_c-123/?img_index=2&stkn=tracking").canonicalUrl).toBe(status.url);
    expect(parseSource("https://instagram.com/reels/Ab_c-123/?x=1").canonicalUrl).toBe("https://www.instagram.com/reel/Ab_c-123/");
    expect(parseSource("https://www.tiktok.com/@alice/photo/123?tracking=1").canonicalUrl).toBe("https://www.tiktok.com/@alice/photo/123");
    for (const url of ["https://www.tiktok.com/t/ABC/", "https://vm.tiktok.com/ABC/", "https://vt.tiktok.com/ABC/"]) expect(parseSource(url).id).toBe("ABC");
    for (const url of ["https://instagram.com/alice/", "https://tiktok.com/@alice", "https://tiktok.com/t/ABC/extra", "http://instagram.com/p/Abc/", "https://user:pass@instagram.com/p/Abc/"]) expect(() => parseSource(url)).toThrow();
  });

  test("retains mixed carousel order, all videos, captions, and timestamps", async () => {
    const provider = new AtmosphereProvider("instagram", async (url, init) => {
      expect(String(url)).toBe("https://api.atmosphere.tools/2/instagram/status/Ab_c-123");
      expect(init?.signal).toBeDefined();
      return Response.json({ code: 200, status });
    });
    const posts = await new SocialResolver({ instagram: provider }).resolve([status.url]);
    const plan = blockPlanSchema.parse(composePlan(posts));
    expect(posts[0]!.text).toBe(status.text);
    expect(posts[0]!.postedAt).toBe("2026-08-01T12:00:00.000Z");
    expect(posts[0]!.media.map(m => m.kind)).toEqual(["image", "video", "image", "video"]);
    expect(posts[0]!.media[1]!.durationSeconds).toBe(12);
    expect(posts[0]!.media[1]!.posterUrl).toBe("https://cdn.example/poster.jpg");
    expect(plan.sources[0]!.media[1]!.posterUrl).toBe("https://cdn.example/poster.jpg");
    expect(plan.block.kind).toBe("video");
    expect(leaves(plan.block.layout!)).toEqual(["1.1", "1.2", "1.3", "1.4"]);
    expect(plan.block.selectedMedia).toEqual(leaves(plan.block.layout!));
    expect(composePlan(posts, { media: "images" }).block.selectedMedia).toEqual(["1.1", "1.3"]);
    expect(composePlan(posts, { media: "none" }).block.kind).toBe("text");
  });

  test("resolves TikTok short links and corrects photo-post canonical URLs", async () => {
    for (const all of [[photo, photo], [video]]) {
      const provider = new AtmosphereProvider("tiktok", async () => Response.json({ status: { ...status, id: "123", url: "https://www.tiktok.com/@alice/video/123", media: { all } } }));
      const posts = await new SocialResolver({ tiktok: provider }).resolve(["https://www.tiktok.com/t/ABC/"]);
      expect(posts[0]!.canonicalUrl).toBe(`https://www.tiktok.com/@alice/${all[0]!.type === "photo" ? "photo" : "video"}/123`);
      expect(composePlan(posts).block.selectedMedia).toHaveLength(all.length);
    }
  });

  test("ignores an unsafe poster without losing the source video", async () => {
    const provider = new AtmosphereProvider("tiktok", async () => Response.json({ status: {
      ...status, id: "123", url: "https://www.tiktok.com/@alice/video/123",
      media: { all: [{ ...video, thumbnail_url: "file:///private/poster.jpg" }] },
    } }));
    const posts = await new SocialResolver({ tiktok: provider }).resolve(["https://www.tiktok.com/t/ABC/"]);
    expect(posts[0]!.media[0]!.url).toBe(video.url);
    expect(posts[0]!.media[0]!.posterUrl).toBeUndefined();
  });

  test("titles TikToks with display names and falls back to handles", () => {
    for (const [name, expected] of [["Gavin", "Gavin"], [" @Gavin ", "Gavin"], ["", "gavaghoul"], ["   ", "gavaghoul"], [undefined, "gavaghoul"]]) {
      const post = { provider: "tiktok" as const, id: "123", canonicalUrl: "https://www.tiktok.com/@gavaghoul/video/123", author: { handle: "gavaghoul", name }, text: "Caption", media: [] };
      expect(composePlan([post]).block.title).toBe(`TikTok by @${expected}`);
      expect(composePlan([{ ...post, provider: "instagram" }]).block.title).toBe("Post by @gavaghoul");
    }
  });

  test("captions omit markers only for attachments the block carries", () => {
    for (const provider of ["instagram", "tiktok"] as const) {
      const post = { provider, id: "1", canonicalUrl: "https://example.com", author: { handle: "alice" }, text: "Caption", media: [
        { ref: "1.1", kind: "image" as const, url: "https://example.com/a.jpg", alt: "" },
        { ref: "1.2", kind: "video" as const, url: "https://example.com/a.mp4", alt: "" },
      ] };
      expect(composePlan([post]).block.markdown).toBe("Caption");
      expect(composePlan([post], { media: "images" }).block.markdown).toBe("Caption\n\n*[video]*");
      expect(composePlan([post], { media: "none" }).block.markdown).toBe("Caption\n\n*[image, video]*");
    }
  });

  test("rejects unavailable, mismatched, or incomplete media instead of dropping items", async () => {
    for (const changes of [{ id: "wrong" }, { media: { photos: [photo] } }, { media: { all: [] } }, { media: { all: [photo, { ...video, url: undefined }] } }, { media: { all: [{ ...photo, url: "file:///secret" }] } }, { created_at: "invalid" }]) {
      const provider = new AtmosphereProvider("instagram", async () => Response.json({ status: { ...status, ...changes } }));
      await expect(provider.resolve(parseSource(status.url))).rejects.toThrow();
    }
    for (const code of [401, 404, 429, 503]) {
      const provider = new AtmosphereProvider("instagram", async () => new Response("Unavailable", { status: code }));
      await expect(provider.resolve(parseSource(status.url))).rejects.toThrow(String(code));
    }
    const provider = new AtmosphereProvider("instagram", async (_url, init) => { init?.signal?.throwIfAborted(); return Response.json({ status }); });
    await expect(provider.resolve(parseSource(status.url), AbortSignal.abort())).rejects.toThrow();
  });
});


test.each([
  ["https://instagram.com/reel/Ab_c-123/?utm_source=share", status.url, "Reel"],
  ["https://www.instagram.com/alice/reels/Ab_c-123/", status.url, "Reel"],
  [status.url, "https://www.instagram.com/reel/Ab_c-123/", "Reel"],
  [status.url, status.url, "Post"],
])("Instagram titles retain observed permalink type: %s → %s", async (input, returned, kind) => {
  const record = { ...status, url: returned, media: { all: [video] } };
  const provider = new AtmosphereProvider("instagram", async () => Response.json({ status: record }));
  const posts = await new SocialResolver({ instagram: provider }).resolve([input]);
  const plan = composePlan(posts);
  expect(plan.block.title).toBe(`${kind} by @alice`);
  expect(plan.sources[0]!.canonicalUrl).toBe(parseSource(returned).canonicalUrl);
  expect(plan.sources[0]!.text).toBe(status.text);
  expect(plan.sources[0]!.media[0]!.url).toBe(video.url);
  expect(composePlan(blockPlanSchema.parse(plan).sources).block.title).toBe(plan.block.title);
});

test("retained Instagram Reel URLs compose correctly while ordinary video posts stay Posts", () => {
  for (const route of ["reel", "reels", "p"]) {
    const post = { provider: "instagram" as const, id: status.id, canonicalUrl: `https://www.instagram.com/${route}/${status.id}/`, author: { handle: "alice" }, text: status.text, media: [] };
    expect(composePlan([post]).block.title).toBe(`${route === "p" ? "Post" : "Reel"} by @alice`);
  }
});

test("duplicate post and Reel aliases retain Reel evidence without changing source role or order", async () => {
  for (const [primary, extras] of [[[status.url, "https://instagram.com/reel/Ab_c-123/"], []],
    [[status.url], ["https://instagram.com/reels/Ab_c-123/"]],
    [["https://instagram.com/reel/Ab_c-123/"], [status.url]]] as [string[], string[]][]) {
    const calls: string[] = [];
    const provider = new AtmosphereProvider("instagram", async url => { calls.push(String(url)); return Response.json({ status }); });
    const resolved = await new SocialResolver({ instagram: provider }).resolveComposition(primary, extras);
    expect(calls).toHaveLength(1);
    expect(resolved.posts).toHaveLength(1);
    expect(resolved.posts[0]!.selection).toMatchObject({ role: "primary", declaredIndex: 1 });
    expect(resolved.posts[0]!.canonicalUrl).toBe(status.url);
    expect(composePlan(resolved.posts, resolved.policy).block.title).toBe("Reel by @alice");
  }
});
