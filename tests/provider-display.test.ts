import { expect, test } from "bun:test";
import { parseSource } from "../src/url.ts";
import { articleMarkdown } from "../src/providers/x-article.ts";

test("CLI source help uses the x.com display label", () => {
  for (const command of ["plan", "publish", "resolve", "thread"]) {
    const result = Bun.spawnSync([process.execPath, "src/cli.ts", command, "--help"], {
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" }, stdout: "pipe", stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    expect(result.stdout.toString()).toContain("x.com");
    expect(result.stdout.toString()).not.toMatch(/\bX\b/);
  }
});

test("the x.com display label preserves provider IDs and authored article writing", () => {
  expect(parseSource("https://x.com/example/status/123").provider).toBe("x");
  expect(articleMarkdown({ title: "An authored title", content: {
    blocks: [{ text: "Their original writing calls it X.", type: "unstyled" }], entityMap: [],
  } })).toContain("Their original writing calls it X.");
});
