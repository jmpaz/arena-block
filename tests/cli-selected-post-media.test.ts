import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectedPostMediaPolicy } from "../src/cli-media.ts";
import { composePlan } from "../src/compose.ts";
import { assignMediaRefs } from "../packages/core/providers/provider.ts";
import { compositionPolicySchema, type MediaAsset, type ResolvedPost } from "../src/types.ts";

const first = "https://x.com/selected/status/101", second = "https://x.com/selected/status/102";
const quoted = "https://x.com/other/status/201", extra = "https://x.com/extra/status/301";
const reported = "https://x.com/tracewoodgrains/status/2111482639052116051";
function invoke(...args: string[]) {
  const result = Bun.spawnSync([process.execPath, "--preload", `${import.meta.dir}/fixtures/selected-post-media-cli.ts`, "src/cli.ts", "plan", ...args, "--json"], {
    env: { ...process.env, ARENA_BLOCK_ACCESS_TOKEN: "", ARENA_BLOCK_ENDPOINT: "http://127.0.0.1:1" }, stdout: "pipe", stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return JSON.parse(result.stdout.toString());
}

test.each(["all", "images", "video", "audio"])("CLI %s excludes media belonging only to nested quotes and preserves writing", mode => {
  const plan = invoke(first, "--media", mode);
  expect(plan.block.selectedMedia).toEqual(mode === "all" ? ["1.1", "1.2"] : mode === "images" ? ["1.1"] : mode === "video" ? ["1.2"] : []);
  expect(plan.sources[0].quote.media[0].ref).toBe("1.3");
  expect(plan.sources[0].quote.quote.media[0].ref).toBe("1.4");
  for (const text of ["First selected writing.", "Second selected writing.", "Quote-only writing."]) expect(plan.block.markdown).toContain(text);
  expect(composePlan(plan.sources, plan.policy)).toEqual(plan);
});

test("multiple selected posts retain all of their media even when one also occurs as a quote", () => {
  const plan = invoke(first, second, "--media", "all");
  expect(plan.sources.map((post: ResolvedPost) => post.selection)).toEqual([
    { role: "primary", origin: "explicit", declaredIndex: 1 }, { role: "primary", origin: "explicit", declaredIndex: 2 },
  ]);
  expect(plan.block.selectedMedia).toEqual(["1.1", "1.2", "2.1"]);
  expect(plan.sources[0].quote.id).toBe(plan.sources[1].id);
  expect(plan.block.selectedMedia).not.toContain("1.3");
  expect(invoke(first, quoted, "--media", "video").block.selectedMedia).toEqual(["1.2", "2.1"]);
});

test("thread traversal contributes each selected member's own media, including a member also quoted", () => {
  const plan = invoke(second, "-t", "--media", "all");
  expect(plan.sources.map((post: ResolvedPost) => [post.id, post.selection?.role, post.selection?.origin])).toEqual([
    ["101", "primary", "expanded"], ["102", "primary", "explicit"],
  ]);
  expect(plan.block.selectedMedia).toEqual(["1.1", "1.2", "2.1"]);
  expect(invoke(second, "-t", "--media", "images").block.selectedMedia).toEqual(["1.1", "2.1"]);
  expect(invoke(second, "-t", "--media", "video").block.selectedMedia).toEqual(["1.2"]);
  expect(plan.block.markdown).toContain("Second selected writing.");
  expect(plan.block.markdown).toContain("Quote-only writing.");
});

test("explicit media extras contribute their own attachments without their quote-only media or writing", () => {
  const plan = invoke(second, "-t", "--extra", extra, "--media", "all");
  expect(plan.sources[2].selection.role).toBe("extra");
  expect(plan.policy.mediaOnlyPosts).toEqual([3]);
  expect(plan.block.selectedMedia).toEqual(["1.1", "1.2", "2.1", "3.1"]);
  expect(plan.block.markdown).not.toContain("Extra writing stays excluded.");
});

test("exact quoted refs and deliberately named order, frame and soundtrack choices remain available", () => {
  expect(invoke(first, "--media", "1.3,1.4").block.selectedMedia).toEqual(["1.3", "1.4"]);
  expect(invoke(first, "--media", "all", "--media-order", "1.3,1.2,1.1").block.selectedMedia).toEqual(["1.3", "1.2", "1.1"]);
  const frame = invoke(first, "--media", "all", "--frame", "1.4");
  expect(frame.block.selectedMedia).toEqual(["1.1", "1.2", "1.4"]);
  expect(frame.block.frameMedia.map((asset: MediaAsset) => asset.ref)).toEqual(["1.4"]);
  const audio = invoke(first, "--media", "all", "--audio", "1.4");
  expect(audio.block.selectedMedia).toEqual(["1.1", "1.2", "1.4"]);
  expect(audio.policy.audio).toBe("1.4");
});

test("the reported tracewoodgrains post keeps quoted TheDonAyo video off under All and Video", () => {
  for (const mode of ["all", "video", "images", "audio"]) {
    const plan = invoke(reported, "--media", mode);
    expect(plan.sources[0].media).toEqual([]);
    expect(plan.sources[0].quote.canonicalUrl).toBe("https://x.com/TheDonAyo/status/2110461702936695263");
    expect(plan.sources[0].quote.media[0]).toMatchObject({ ref: "1.1", kind: "video", durationSeconds: 65.299 });
    expect(plan.block.selectedMedia).toEqual([]);
    expect(plan.block.kind).toBe("text");
    expect(plan.block.markdown).toContain("i used AI to reverse engineer the block blaster mobile app.");
    expect(plan.block.markdown).toContain("$100 million annually in revenue. Hellish.");
  }
  expect(invoke(reported, "--media", "1.1").block.selectedMedia).toEqual(["1.1"]);
});

test("audio type selection follows selected-post roles, and other explicit or saved policies are untouched", () => {
  const asset = (id: string): MediaAsset => ({ ref: "0.0", kind: "audio", url: `https://audio.example/${id}.mp3`, alt: "", acquisition: "substack-public-original" });
  const post = (id: string, media: MediaAsset[], quote?: ResolvedPost): ResolvedPost => ({ provider: "substack", id, canonicalUrl: `https://substack.com/@author/note/c-${id}`, author: { handle: "author" }, text: id, media, ...(quote ? { quote } : {}) });
  const root = assignMediaRefs(post("100", [asset("100")], post("200", [asset("200")])), 0);
  const policy = compositionPolicySchema.parse({ media: "audio" }), frozen = structuredClone(policy);
  expect(selectedPostMediaPolicy([root], policy).selectedMedia).toEqual(["1.1"]);
  expect(selectedPostMediaPolicy([assignMediaRefs(root.quote!, 0)], policy).selectedMedia).toEqual(["1.1"]);
  expect(policy).toEqual(frozen);
  for (const media of ["auto", "none", "selected"] as const) {
    const existing = compositionPolicySchema.parse({ media, ...(media === "selected" ? { selectedMedia: ["1.2"] } : {}) });
    expect(selectedPostMediaPolicy([root], existing)).toBe(existing);
  }
});

const replayDirectory = await mkdtemp(join(tmpdir(), "arena-selected-media-replay-"));
afterAll(() => rm(replayDirectory, { recursive: true, force: true }));
test("saved Auto and All plans replay their frozen quoted-media selections without source or daemon requests", async () => {
  const queued = await Bun.file(`${import.meta.dir}/fixtures/quoted-image-v1-queued-plan.json`).json();
  const legacyAll = composePlan(queued.sources, { ...queued.policy, media: "all" });
  const config = join(replayDirectory, "config.json");
  await Bun.write(config, JSON.stringify({ provenance: { local: false, remoteSnapshot: "none" } }));
  for (const saved of [queued, legacyAll]) {
    const path = join(replayDirectory, `${saved.policy.media}.json`), ledger = join(replayDirectory, `${saved.policy.media}-ledger.json`);
    const serialized = JSON.stringify(saved);
    await Bun.write(path, serialized);
    const result = Bun.spawnSync([process.execPath, "--preload", `${import.meta.dir}/fixtures/selected-post-media-cli.ts`, "src/cli.ts",
      "publish", "--plan", path, "--dry-run", "--config", config, "--to", "fixture-inbox"], {
      env: { ...process.env, ARENA_BLOCK_ACCESS_TOKEN: "", ARENA_SELECTION_LEDGER: ledger }, stdout: "pipe", stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(JSON.parse(result.stdout.toString()).snapshot.plan).toEqual(saved);
    expect((await Bun.file(ledger).json()).requests).toEqual([]);
    expect(await Bun.file(path).text()).toBe(serialized);
  }
});
