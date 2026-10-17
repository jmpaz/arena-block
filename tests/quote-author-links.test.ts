import { expect, test } from "bun:test";
import { assignMediaRefs } from "../packages/core/providers/provider.ts";
import { composePlan, planHash } from "../packages/core/compose.ts";
import { compositionPolicySchema, blockPlanSchema, type BlockPlan } from "../packages/core/types.ts";
import { requiredCompositionCapabilities, requireRetainedCompositionPolicy } from "../packages/core/composition-capabilities.ts";
import { requiredPlanCapabilities } from "../src/plan-capabilities.ts";
import { ArenaBlockClient } from "../src/client.ts";
import { resolveWithNative } from "../extension/src/native-reddit.ts";
import { handle } from "../extension/native-host.ts";
import { blockPlanSchema as oldReceiverSchema } from "./fixtures/installed-daemon-types.ts";

const cases = await Bun.file(new URL("./fixtures/quote-author-links-legacy-plans.json", import.meta.url)).json() as Array<{ provider: string; plan: BlockPlan }>;
const serving = (capabilities: string[]) => ({ version: "0.1.0", revision: null, sourceId: "fixture", platform: "fixture", schemaVersion: 1, packagePath: null, planCapabilities: capabilities });

test("unset quote credit presentation preserves the complete frozen legacy plans and hashes", () => {
  for (const { plan } of cases) {
    expect(blockPlanSchema.parse(plan)).toEqual(plan);
    expect(composePlan(plan.sources, plan.policy)).toEqual(plan);
    const { hash, ...content } = plan;
    expect(planHash(content)).toBe(hash);
    expect(plan.policy).not.toHaveProperty("quoteAuthorLink");
    expect(requiredPlanCapabilities(plan)).not.toContain("quote-author-links-v1");
  }
  expect(compositionPolicySchema.parse({})).not.toHaveProperty("quoteAuthorLink");
  expect(() => compositionPolicySchema.parse({ quoteAuthorLink: "profile" })).toThrow();
});

test.each(cases)("$provider: source/plain credits preserve nested quote ownership, dates, writing and original media", ({ plan }) => {
  const linked = composePlan(plan.sources, { ...plan.policy, quoteAuthorLink: "source" });
  const plain = composePlan(plan.sources, { ...plan.policy, quoteAuthorLink: "plain" });
  const quote = plan.sources[0]!.quote!, earlier = quote.quote!;
  const author = `\`@${quote.author.handle}\``, prior = `\`@${earlier.author.handle}\``;
  expect(linked.block.markdown).toContain(`[${author}](<${quote.canonicalUrl}>)`);
  expect(linked.block.markdown).toContain(`[${prior}](<${earlier.canonicalUrl}>)`);
  expect(plain.block.markdown).toContain(`${author} (${quote.postedAt})`);
  expect(plain.block.markdown).not.toContain(`[${author}]`);
  expect(plain.block.markdown).not.toContain(`[${prior}]`);
  expect(linked.block.markdown.replace(`[${author}](<${quote.canonicalUrl}>)`, author)
    .replace(`[${prior}](<${earlier.canonicalUrl}>)`, prior)).toBe(plain.block.markdown);
  expect(plain.block.markdown.indexOf(earlier.text)).toBeLessThan(plain.block.markdown.indexOf(quote.text));
  expect(plain.block.markdown.indexOf(quote.text)).toBeLessThan(plain.block.markdown.indexOf(plan.sources[0]!.text));
  expect(linked.sources).toEqual(plan.sources); expect(plain.sources).toEqual(plan.sources);
  expect(linked.block.selectedMedia).toEqual(plan.block.selectedMedia);
  expect(linked.block.canonicalSource).toBe(plan.block.canonicalSource);
  expect(plain.block.quoteCoverage).toEqual(plan.block.quoteCoverage);
  expect(linked.sources[0]!.quote!.media[0]!.url).toBe("https://example.com/original.jpg");
  expect(linked.hash).not.toBe(plain.hash);
  expect(requiredPlanCapabilities(linked)).toContain("quote-author-links-v1");
  expect(requiredPlanCapabilities(plain)).toContain("quote-author-links-v1");
  for (const quoteMode of ["block", "sequence"] as const) {
    expect(composePlan(plan.sources, { ...plan.policy, quote: quoteMode, quoteAuthorLink: "source" }).block.markdown)
      .toContain(`[${author}](<${quote.canonicalUrl}>)`);
  }
  const hidden = composePlan(plan.sources, { ...plan.policy, quoteDepth: 0, quoteAuthorLink: "source" });
  expect(hidden.block.markdown).not.toContain(quote.canonicalUrl);
  expect(hidden.sources).toEqual(plan.sources);
});

