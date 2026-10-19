import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createContext, runInContext } from "node:vm";
import { BlueskyProvider } from "../packages/core/providers/bluesky.ts";
import { SocialResolver } from "../src/providers/index.ts";
import { parseSource } from "../packages/core/url.ts";
import { composePlan } from "../packages/core/compose.ts";
import { captureRenderRecipe } from "../packages/core/render-recipe.ts";
import { selectedPostMediaPolicy } from "../src/cli-media.ts";
import { resolveCapture } from "../extension/src/core.ts";

const url = "https://bsky.app/profile/oxidist.bsky.social/post/3my7yohqedc2z";
const fixture = await Bun.file(new URL("fixtures/bluesky-oxidist-gallery.json", import.meta.url)).json();
function provider(value = fixture) { return new BlueskyProvider(undefined, (async () => Response.json(value)) as typeof fetch); }

test("the exact current public gallery produces five ordered primary media and a mosaic recipe", async () => {
  const resolved = await new SocialResolver({ bluesky: provider() }).resolveComposition([url], [], { media: "all", threadExpansion: "off" });
  const plan = composePlan(resolved.posts, selectedPostMediaPolicy(resolved.posts, resolved.policy));
  const expected = fixture.thread.post.embed.items;
  expect(plan.sources).toHaveLength(1); expect(plan.sources[0]!.quote).toBeUndefined();
  expect(plan.sources[0]!.atproto).toMatchObject({ uri: fixture.thread.post.uri, cid: fixture.thread.post.cid, record: fixture.thread.post.record });
  expect(plan.sources[0]!.media.map(asset => asset.url)).toEqual(expected.map((item: any) => item.fullsize));
  expect(plan.block.kind).toBe("link"); expect(plan.block.canonicalSource).toBe(url);
  expect(plan.block.selectedMedia).toEqual(["1.1", "1.2", "1.3", "1.4", "1.5"]);
  expect(plan.sources[0]!.media.every(asset => asset.width === 1024 && asset.height === 1536)).toBe(true);
  const recipe = captureRenderRecipe(plan, {});
  expect(recipe!.tiles.map(tile => tile.ref)).toEqual(plan.block.selectedMedia);
  expect(plan.block.markdown).toContain("more criterion posters for movies that deserve them");
  expect(composePlan(plan.sources, plan.policy)).toEqual(plan);
});

test("native/browser composition projects the same primary gallery", async () => {
  const plan = await resolveCapture({ primary: [url], extras: [], policy: { media: "all", threadExpansion: "off" } }, undefined,
    (async () => Response.json(fixture)) as typeof fetch);
  expect(plan.block.selectedMedia).toEqual(["1.1", "1.2", "1.3", "1.4", "1.5"]);
  expect(plan.sources[0]!.media.map(asset => asset.url)).toEqual(fixture.thread.post.embed.items.map((item: any) => item.fullsize));
});

test("malformed, incomplete, unsafe and unsupported galleries cannot silently become text", async () => {
  const cases = [
    (post: any) => post.embed.items.pop(),
    (post: any) => { post.embed.items = []; post.record.embed.items = []; },
    (post: any) => post.embed.items[0].$type = "app.bsky.embed.gallery#viewVideo",
    (post: any) => post.embed.items[0].fullsize = "javascript:bad",
    (post: any) => delete post.embed.items[0].fullsize,
    (post: any) => delete post.embed,
    (post: any) => delete post.cid,
    (post: any) => post.embed.$type = "app.bsky.embed.future#view",
  ];
  for (const alter of cases) {
    const value = structuredClone(fixture); alter(value.thread.post);
    await expect(provider(value).resolve(parseSource(url))).rejects.toThrow();
  }
});

