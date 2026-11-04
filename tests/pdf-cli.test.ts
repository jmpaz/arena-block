import { expect, test } from "bun:test";
import { join } from "node:path";

async function run(args: string[]) {
  const process = Bun.spawn([Bun.which("bun")!, "--preload", join(import.meta.dir, "fixtures/pdf-link-cli.ts"), "src/cli.ts", ...args],
    { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
  const [out, error, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  return { out, error, code };
}

test("CLI plans an extensionless PDF with a separate source and resolved title", async () => {
  const result = await run(["plan", "https://example.com/content", "--source-url", "https://example.com/article", "--json"]);
  expect(result.error).toBe(""); expect(result.code).toBe(0);
  expect(JSON.parse(result.out).block).toMatchObject({ kind: "url", contentType: "application/pdf", contentUrl: "https://example.com/content",
    canonicalSource: "https://example.com/article", title: "Resolved paper title" });
});

test("CLI preserves explicit PDF titles and rejects invalid source URLs before requests", async () => {
  const edited = await run(["plan", "https://example.com/content", "--title", "My title", "--json"]);
  expect(edited.code).toBe(0); expect(JSON.parse(edited.out).block.title).toBe("My title");
  const invalid = await run(["plan", "https://example.com/content", "--source-url", "file:///tmp/secret", "--json"]);
  expect(invalid.code).toBe(1); expect(invalid.error).toContain("source URL");
  expect(invalid.error).not.toContain("Unexpected request");
});
