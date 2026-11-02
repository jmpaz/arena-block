import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { composePlan, reviseMosaicLayout } from "../src/compose.ts";

const directory = await mkdtemp(join(tmpdir(), "arena-mosaic-cli-"));
const original = composePlan([{ provider: "x", id: "1", canonicalUrl: "https://x.com/fixture/status/1", author: { handle: "fixture" }, text: "Retained writing",
  media: [(0), (1), (2)].map(i => ({ ref: `1.${i + 1}`, kind: "image" as const, width: [946, 1105, 1005][i]!, height: [2048, 814, 909][i]!, url: `https://media.example.test/${i}.jpg`, alt: "" })) }], { media: "all" });
const planPath = join(directory, "plan.json"), preload = join(directory, "preload.ts"), config = join(directory, "config.json");
await Bun.write(planPath, JSON.stringify(original));
await Bun.write(config, JSON.stringify({ provenance: { local: false, remoteSnapshot: "none" } }));
await Bun.write(preload, `
import { mock } from "bun:test";
const { SocialResolver } = await import(${JSON.stringify(new URL("../src/providers/index.ts", import.meta.url).href)});
SocialResolver.prototype.resolveComposition = async () => { throw new Error("Unexpected source acquisition"); };
mock.module(${JSON.stringify(new URL("../src/render.ts", import.meta.url).pathname)}, () => ({ renderPlan: async plan => {
  const path = process.env.ARENA_MOSAIC_TEST_RENDER;
  await Bun.write(path, JSON.stringify(plan)); return { path, mimeType: "image/jpeg", size: 1 };
} }));
globalThis.fetch = async () => { throw new Error("Unexpected network request"); };
`);
afterAll(() => rm(directory, { recursive: true, force: true }));
async function cli(args: string[]) {
  const child = Bun.spawn([process.execPath, "--preload", preload, "src/cli.ts", ...args], {
    cwd: join(import.meta.dir, ".."), env: { ...process.env, ARENA_BLOCK_ACCESS_TOKEN: "", ARENA_MOSAIC_TEST_RENDER: join(directory, "render.json") }, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
}

test("CLI layout alternatives derive render and dry-run plans without source reads or rewriting the retained plan", async () => {
  for (const mode of ["balanced", "source-order", "compact"] as const) {
    const output = join(directory, `${mode}.json`);
    const rendered = await cli(["render", "--plan", planPath, "--mosaic-layout", mode, "-o", output]);
    expect(rendered).toMatchObject({ code: 0 }); expect(await Bun.file(output).json()).toEqual(reviseMosaicLayout(original, mode));
    const published = await cli(["--mosaic-layout", mode, "publish", "--plan", planPath, "--dry-run", "--config", config, "--to", "fixture-inbox"]);
    expect(published.code).toBe(0); expect(published.stderr).toBe("");
    expect(JSON.parse(published.stdout).snapshot.plan).toEqual(reviseMosaicLayout(original, mode));
  }
  const retained = await cli(["publish", "--plan", planPath, "--dry-run", "--config", config, "--to", "fixture-inbox"]);
  expect(retained.code).toBe(0); expect(JSON.parse(retained.stdout).snapshot.plan).toEqual(original);
  const override = await cli(["--mosaic-layout", "compact", "publish", "--plan", planPath, "--mosaic-layout", "source-order", "--dry-run", "--config", config, "--to", "fixture-inbox"]);
  expect(override.code).toBe(0); expect(JSON.parse(override.stdout).snapshot.plan.policy.mosaicLayout).toBe("source-order");
  expect(await Bun.file(planPath).json()).toEqual(original);
  const invalid = await cli(["render", "--plan", planPath, "--mosaic-layout", "model", "-o", join(directory, "invalid")]);
  expect(invalid.code).not.toBe(0); expect(invalid.stderr).toContain("--mosaic-layout");
});
