import { expect, test } from "bun:test";
import { XProvider } from "../packages/core/providers/x.ts";
import { SocialResolver } from "../packages/core/providers/index.ts";
import { parseSource } from "../src/url.ts";
import { composePlan } from "../src/compose.ts";
import { blockPlanSchema, compositionPolicySchema, type ResolvedPost } from "../src/types.ts";
import { quoteDateLabel, sourceCalendarDay } from "../packages/core/quote-policy.ts";

function tweet(id: number, next?: number, postedAt = "Tue Oct 06 16:12:20 +0000 2026"): Record<string, unknown> {
  return { id: String(id), author: { screen_name: `author${id}` }, text: `Exact ${id}.\n\n第二段 👋`, created_at: postedAt,
    ...(next === undefined ? {} : { quote: { id: String(next), author: { screen_name: `author${next}` }, text: `Embedded ${next}` } }) };
}
function fixture(values: Record<string, Record<string, unknown> | number>) {
  const calls: string[] = [];
  const provider = new XProvider("https://api.fxtwitter.com", async (url, init) => {
    expect(init?.redirect).toBe("error"); expect(init?.credentials).toBe("omit");
    calls.push(url); const value = values[url.split("/").at(-1)!];
    return typeof value === "number" ? new Response("Unavailable", { status: value }) : Response.json({ tweet: value });
  });
  return { calls, provider, resolver: new SocialResolver({ x: provider }) };
}

test("initial acquisition reads two descendants and available full expands only beyond the cached prefix", async () => {
  const { calls, resolver } = fixture({ "100": tweet(100, 99), "99": tweet(99, 98), "98": tweet(98, 97), "97": tweet(97) });
  const posts = await resolver.resolve(["https://x.com/author100/status/100"]), root = posts[0]!;
  expect(calls.map(url => url.split("/").at(-1))).toEqual(["100", "99", "98"]);
  expect(root.quoteCoverage).toEqual({ maxDepth: 8, actualDepth: 2, acquisitionDepth: 2, mayExpand: true, maxReached: false, truncated: true, stopped: "depth_limit", sourceIds: ["100", "99", "98"] });
  expect(root.quote!.quote!.quote).toBeUndefined();
  const plan = composePlan(posts);
  expect(plan.block.markdown).toContain("> > `@author98`");
  expect(plan.block.markdown).not.toContain("Exact 97");
  expect(plan.block.markdown.indexOf("Exact 98")).toBeLessThan(plan.block.markdown.indexOf("Exact 99"));
  expect(plan.block.markdown.indexOf("Exact 99")).toBeLessThan(plan.block.markdown.indexOf("Exact 100"));
  expect(plan.block.quoteCoverage?.[0]).toMatchObject({ renderedDepth: 2, availableDepth: 2, truncated: true, mayExpand: true });
  const again = await resolver.resolve([root.canonicalUrl]);
  expect(calls).toHaveLength(3); expect(composePlan(again).hash).toBe(plan.hash);
  const expanded = await resolver.resolve([root.canonicalUrl], undefined, { quoteDepth: "full" });
  expect(calls.map(url => url.split("/").at(-1))).toEqual(["100", "99", "98", "97"]);
  expect(expanded[0]!.quote!.quote!.quote!.text).toBe("Exact 97.\n\n第二段 👋");
  const full = composePlan(expanded, { quoteDepth: "full" });
  expect(full.block.markdown).toContain("> > > `@author97`");
  expect(full.block.quoteCoverage?.[0]).toMatchObject({ renderedDepth: 3, truncated: false });
  expect(composePlan(posts, { quoteDepth: 0 }).block.markdown).toBe(root.text);
  expect(composePlan(posts, { quote: "omit" }).block.markdown).toBe(root.text);
  expect(blockPlanSchema.parse(full)).toEqual(full);
  const fullAgain = await resolver.resolve([root.canonicalUrl], undefined, { quoteDepth: "full" });
  expect(calls).toHaveLength(4);
  expect(composePlan(fullAgain, { quoteDepth: "full" }).hash).toBe(full.hash);
  resolver.clearSourceCache();
  await resolver.resolve([root.canonicalUrl]); expect(calls).toHaveLength(7);
});

test("quote media retains unique descendant refs while root selections stay stable", async () => {
  const media = { all: [{ type: "photo", url: "https://example.com/source.jpg", width: 640, height: 480 }] };
  const { resolver } = fixture({ "100": { ...tweet(100, 99), media }, "99": { ...tweet(99, 98), media }, "98": { ...tweet(98), media } });
  const root = (await resolver.resolve(["https://x.com/author100/status/100"]))[0]!;
  expect(root.media[0]!.ref).toBe("1.1");
  expect(root.quote!.media[0]!.ref).toBe("quote.1");
  expect(root.quote!.quote!.media[0]!.ref).toBe("quote2.1");
  expect(composePlan([root], { media: "all", quoteDepth: "full" }).block.selectedMedia).toEqual(["1.1"]);
});