test("a gallery inside a quoted record stays quote-only under CLI All", async () => {
  const quoted = fixture.thread.post;
  const outer = { ...quoted, uri: quoted.uri.replace("3my7yohqedc2z", "outer123"), cid: "outercid",
    record: { $type: "app.bsky.feed.post", text: "Only quoted images", createdAt: "2026-10-19T00:00:00Z" },
    embed: { $type: "app.bsky.embed.record#view", record: { ...quoted, $type: "app.bsky.embed.record#viewRecord", value: quoted.record,
      embeds: [quoted.embed], embed: undefined, record: undefined } } };
  const resolved = await new SocialResolver({ bluesky: provider({ thread: { post: outer } }) }).resolveComposition(
    [url.replace("3my7yohqedc2z", "outer123")], [], { media: "all", threadExpansion: "off" });
  const plan = composePlan(resolved.posts, selectedPostMediaPolicy(resolved.posts, resolved.policy));
  expect(plan.sources[0]!.media).toEqual([]); expect(plan.sources[0]!.quote!.media).toHaveLength(5);
  expect(plan.block.selectedMedia).toEqual([]); expect(plan.block.kind).toBe("text");
  const included = composePlan(resolved.posts, selectedPostMediaPolicy(resolved.posts, resolved.policy, true));
  expect(included.block.selectedMedia).toEqual(["1.1", "1.2", "1.3", "1.4", "1.5"]);
});

test("rebuilt JavaScriptCore bundle classifies share links and resolves the exact primary gallery", async () => {
  const bundle = await Bun.file(new URL("../ios/Sources/CaptureRuntime/Resources/capture-core.js", import.meta.url)).text();
  let finish!: (result: { value: string | null; error: string | null }) => void;
  const done = new Promise<{ value: string | null; error: string | null }>(resolve => { finish = resolve; });
  const context = createContext({ setTimeout, clearTimeout, nativeCancelHTTP: () => {},
    nativeSHA256: (text: string) => createHash("sha256").update(text).digest("hex"),
    nativeHTTP: (id: number, raw: string) => { const request = JSON.parse(raw);
      const share = "https://on.soundcloud.com/L0Z8FDzZWKyJQqIyHN", track = "https://soundcloud.com/rrthielnc/fxxlsgxld";
      let response;
      if (request.url === share) {
        expect(request.method).toBe("HEAD"); expect(request.redirect).toBe("manual");
        response = { status: 302, url: share, headers: { location: track }, body: "" };
      } else if (request.url === track) {
        response = { status: 200, url: track, headers: { "content-type": "text/html" }, body: `<script>window.__sc_hydration = ${JSON.stringify([
          { hydratable: "sound", data: { kind: "track", id: 2422119177, title: "Fixture track", permalink_url: track, sharing: "public", downloadable: false, user: { username: "Fixture" } } },
        ])};</script>` };
      } else {
        expect(request.url).toContain("getPostThread");
        response = { status: 200, url: request.url, headers: { "content-type": "application/json" }, body: JSON.stringify(fixture) };
      }
      queueMicrotask(() => context.captureHTTPComplete(id, JSON.stringify(response)));
    }, nativeResolveComplete: (_id: string, value: string | null, error: string | null) => finish({ value, error }) });
  runInContext(bundle, context);
  expect(JSON.parse(context.captureSource("https://on.soundcloud.com/L0Z8FDzZWKyJQqIyHN")).kind).toBe("social");
  context.captureResolve("gallery", JSON.stringify([url]), JSON.stringify({ media: "all", threadExpansion: "off" }));
  const result = await done; expect(result.error).toBeNull();
  expect(JSON.parse(result.value!).plan.block.selectedMedia).toEqual(["1.1", "1.2", "1.3", "1.4", "1.5"]);
  const shareDone = new Promise<{ value: string | null; error: string | null }>(resolve => { finish = resolve; });
  context.captureResolve("share", JSON.stringify(["https://on.soundcloud.com/L0Z8FDzZWKyJQqIyHN"]), JSON.stringify({ media: "none", threadExpansion: "off" }));
  const shared = await shareDone; expect(shared.error).toBeNull();
  expect(JSON.parse(shared.value!).plan.block.canonicalSource).toBe("https://soundcloud.com/rrthielnc/fxxlsgxld");
});
