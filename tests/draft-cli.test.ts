import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composePlan } from "../src/compose.ts";

const directory = await mkdtemp(join(tmpdir(), "arena-draft-cli-"));
afterAll(() => rm(directory, { recursive: true, force: true }));
const plan = composePlan([{ provider: "x", id: "1", canonicalUrl: "https://x.com/example/status/1",
  author: { handle: "example" }, text: "Base text", media: [{ ref: "1.1", kind: "image", url: "https://example.test/image.png", width: 20, height: 10, alt: "fixture" }] }], { media: "all" });
const planPath = join(directory, "plan.json");
await Bun.write(planPath, JSON.stringify(plan));

async function cli(args: string[], mode = "capture") {
  const id = crypto.randomUUID(), preload = join(directory, `${id}.ts`), ledger = join(directory, `${id}.json`);
  await Bun.write(ledger, "[]");
  await Bun.write(preload, `const calls=[]; globalThis.fetch = async (input, init) => {
    const url=String(input);calls.push({url,method:init?.method ?? "GET",redirect:init?.redirect,credentials:init?.credentials});
    await Bun.write(${JSON.stringify(ledger)}, JSON.stringify(calls));
    if (${JSON.stringify(mode)} === "cancel") {
      const keepAlive=setInterval(() => {}, 100);
      setTimeout(() => process.kill(process.pid, "SIGINT"), 10);
      return new Promise((resolve,reject) => init.signal.addEventListener("abort", () => {clearInterval(keepAlive);reject(init.signal.reason);}, {once:true}));
    }
    if(url !== "https://api.fxtwitter.com/example/status/1") throw new Error("Unexpected network request");
    return Response.json({tweet:{id:"1",author:{screen_name:"example",name:"Example"},text:"Captured writing",created_at:"Sun Oct 04 15:21:02 +0000 2026",media:{photos:[{url:"https://example.test/image.png",width:20,height:10}]}}});
  };`);
  const child = Bun.spawn([Bun.which("bun")!, "--preload", preload, "src/cli.ts", ...args], {
    env: { ...process.env, ARENA_BLOCK_ACCESS_TOKEN: "", ARENA_BLOCK_ENDPOINT: "https://fixture.invalid" }, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code, calls: await Bun.file(ledger).json() };
}

test("thread CLI writes a curated draft with original evidence and no publishing or media requests", async () => {
  const outputDir = join(directory, "drafts");
  const result = await cli(["thread", "https://x.com/example/status/1", "--output-dir", outputDir, "--media", "none", "--select", "1"]);
  expect(result.code).toBe(0); expect(result.stderr).toBe("");
  const receipt = JSON.parse(result.stdout);
  expect(receipt.coverage.complete).toBe(false); expect(receipt.selectedPostIds).toEqual(["1"]);
  expect(result.calls).toEqual([{ url: "https://api.fxtwitter.com/example/status/1", method: "GET", redirect: "error", credentials: "omit" }]);
  const capture = await Bun.file(join(receipt.directory, "capture.json")).json();
  expect(capture.originals).toHaveLength(1); expect(capture.posts[0].media).toHaveLength(1);
  const markdown = await Bun.file(join(receipt.directory, "thread.md")).text();
  expect(markdown).toContain("Captured writing"); expect(markdown).not.toContain("example.test/image.png");
  expect((await readdir(receipt.directory)).sort()).toEqual(["capture.json", "coverage.txt", "manifest.json", "thread.html", "thread.md"]);
});

test("CLI rejects invalid scope and unsupported image-description claims before source reads", async () => {
  const descriptionPath = join(directory, "invalid-descriptions.json");
  await Bun.write(descriptionPath, JSON.stringify({ "https://example.test/image.png": { text: "unverified", basis: "pixels" } }));
  for (const args of [["--scope", "whole"], ["--descriptions", descriptionPath]]) {
    const result = await cli(["thread", "https://x.com/example/status/1", "--output-dir", join(directory, "invalid"), ...args]);
    expect(result.code).toBe(1); expect(result.calls).toEqual([]); expect(result.stdout).toBe("");
  }
});

test("SIGINT cancels slow thread capture with no completed draft", async () => {
  const outputDir = join(directory, "cancelled-thread");
  const result = await cli(["thread", "https://x.com/example/status/1", "--output-dir", outputDir], "cancel");
  expect(result.code).toBe(1); expect(result.stderr).toContain("Draft capture cancelled"); expect(result.stdout).toBe("");
  expect(result.calls).toHaveLength(1); expect(await Bun.file(join(outputDir, "thread.md")).exists()).toBe(false);
});

test("SIGINT cancels cached-plan preview acquisition and removes owned staging", async () => {
  const outputDir = join(directory, "cancelled-preview");
  const result = await cli(["render", "--plan", planPath, "--layout", "reading", "--canvas", "256x256", "--output-dir", outputDir], "cancel");
  expect(result.code).toBe(1); expect(result.stderr).toContain("Preview cancelled"); expect(result.stdout).toBe("");
  expect(result.calls).toEqual([{ url: "https://example.test/image.png", method: "GET", redirect: "error", credentials: "omit" }]);
  const files = await readdir(outputDir).catch(error => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  expect(files).toEqual([]);
});

test("cached plans and invalid layout options avoid unnecessary source resolution", async () => {
  const result = await cli(["render", "https://x.com/example/status/1", "--layout", "reading", "--canvas", "invalid", "--output-dir", directory]);
  expect(result.code).toBe(1); expect(result.stderr).toContain("WIDTHxHEIGHT"); expect(result.calls).toEqual([]);
  const conflict = await cli(["render", "--plan", planPath, "https://x.com/example/status/1", "-o", join(directory, "image.jpg")]);
  expect(conflict.code).toBe(1); expect(conflict.stderr).toContain("--plan cannot accompany"); expect(conflict.calls).toEqual([]);
});
