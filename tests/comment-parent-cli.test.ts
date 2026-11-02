import { expect, test } from "bun:test";
import { join } from "node:path";
function invoke(args: string[]) {
  const child = Bun.spawnSync([Bun.which("bun")!, "--preload", join(import.meta.dir, "fixtures/comment-parent-cli.ts"), "src/cli.ts", ...args], {
    cwd: join(import.meta.dir, ".."), env: { ...process.env, ARENA_BLOCK_ACCESS_TOKEN: "" }, stdout: "pipe", stderr: "pipe" });
  return { code: child.exitCode, out: child.stdout.toString(), error: child.stderr.toString() };
}
test("CLI depth and style work before or after the plan command without saving", () => {
  const source = "https://news.ycombinator.com/item?id=4";
  for (const args of [["--parent-depth", "2", "--parent-style", "flat", "plan", source, "--json"], ["plan", source, "--parent-depth", "2", "--parent-style", "flat", "--json"]]) {
    const result = invoke(args); expect(result.code).toBe(0);
    const plan = JSON.parse(result.out);
    expect(plan.block.markdown).toBe("`user2`\nBody 2\n\n---\n\n`user3`\nBody 3\n\n---\n\n`user4`\nBody 4");
    expect(plan.block.canonicalSource).toBe(source);
  }
  expect(JSON.parse(invoke(["plan", source, "--parent-depth", "0", "--json"]).out).block.markdown).toBe("Body 4");
  const nested = invoke(["plan", source, "--parent-depth", "full", "--parent-style", "quote", "--json"]);
  expect(nested.code).toBe(0); expect(JSON.parse(nested.out).block.markdown).toContain("> > `@user2`");
});
test("CLI rejects invalid parent options before any source read", () => {
  for (const option of [["--parent-depth", "9"], ["--parent-style", "replies"]]) {
    const result = invoke(["plan", "https://news.ycombinator.com/item?id=4", ...option, "--json"]);
    expect(result.code).not.toBe(0); expect(result.error).not.toContain("Unexpected source request");
  }
});
