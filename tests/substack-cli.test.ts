import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const capture = { schema: "arena-block/substack-browser-capture", version: 1,
  sourceUrl: "https://substack.com/@writer/note/c-1", observedAt: "2026-10-15T12:00:00Z", method: "browser-dom",
  note: { url: "https://substack.com/@writer/note/c-1", author: { handle: "writer", name: "Writer", profileUrl: "https://substack.com/@writer" },
    body: { status: "complete", html: "<p>Whole public prose.</p>" }, links: [] } };
async function cli(args: string[]) {
  const child = Bun.spawn([process.execPath, "run", "src/cli.ts", ...args], { cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" });
  const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { out, err, exit };
}
test("CLI imports a source-free capture, resolves an alias and rejects conflicting source arguments", async () => {
  const dir = await mkdtemp(join(tmpdir(), "arena-substack-cli-"));
  try {
    const path = join(dir, "capture.json"); await writeFile(path, JSON.stringify(capture));
    const planned = await cli(["plan", "--substack-capture", path, "--media", "none", "--json"]);
    expect(planned.exit).toBe(0);
    const plan = JSON.parse(planned.out);
    expect(plan.sources[0].substackCapture.note.body.html).toBe(capture.note.body.html);
    expect(plan.block.canonicalSource).toBe(capture.sourceUrl);
    expect(plan.block.kind).toBe("text");
    const resolved = await cli(["resolve", "https://substack.com/note/c-1?utm_source=test", "--substack-capture", path]);
    expect(resolved.exit).toBe(0); expect(JSON.parse(resolved.out)[0].canonicalUrl).toBe(capture.sourceUrl);
    const mismatch = await cli(["plan", "https://substack.com/note/c-2", "--substack-capture", path]);
    expect(mismatch.exit).not.toBe(0); expect(mismatch.err).toContain("selected source");
    const conflict = await cli(["publish", "--plan", "not-read.json", "--substack-capture", path, "--dry-run"]);
    expect(conflict.exit).not.toBe(0); expect(conflict.err).toContain("--plan cannot accompany");
    await writeFile(path, JSON.stringify({ ...capture, note: { ...capture.note, body: { status: "preview", html: "<p>Short …</p>" } } }));
    const preview = await cli(["plan", "--substack-capture", path]);
    expect(preview.exit).not.toBe(0); expect(preview.err).toContain("full body capture is required");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
