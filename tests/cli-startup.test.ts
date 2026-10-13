import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const preload = join(import.meta.dir, "fixtures/deny-eager-cli-modules.ts");

function invoke(...args: string[]) {
  const child = Bun.spawnSync([Bun.which("bun")!, "--preload", preload, "src/cli.ts", ...args], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, ARENA_BLOCK_ACCESS_TOKEN: "", ARENA_BLOCK_ENDPOINT: "http://127.0.0.1:1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: child.exitCode,
    stdout: new TextDecoder().decode(child.stdout),
    stderr: new TextDecoder().decode(child.stderr),
  };
}

describe("CLI command startup", () => {
  test("local version and help do not load rendering, server, or draft modules", () => {
    const version = invoke("version");
    expect(version.exitCode).toBe(0);
    expect(JSON.parse(version.stdout).client.schemaVersion).toBe(1);
    expect(version.stderr).toBe("");

    for (const args of [["--help"], ["publish", "--help"], ["render", "--help"]]) {
      const result = invoke(...args);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Usage:");
      expect(result.stderr).toBe("");
    }
  });
});
