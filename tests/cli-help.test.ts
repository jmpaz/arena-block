import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { configureCliHelp } from "../src/cli-help.ts";

const strip = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");
function help(command: string, width: number, color = false) {
  const env: NodeJS.ProcessEnv = { ...process.env, COLUMNS: String(width), FORCE_COLOR: color ? "1" : "0" };
  delete env.NO_COLOR;
  if (!color) env.NO_COLOR = "1";
  const result = Bun.spawnSync([process.execPath, "src/cli.ts", ...(command ? [command] : []), "--help"], { env, stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toBe("");
  return result.stdout.toString();
}

describe("CLI help", () => {
  for (const width of [40, 60, 80, 120]) {
    test(`wraps root and composition help at ${width} columns with plain and forced-color output`, () => {
      for (const command of ["", "plan", "publish", "thread"]) {
        const plain = help(command, width);
        const colored = help(command, width, true);
        expect(plain).not.toContain("\u001b");
        expect(colored).toContain("\u001b[1;36m");
        expect(strip(colored)).toBe(plain);
        for (const line of plain.split("\n")) expect(line.length).toBeLessThanOrEqual(width);
        expect(plain).toContain("Sources:");
        expect(plain).toContain("Files and output:");
      }
    });
  }

  test("keeps every subcommand readable in a narrow pipe", () => {
    for (const command of ["resolve", "render", "version", "replan-save", "save-intent", "mcp", "save-status", "cancel-save", "retry-save", "replay-save", "status", "metadata", "inspect", "resume", "attempt", "picker", "serve"]) {
      for (const line of help(command, 40).split("\n")) expect(line.length).toBeLessThanOrEqual(40);
    }
  });

  test("reports the existing defaults, optional policy and required arguments", () => {
    const text = help("plan", 120).replace(/\s+/g, " ");
    expect(text).toContain("(default: off)");
    expect(text).toContain('(default: "auto")');
    expect(text).toContain('(choices: "source", "plain")');
    expect(text).toContain("Omit to keep the platform style");
    expect(text).not.toContain("--no-thread-expansion");
    expect(help("save-intent", 120)).toContain("--plan <path>");
    expect(help("thread", 120)).toContain("<ref>");
    expect(help("", 120)).toContain("Save and recover:");
  });

  test("uses the actual stream width before COLUMNS and falls back for invalid widths", () => {
    const originalColumns = process.stdout.columns;
    const originalEnv = process.env.COLUMNS;
    try {
      process.env.COLUMNS = "40";
      process.stdout.columns = 60;
      const command = new Command("sample").description("A description for a terminal width check.");
      configureCliHelp(command);
      expect(command.configureOutput().getOutHelpWidth!()).toBe(60);
      process.stdout.columns = undefined as unknown as number;
      expect(command.configureOutput().getOutHelpWidth!()).toBe(40);
      for (const invalid of ["", "bad", "-1", "Infinity", "1000000"]) {
        process.env.COLUMNS = invalid;
        expect(command.configureOutput().getOutHelpWidth!()).toBe(80);
      }
    } finally {
      process.stdout.columns = originalColumns;
      if (originalEnv === undefined) delete process.env.COLUMNS;
      else process.env.COLUMNS = originalEnv;
    }
  });
});