test("available full stops at eight descendants and reports the omitted ninth reference", async () => {
  const values = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [String(100 - index), tweet(100 - index, index === 9 ? undefined : 99 - index)]));
  const { calls, resolver } = fixture(values);
  const root = (await resolver.resolve(["https://x.com/author100/status/100"], undefined, { quoteDepth: "full" }))[0]!;
  expect(calls).toHaveLength(9);
  expect(root.quoteCoverage).toMatchObject({ maxDepth: 8, actualDepth: 8, maxReached: true, truncated: true, stopped: "depth_limit" });
  let tail = root; while (tail.quote) tail = tail.quote;
  expect(tail.quoteBoundary).toMatchObject({ status: "depth_limit", id: "91" });
  const full = composePlan([root], { quoteDepth: "full" });
  expect(full.block.markdown).toContain("> > > > > > > > `@author92`");
  expect(full.block.markdown).not.toContain("Exact 91");
  expect(full.block.quoteCoverage?.[0]).toMatchObject({ renderedDepth: 8, maxReached: true, truncated: true });
});

test("no quote produces no coverage/control marker and leaves the ordinary root plan stable", async () => {
  const { calls, resolver } = fixture({ "100": tweet(100) });
  const root = (await resolver.resolve(["https://x.com/author100/status/100"]))[0]!;
  expect(calls).toHaveLength(1); expect(root.quote).toBeUndefined(); expect(root.quoteCoverage).toBeUndefined();
  const plan = composePlan([root]);
  expect(plan.block.quoteCoverage).toBeUndefined(); expect(plan.policy.quoteDepth).toBeUndefined();
});

test("cycles, unknown quote IDs and unavailable descendants retain explicit boundaries", async () => {
  for (const [values, status, ids] of [
    [{ "100": tweet(100, 99), "99": tweet(99, 100) }, "cycle", ["100", "99"]],
    [{ "100": { ...tweet(100), quote: { text: "No source identity" } } }, "invalid_reference", ["100"]],
    [{ "100": { ...tweet(100), quote: { id: "99" } }, "99": 404 }, "deleted", ["100"]],
    [{ "100": { ...tweet(100), quote: { id: "99" } }, "99": 503 }, "unavailable", ["100"]],
  ] as const) {
    const { resolver } = fixture(values);
    const root = (await resolver.resolve(["https://x.com/author100/status/100"]))[0]!;
    expect(root.quoteCoverage).toMatchObject({ stopped: status, truncated: true, sourceIds: ids });
    expect(composePlan([root], { quoteDepth: "full" }).block.markdown).toContain(status.replaceAll("_", " "));
  }
});

test("failed standalone hydration preserves an observed embedded quote with explicit snapshot status", async () => {
  const { resolver } = fixture({ "100": tweet(100, 99), "99": 404 });
  const root = (await resolver.resolve(["https://x.com/author100/status/100"]))[0]!;
  expect(root.quote?.text).toBe("Embedded 99");
  expect(root.quote?.id).toBe("99");
  expect(root.quote?.quoteSnapshot).toEqual({ basis: "embedded", hydration: "deleted" });
  expect(root.quoteCoverage).toMatchObject({ actualDepth: 1, stopped: "deleted", truncated: true });
  expect(composePlan([root]).block.markdown).toContain("embedded source snapshot");
});

test("source payload status and identity failures do not become fabricated descendants", async () => {
  for (const value of [{ code: 404 }, { tweet: tweet(98) }, { tweet: { id: "99", text: "No observed author" } }]) {
    const provider = new XProvider("https://api.fxtwitter.com", async url => Response.json(url.endsWith("/100")
      ? { tweet: { ...tweet(100), quote: { id: "99" } } } : value));
    const root = await provider.resolve(parseSource("https://x.com/author100/status/100"));
    expect(root.quote).toBeUndefined();
    expect(root.quoteBoundary?.status).toBe("code" in value ? "deleted" : "unavailable");
    expect(root.quoteCoverage?.sourceIds).toEqual(["100"]);
  }
});

test("cancellation prevents stale descendant writes/results and does not poison the root snapshot cache", async () => {
  let cancelSeen = false, entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const calls: string[] = [];
  let blockDescendant = true;
  const provider = new XProvider("https://api.fxtwitter.com", async (url, init) => {
    const id = url.split("/").at(-1)!; calls.push(id);
    if (id === "99" && blockDescendant) {
      entered(); await new Promise<void>((_, reject) => init?.signal?.addEventListener("abort", () => { cancelSeen = true; reject(new Error("aborted")); }, { once: true }));
    }
    return Response.json({ tweet: tweet(Number(id), id === "100" ? 99 : undefined) });
  });
  const controller = new AbortController();
  const pending = provider.resolve(parseSource("https://x.com/author100/status/100"), controller.signal);
  await waiting; controller.abort();
  await expect(pending).rejects.toThrow(); expect(cancelSeen).toBe(true);
  blockDescendant = false;
  const root = await provider.resolve(parseSource("https://x.com/author100/status/100"));
  expect(calls).toEqual(["100", "99", "99"]); expect(root.quote?.text).toContain("Exact 99");
});