test("an older receiver strips the explicit presentation field and invalidates the immutable plan", () => {
  const legacy = cases[0]!.plan;
  for (const mode of ["source", "plain"] as const) {
    const input = { policy: { quoteAuthorLink: mode } };
    const plan = composePlan(legacy.sources, { ...legacy.policy, ...input.policy });
    expect(requiredCompositionCapabilities(input)).toEqual(["quote-author-links-v1"]);
    const stripped = oldReceiverSchema.parse(plan) as unknown as BlockPlan;
    expect(stripped.policy).not.toHaveProperty("quoteAuthorLink");
    expect(() => requireRetainedCompositionPolicy(input, stripped)).toThrow("did not retain");
    const { hash: _, ...content } = stripped;
    const rehashed = { ...content, hash: planHash(content) };
    expect(() => requireRetainedCompositionPolicy(input, rehashed)).toThrow("did not retain");
    expect(() => requireRetainedCompositionPolicy(input, plan)).not.toThrow();
  }
});

test("client resolves and publishes explicit styles only with a matching receiver, before any source read or save", async () => {
  for (const mode of ["source", "plain"] as const) {
    const legacy = cases[0]!.plan, plan = composePlan(legacy.sources, { ...legacy.policy, quoteAuthorLink: mode });
    const paths: string[] = []; let capabilities: string[] = [], returned = plan;
    const client = new ArenaBlockClient("https://receiver.invalid", "fixture", (async (input, init) => {
      const path = new URL(String(input)).pathname; paths.push(`${init?.method} ${path}`);
      if (path === "/v1/version") return Response.json(serving(capabilities));
      if (path === "/v1/plans") return Response.json(returned);
      return Response.json({ error: "mock publication reached" }, { status: 400 });
    }) as typeof fetch);
    const refs = [legacy.block.canonicalSource];
    await expect(client.plan(refs, { quoteAuthorLink: mode })).rejects.toThrow("No source read or save");
    await expect(client.publish(plan, ["fixture-channel"])).rejects.toThrow("No save was submitted");
    expect(paths).toEqual(["GET /v1/version", "GET /v1/version"]);
    capabilities = ["quote-author-links-v1"];
    expect(await client.plan(refs, { quoteAuthorLink: mode })).toEqual(plan);
    returned = legacy;
    await expect(client.plan(refs, { quoteAuthorLink: mode })).rejects.toThrow("did not retain");
    expect(paths.filter(path => path.includes("publications"))).toEqual([]);
  }
});

test("browser-to-helper and helper-to-receiver resolution reject an old or stripping intermediary", async () => {
  const oldToken = process.env.ARENA_BLOCK_ACCESS_TOKEN;
  process.env.ARENA_BLOCK_ACCESS_TOKEN = "fixture-token";
  try {
    for (const mode of ["source", "plain"] as const) {
      const frozen = cases[0]!.plan, legacy = composePlan(frozen.sources.map(assignMediaRefs), frozen.policy);
      const plan = composePlan(legacy.sources, { ...legacy.policy, quoteAuthorLink: mode });
      const input = { refs: [legacy.block.canonicalSource], extraRefs: [], refresh: false, redditCaptures: [], substackCaptures: [], policy: plan.policy };
      const calls: string[] = []; let capabilities: string[] = [], returned = plan;
      const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input)).pathname; calls.push(`${init?.method} ${path}`);
        return Response.json(path === "/v1/version" ? serving(capabilities) : returned);
      }) as typeof fetch;
      await expect(handle({ id: "quote-style", action: "resolve", input }, fetcher)).rejects.toThrow("Update the local helper");
      expect(calls).toEqual(["GET /v1/version"]);
      capabilities = ["quote-author-links-v1"];
      expect(await handle({ id: "quote-style", action: "resolve", input }, fetcher)).toEqual(plan);
      returned = legacy;
      await expect(handle({ id: "quote-style", action: "resolve", input }, fetcher)).rejects.toThrow("did not retain");
      const actions: string[] = [];
      await expect(resolveWithNative(input, async action => {
        actions.push(action); return action === "ping" ? serving([]) : plan;
      })).rejects.toThrow("Update the local helper");
      expect(actions).toEqual(["ping"]);
      await expect(resolveWithNative(input, async action => action === "ping" ? serving(capabilities) : legacy)).rejects.toThrow("did not retain");
    }
  } finally {
    if (oldToken === undefined) delete process.env.ARENA_BLOCK_ACCESS_TOKEN;
    else process.env.ARENA_BLOCK_ACCESS_TOKEN = oldToken;
  }
});
