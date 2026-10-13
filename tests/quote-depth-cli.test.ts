import { expect, test } from "bun:test";
import { join } from "node:path";

function invoke(...args: string[]) {
  const child = Bun.spawnSync([Bun.which("bun")!, "--preload", join(import.meta.dir, "fixtures/quote-depth-cli.ts"), "src/cli.ts", "plan", ...args, "--json"], {
    cwd: join(import.meta.dir, ".."), env: { ...process.env, ARENA_BLOCK_ACCESS_TOKEN: "" }, stdout: "pipe", stderr: "pipe",
  });
  return { code: child.exitCode, out: new TextDecoder().decode(child.stdout), error: new TextDecoder().decode(child.stderr) };
}

test("CLI exposes default two, bounded full, literal/editable dates and zero without publishing", () => {
  const source = "https://x.com/author100/status/100";
  const normal = invoke(source);
  expect(normal.code).toBe(0);
  const defaultPlan = JSON.parse(normal.out);
  expect(defaultPlan.block.markdown).toContain("> > `@author98` (Mar 18, 2026)");
  expect(defaultPlan.block.markdown).not.toContain("Exact source 97");
  const full = invoke(source, "--quote-depth", "full", "--quote-dates", "source");
  expect(full.code).toBe(0);
  const plan = JSON.parse(full.out);
  expect(plan.block.markdown).toContain("> > > `@author97` (Wed Mar 18 12:00:00 +0000 2026)");
  expect(plan.block.quoteCoverage[0]).toMatchObject({ availableDepth: 3, renderedDepth: 3, requestedDepth: "full", truncated: false });
  const zero = invoke(source, "--quote-depth", "0");
  expect(zero.code).toBe(0); expect(JSON.parse(zero.out).block.markdown).toBe("Exact source 100.\n\n*[image]*");
  const none = invoke(source, "--quote-dates", "none");
  expect(none.code).toBe(0); expect(JSON.parse(none.out).block.markdown).not.toContain("(Mar 18, 2026)");
  const extra = invoke(source, "--extra", "https://x.com/author97/status/97", "--media-order", "2.1,1.1", "--quote-depth", "full");
  expect(extra.code).toBe(0); expect(JSON.parse(extra.out).block.selectedMedia).toEqual(["2.1", "1.1"]);
});

test("CLI rejects quote policy outside its declared bounds before reading a source", () => {
  for (const args of [["--quote-depth", "9"], ["--quote-depth", "unbounded"], ["--quote-dates", "capture"]]) {
    const result = invoke("https://x.com/author/status/999", ...args);
    expect(result.code).not.toBe(0);
    expect(result.error).not.toContain("Unexpected source request");
    expect(result.error).toContain(args[0] === "--quote-depth" ? "quoteDepth" : "quoteDates");
  }
});