test("canceled full expansion leaves the prior depth-two snapshot usable and its cached prefix intact", async () => {
  let entered!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const calls: string[] = [];
  let block = true;
  const provider = new XProvider("https://api.fxtwitter.com", async (url, init) => {
    const id = url.split("/").at(-1)!; calls.push(id);
    if (id === "97" && block) {
      entered(); await new Promise<void>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    }
    return Response.json({ tweet: tweet(Number(id), id === "97" ? undefined : Number(id) - 1) });
  });
  const source = parseSource("https://x.com/author100/status/100");
  const original = await provider.resolve(source), originalPlan = composePlan([original]);
  const originalJSON = JSON.stringify(original);
  const controller = new AbortController();
  const full = provider.resolve(source, controller.signal, { quoteDepth: "full" });
  await reached; controller.abort(); await expect(full).rejects.toThrow();
  expect(JSON.stringify(original)).toBe(originalJSON); expect(composePlan([original]).hash).toBe(originalPlan.hash);
  expect(composePlan([await provider.resolve(source)]).hash).toBe(originalPlan.hash);
  block = false;
  expect((await provider.resolve(source, undefined, { quoteDepth: "full" })).quoteCoverage?.actualDepth).toBe(3);
  expect(calls).toEqual(["100", "99", "98", "97", "97"]);
});

test("nested quote rendering preserves source hierarchy and supplementary media order", async () => {
  const { resolver } = fixture({ "100": tweet(100, 99), "99": tweet(99, 98), "98": tweet(98) });
  const posts = await resolver.resolve(["https://x.com/author100/status/100"]);
  posts[0]!.media = [{ ref: "1.1", kind: "image", url: "https://example.com/a.jpg", width: 640, height: 480, alt: "" }];
  const extra = { ...posts[0]!, id: "101", canonicalUrl: "https://x.com/author101/status/101", text: "Extra prose omitted",
    media: [{ ref: "2.1", kind: "image" as const, url: "https://example.com/b.jpg", width: 640, height: 480, alt: "" }] };
  const plan = composePlan([...posts, extra], { mediaOnlyPosts: [2], mediaOrder: ["2.1", "1.1"], quoteDepth: "full" });
  expect(plan.block.selectedMedia).toEqual(["2.1", "1.1"]);
  expect(plan.block.markdown).toContain("> > `@author98`"); expect(plan.block.markdown).not.toContain("Extra prose omitted");
  expect(plan.block.quoteCoverage).toHaveLength(1);
  const sequence = composePlan(posts, { quote: "sequence" });
  expect(sequence.block.markdown.indexOf("Exact 98")).toBeLessThan(sequence.block.markdown.indexOf("Exact 99"));
});

test("automatic quote dates use only earlier comparable source calendar days and preserve authored dates", () => {
  const root: ResolvedPost = { provider: "x", id: "100", canonicalUrl: "https://x.com/author/status/100", author: { handle: "author" }, text: "Current prose", postedAt: "2026-10-06T16:12:20Z", media: [] };
  const quote = { ...root, id: "99", author: { handle: "old" }, postedAt: "Wed Mar 18 12:00:00 +0000 2026", text: "Authored date (18 Mar 2026) stays exact." };
  expect(quoteDateLabel(root, quote, undefined)).toEqual({ label: "Mar 18, 2026" });
  const plan = composePlan([{ ...root, quote }]);
  expect(plan.block.markdown).toContain("`@old` (Mar 18, 2026)"); expect(plan.block.markdown).toContain(quote.text);
  expect(plan.sources[0]!.quote!.postedAt).toBe(quote.postedAt);
  expect(quoteDateLabel(root, { ...quote, postedAt: "2026-10-06T01:00:00Z" }, undefined)).toEqual({ uncertainty: "same_day" });
  for (const postedAt of [undefined, "Mar 18, 2026", "2026-03-18T12:00:00", "2026-03-18T12:00:00-04:00"])
    expect(quoteDateLabel(root, { ...quote, postedAt }, undefined)).toEqual({ uncertainty: "missing_or_incomparable_source_days" });
  expect(quoteDateLabel(root, quote, "source")).toEqual({ label: quote.postedAt });
  expect(quoteDateLabel(root, quote, "none")).toEqual({});
  expect(composePlan([{ ...root, quote }], { quoteDates: "none" }).block.markdown).not.toContain("`@old` (Mar 18, 2026)");
  expect(sourceCalendarDay("2026-02-30")).toBeUndefined();
  for (const quoteDepth of [-1, 9, "unbounded"]) expect(compositionPolicySchema.safeParse({ quoteDepth }).success).toBe(false);
});
