import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
const highlight = "https://example.com/article#:~:text=First%20words,last%20words.";
async function run(args: string[]) {
  const child = Bun.spawn([Bun.which("bun")!, "--preload", join(import.meta.dir, "fixtures/excerpt-cli.ts"), "src/cli.ts", ...args], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
  const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { out, error, code };
}

test("CLI automatically plans a complete fragment excerpt and preserves the source URL", async () => {
  const result = await run(["plan", highlight, "--json"]);
  expect(result.code).toBe(0); expect(result.error).toBe("");
  expect(JSON.parse(result.out).block).toMatchObject({ kind: "text", title: "Excerpt from Page title", canonicalSource: highlight, markdown: "First words, a **complete** middle and last words." });
});

test("CLI accepts manual source/text and exact UTF-8 files without fetching", async () => {
  const text = "- **Preserve** a list\r\n\n> 日本語 café 👋\n";
  const manual = await run(["plan", "--source-url", "https://gwern.net/example#section", "--excerpt", text, "--title", "Edited", "--json"]);
  expect(manual.code).toBe(0); expect(JSON.parse(manual.out).block.markdown).toBe(text);
  const root = await mkdtemp(join(tmpdir(), "excerpt-cli-"));
  try {
    const file = join(root, "selection.txt"); await Bun.write(file, text);
    const result = await run(["plan", "https://gwern.net/example#section", "--excerpt-file", file, "--json"]);
    expect(result.code).toBe(0); expect(JSON.parse(result.out).block.excerpt).toMatchObject({ kind: "manual", text });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("CLI inherits excerpt flags before subcommands and supports source overrides", async () => {
  const result = await run(["--excerpt", "Exact text.", "--title", "Edited", "plan", "--source-url", "https://example.com/source", "--json"]);
  expect(result.code).toBe(0); expect(JSON.parse(result.out).block).toMatchObject({ markdown: "Exact text.", title: "Edited", canonicalSource: "https://example.com/source" });
  const override = await run(["plan", highlight, "--source-url", "https://example.com/citation", "--json"]);
  expect(override.code).toBe(0); expect(JSON.parse(override.out).block.canonicalSource).toBe("https://example.com/citation");
});

test("CLI refuses ignored inputs, unresolved ranges and incomplete manual input", async () => {
  for (const args of [["plan", highlight, "--excerpt", "x", "--excerpt-file", "missing"], ["plan", "--excerpt", "x"],
    ["plan", highlight, "--excerpt-format", "plain"], ["plan", highlight, "--media", "all"],
    ["publish", "--plan", "missing", "--excerpt", "ignored"], ["plan", highlight.replace("last%20words.", "last%20words).")],
    ["plan", highlight, "https://example.com/other"]]) {
    const result = await run(args); expect(result.code).toBe(1); expect(result.out).toBe(""); expect(result.error).not.toContain("Unexpected request");
  }
});

test("CLI publish dry-run preserves manual provenance and makes no save request", async () => {
  const root = await mkdtemp(join(tmpdir(), "excerpt-dry-run-"));
  try {
    const config = join(root, "config.json"); await Bun.write(config, JSON.stringify({ defaultDestinations: ["fixture-channel"] }));
    const result = await run(["publish", "--source-url", "https://gwern.net/example#section", "--excerpt", "Exact supplied text.", "--config", config, "--dry-run"]);
    expect(result.code).toBe(0); const intent = JSON.parse(result.out);
    expect(intent.snapshot.plan.block).toMatchObject({ kind: "text", markdown: "Exact supplied text.", excerpt: { kind: "manual" } });
    expect(intent.snapshot.routing.destinations).toEqual(["fixture-channel"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
