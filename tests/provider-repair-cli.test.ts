import { afterAll, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureRenderRecipe } from "../packages/core/render-recipe.ts";

const directory = await mkdtemp(join(tmpdir(), "arena-provider-repair-"));
const preload = join(directory, "source-fixture.ts"), binary = join(directory, "yt-dlp");
const share = "https://on.soundcloud.com/L0Z8FDzZWKyJQqIyHN", track = "https://soundcloud.com/rrthielnc/fxxlsgxld";
const gallery = "https://bsky.app/profile/oxidist.bsky.social/post/3my7yohqedc2z";
const story = "https://lobste.rs/s/ggpwfi/it_s_enough_vibecoding_tag_crossed_from";
const galleryFixture = join(import.meta.dir, "fixtures/bluesky-oxidist-gallery.json");
const storyFixture = join(import.meta.dir, "fixtures/lobsters-ggpwfi-story.json");
await Bun.write(preload, `globalThis.fetch = async (input, init) => {
  const url = String(input), calls = await Bun.file(process.env.ARENA_REPAIR_CALLS).json();
  calls.push({url,method:init?.method??"GET"}); await Bun.write(process.env.ARENA_REPAIR_CALLS,JSON.stringify(calls));
  if(url===${JSON.stringify(share)}){if(init?.method!=="HEAD"||init.redirect!=="manual")throw new Error("Unchecked share request");return new Response(null,{status:302,headers:{location:${JSON.stringify(track)}}});}
  if(url.startsWith("https://public.api.bsky.app/")&&url.includes("getPostThread"))return Response.json(await Bun.file(${JSON.stringify(galleryFixture)}).json());
  if(url==="https://lobste.rs/s/ggpwfi.json")return Response.json(await Bun.file(${JSON.stringify(storyFixture)}).json());
  throw new Error("Forbidden unexpected source or daemon request: "+url);
};`);
await Bun.write(binary, `#!${process.execPath}
const formats=process.env.ARENA_REPAIR_ORIGINAL==="true"?[{format_id:"download",ext:"wav",vcodec:"none",url:"https://media.invalid/original.wav"}]:[];
await Bun.write(process.env.ARENA_REPAIR_METADATA,JSON.stringify(process.argv.slice(2)));
process.stdout.write(JSON.stringify({id:"2422119177",title:"Fixture track",webpage_url:${JSON.stringify(track)},uploader:"Fixture artist",description:"Authored source text",availability:"public",formats}));`);
await chmod(binary, 0o700);
afterAll(() => rm(directory, { recursive: true, force: true }));

async function cli(args: string[], original = false) {
  const id = crypto.randomUUID(), ledger = join(directory, id + "-calls.json"), metadata = join(directory, id + "-metadata.json");
  await Bun.write(ledger, "[]");
  const child = Bun.spawn([process.execPath, "--preload", preload, "src/cli.ts", ...args], {
    cwd: join(import.meta.dir, ".."), env: { ...process.env, HOME: directory, PATH: directory + ":" + process.env.PATH,
      ARENA_BLOCK_ACCESS_TOKEN: "", ARENA_BLOCK_ENDPOINT: "https://daemon-must-not-be-used.invalid", ARENA_BLOCK_CONFIG: "",
      ARENA_REPAIR_CALLS: ledger, ARENA_REPAIR_METADATA: metadata, ARENA_REPAIR_ORIGINAL: String(original) }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code, calls: await Bun.file(ledger).json(), metadata: await Bun.file(metadata).exists() ? await Bun.file(metadata).json() : undefined };
}

test("publish All refuses unavailable SoundCloud audio before contacting the receiver", async () => {
  const result = await cli(["publish", share, "--media", "all", "--to", "https://www.are.na/fixture/channel"]);
  expect(result.code).toBe(1); expect(result.stdout).toBe(""); expect(result.stderr).toContain("No supported full SoundCloud audio");
  expect(result.calls).toEqual([{ url: share, method: "HEAD" }]);
  expect(result.metadata.at(-1)).toBe(track); expect(result.metadata).toContain("--simulate");
});

test("CLI parses deliberate source-link and available-audio choices after the same share redirect", async () => {
  const link = await cli(["plan", share, "--media", "none", "--json"]);
  expect(link.code, link.stderr).toBe(0); expect(JSON.parse(link.stdout).block).toMatchObject({ kind: "url", canonicalSource: track });
  const audio = await cli(["plan", share, "--media", "all", "--json"], true);
  expect(audio.code, audio.stderr).toBe(0); expect(JSON.parse(audio.stdout).block).toMatchObject({ kind: "audio", canonicalSource: track, selectedMedia: ["1.1"] });
  expect(audio.calls).toEqual([{ url: share, method: "HEAD" }]);
});

test("CLI All preserves five gallery images and composes their ordered visual recipe", async () => {
  const result = await cli(["plan", gallery, "--media", "all", "--json"]);
  expect(result.code, result.stderr).toBe(0);
  const plan = JSON.parse(result.stdout);
  expect(plan.sources).toHaveLength(1); expect(plan.block.selectedMedia).toEqual(["1.1", "1.2", "1.3", "1.4", "1.5"]);
  expect(captureRenderRecipe(plan)!.tiles.map(tile => tile.ref)).toEqual(plan.block.selectedMedia);
  expect(result.calls).toHaveLength(1); expect(result.calls[0].url).toContain("getPostThread");
});

test("CLI Lobsters story capture includes only the authored root even with -t", async () => {
  const result = await cli(["plan", story, "--media", "all", "-t", "--json"]);
  expect(result.code, result.stderr).toBe(0);
  const plan = JSON.parse(result.stdout);
  expect(plan.sources).toHaveLength(1); expect(plan.sources[0].author.handle).toBe("viraptor");
  expect(plan.block.canonicalSource).toBe("https://lobste.rs/s/ggpwfi");
  expect(plan.block.markdown).toContain("Please split it or kill it.");
  expect(plan.block.markdown).not.toContain("hyperpape");
  expect(result.calls).toEqual([{ url: "https://lobste.rs/s/ggpwfi.json", method: "GET" }]);
});
