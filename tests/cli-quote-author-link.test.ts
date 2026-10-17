import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composePlan } from "../src/compose.ts";
import type { BlockPlan } from "../src/types.ts";

const fixtures = await Bun.file(new URL("./fixtures/quote-author-links-legacy-plans.json", import.meta.url)).json() as { provider: string; plan: BlockPlan }[];
const directory = await mkdtemp(join(tmpdir(), "arena-cli-quote-link-"));
const preload = join(directory, "resolved-quotes.ts");
await Bun.write(preload, `
const { SocialResolver } = await import(${JSON.stringify(new URL("../src/providers/index.ts", import.meta.url).href)});
const { compositionPolicySchema } = await import(${JSON.stringify(new URL("../src/types.ts", import.meta.url).href)});
const fixtures = ${JSON.stringify(fixtures)};
SocialResolver.prototype.resolveComposition = async (refs, extras, policy) => {
  await Bun.write(process.env.ARENA_QUOTE_TEST_LEDGER, JSON.stringify({ refs, extras, policy }));
  const fixture = fixtures.find(item => item.plan.block.canonicalSource === refs[0]);
  if (refs.length !== 1 || extras.length || !fixture) throw new Error("Unexpected fixture source");
  return { posts: structuredClone(fixture.plan.sources), policy: compositionPolicySchema.parse({ ...fixture.plan.policy, ...policy }) };
};
globalThis.fetch = async () => { throw new Error("Unexpected network request"); };`);
afterAll(() => rm(directory, { recursive: true, force: true }));

async function cli(args: string[]) {
  const ledger = join(directory, `${crypto.randomUUID()}.json`);
  await Bun.write(ledger, "null");
  const child = Bun.spawn([process.execPath, "--preload", preload, "src/cli.ts", ...args], {
    cwd: join(import.meta.dir, ".."), env: { ...process.env, HOME: directory,
      ARENA_BLOCK_ACCESS_TOKEN: "", ARENA_QUOTE_TEST_LEDGER: ledger }, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code, acquired: await Bun.file(ledger).json() };
}

test("quote link CLI help names both explicit choices and leaves the default decision open", async () => {
  const result = await cli(["plan", "--help"]);
  expect(result.code).toBe(0); expect(result.stderr).toBe(""); expect(result.acquired).toBeNull();
  const help = result.stdout.replace(/\s+/g, " ");
  expect(result.stdout).toContain("--quote-author-link <mode>");
  expect(help).toContain("source links to the quoted post");
  expect(help).toContain("plain uses an unlinked name");
  expect(help).toContain("Omit to keep the platform style");
  expect(result.stdout).toContain('choices: "source", "plain"');
  expect(result.stdout).not.toMatch(/quote-author-link[^\n]*default:/);
});

test.each(fixtures)("$provider: CLI omission preserves the frozen legacy style and full plan", async ({ plan }) => {
  const result = await cli(["plan", plan.block.canonicalSource, "--media", "none", "--quote-dates", "source", "--json"]);
  expect(result.code).toBe(0); expect(result.stderr).toBe("");
  expect(result.acquired.policy).not.toHaveProperty("quoteAuthorLink");
  expect(JSON.parse(result.stdout)).toEqual(plan);
});

test.each(fixtures)("$provider: both explicit CLI styles render nested quotes while source ownership stays fixed", async ({ provider, plan }) => {
  for (const mode of ["source", "plain"] as const) {
    const flags = ["--media", "none", "--quote-dates", "source", "--quote-author-link", mode];
    const expected = composePlan(plan.sources, { ...plan.policy, quoteAuthorLink: mode });
    const result = await cli(["plan", plan.block.canonicalSource, ...flags, "--json"]);
    expect(result.code).toBe(0); expect(result.stderr).toBe("");
    expect(result.acquired.policy.quoteAuthorLink).toBe(mode);
    const actual = JSON.parse(result.stdout) as BlockPlan;
    expect(actual).toEqual(expected); expect(actual.sources).toEqual(plan.sources);
    const output = join(directory, `${provider}-${mode}.md`);
    const rendered = await cli(["render", plan.block.canonicalSource, ...flags, "-o", output]);
    expect(rendered.code).toBe(0); expect(rendered.stderr).toBe("");
    const markdown = await readFile(output, "utf8");
    expect(markdown).toBe(expected.block.markdown);
    const html = Bun.markdown.html(markdown);
    for (const quote of [plan.sources[0]!.quote!, plan.sources[0]!.quote!.quote!]) {
      expect(markdown).toContain(quote.text);
      if (mode === "source") expect(html).toContain(`href="${quote.canonicalUrl}"`);
      else expect(html).not.toContain(`href="${quote.canonicalUrl}"`);
    }
    expect(actual.block.canonicalSource).toBe(plan.block.canonicalSource);
    expect(actual.sources[0]!.quote!.media).toEqual(plan.sources[0]!.quote!.media);
  }
});

test("invalid or absent quote link values fail before source acquisition", async () => {
  for (const flags of [["--quote-author-link", "profile"], ["--quote-author-link=auto"], ["--quote-author-link=on"], ["--quote-author-link"]]) {
    const result = await cli(["plan", fixtures[0]!.plan.block.canonicalSource, ...flags]);
    expect(result.code).toBe(1); expect(result.stdout).toBe(""); expect(result.acquired).toBeNull();
    expect(result.stderr).toContain("--quote-author-link");
  }
});

test("a root quote style reaches the subcommand and an explicit local style takes priority", async () => {
  const frozen = fixtures[0]!.plan;
  for (const [root, local, expected] of [["plain", [], "plain"], ["plain", ["--quote-author-link", "source"], "source"]] as const) {
    const result = await cli(["--quote-author-link", root, "plan", frozen.block.canonicalSource,
      "--media", "none", "--quote-dates", "source", ...local, "--json"]);
    expect(result.code).toBe(0); expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual(composePlan(frozen.sources, { ...frozen.policy, quoteAuthorLink: expected }));
  }
});

test("an explicit quote style never rewrites an existing --plan capture", async () => {
  const frozen = fixtures.find(item => item.provider === "substack")!.plan;
  const path = join(directory, "original-plan.json"), output = join(directory, "original.md"), config = join(directory, "config.json");
  await Bun.write(path, JSON.stringify(frozen));
  await Bun.write(config, JSON.stringify({ provenance: { local: false, remoteSnapshot: "none" } }));
  for (const mode of ["source", "plain"] as const) {
    const rendered = await cli(["render", "--plan", path, "--quote-author-link", mode, "-o", output]);
    expect(rendered.code).toBe(0); expect(rendered.acquired).toBeNull();
    expect(await readFile(output, "utf8")).toBe(frozen.block.markdown);
    const dryRun = await cli(["publish", "--plan", path, "--quote-author-link", mode, "--dry-run", "--config", config, "--to", "fixture-inbox"]);
    expect(dryRun.code).toBe(0); expect(dryRun.acquired).toBeNull();
    expect(JSON.parse(dryRun.stdout).snapshot.plan).toEqual(frozen);
  }
  expect(await Bun.file(path).json()).toEqual(frozen);
});
