import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArenaClient } from "../src/arena.ts";
import { createService } from "../src/service.ts";
import { collectRatio, formatRatioReport, tallyBlocks, type ChannelRow, type RatioSource } from "../src/visibility-ratio.ts";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

const channel = (id: number, visibility: string, count: number | undefined, owner = "josh"): ChannelRow => ({ id, visibility, owner: { slug: owner }, ...(count === undefined ? {} : { count }) });
const channels = [channel(1, "private", 3), channel(2, "public", 2), channel(3, "closed", 2), channel(4, "private", 0), channel(5, "private", 3, "group")];
const contents: Record<number, { blocks: number[]; channels: number }> = {
  1: { blocks: [10, 11, 12], channels: 0 },
  2: { blocks: [10, 13], channels: 0 },
  3: { blocks: [11], channels: 1 },
  5: { blocks: [14, 15], channels: 1 },
};

function stubSource(options: { pageSize?: number; failures?: Record<number, string[]>; calls?: string[] } = {}): RatioSource {
  const pageSize = options.pageSize ?? 2;
  return {
    channels: async (page) => {
      options.calls?.push(`channels:${page}`);
      const slice = channels.slice((page - 1) * 3, page * 3);
      return { accountId: 17, channels: slice, nextPage: page * 3 < channels.length ? page + 1 : null };
    },
    channelBlocks: async (id, page) => {
      options.calls?.push(`blocks:${id}:${page}`);
      const failure = options.failures?.[id]?.shift();
      if (failure) throw new Error(failure);
      const entry = contents[id]!;
      const slice = entry.blocks.slice((page - 1) * pageSize, page * pageSize);
      const more = page * pageSize < entry.blocks.length;
      return { blockIds: slice, channelEntries: page === 1 ? entry.channels : 0, nextPage: more ? page + 1 : null };
    },
  };
}

test("overlap rules assign a block in private and public channels", () => {
  const masks = [1 | 4, 1, 2 | 4, 4, 1 | 2];
  expect(tallyBlocks(masks, "public")).toEqual({ private: 1, closed: 1, public: 3, total: 5 });
  expect(tallyBlocks(masks, "private")).toEqual({ private: 3, closed: 1, public: 1, total: 5 });
  expect(tallyBlocks(masks, "both")).toEqual({ private: 3, closed: 2, public: 3, total: 5 });
});

test("collection pages channels, skips empty ones, and counts unique blocks by the public rule", async () => {
  const calls: string[] = [];
  const report = await collectRatio(stubSource({ calls }), { overlap: "public", now: () => new Date("2026-10-14T12:00:00Z") });
  expect(report.channels).toEqual({ private: 3, closed: 1, public: 1, total: 5 });
  expect(report.blocks).toEqual({ private: 3, closed: 1, public: 2, total: 6 });
  expect(report.blockRatios.privatePerPublic).toBe(1.5);
  expect(report.blockRatios.privatePerOpen).toBe(1);
  expect(report.blockRatios.privateShare).toBe(0.5);
  expect(report.owners).toEqual({ josh: { private: 2, closed: 1, public: 1, total: 4 }, group: { private: 1, closed: 0, public: 0, total: 1 } });
  expect(report.scan).toEqual({ channelsRead: 4, blockPlacements: 8, nestedChannelEntries: 2, countMismatches: 0 });
  expect(calls.filter(call => call.startsWith("channels:"))).toEqual(["channels:1", "channels:2"]);
  expect(calls.some(call => call.startsWith("blocks:4:"))).toBe(false);
  expect(calls).toContain("blocks:1:2");
});

test("private and both rules count the block shared by a private and a public channel differently", async () => {
  const privateRule = await collectRatio(stubSource(), { overlap: "private" });
  expect(privateRule.blocks).toEqual({ private: 5, closed: 0, public: 1, total: 6 });
  const both = await collectRatio(stubSource(), { overlap: "both" });
  expect(both.blocks).toEqual({ private: 5, closed: 1, public: 2, total: 6 });
  expect(both.blocks.private + both.blocks.closed + both.blocks.public).toBeGreaterThan(both.blocks.total);
});

test("placements rule sums listed counts and reads no channel contents", async () => {
  const calls: string[] = [];
  const report = await collectRatio(stubSource({ calls }), { overlap: "placements" });
  expect(report.unit).toBe("placements");
  expect(report.blocks).toEqual({ private: 6, closed: 2, public: 2, total: 10 });
  expect(report.scan).toBeUndefined();
  expect(calls.every(call => call.startsWith("channels:"))).toBe(true);
});

test("rate limits are retried and other failures stop the count", async () => {
  const retried = await collectRatio(stubSource({ failures: { 2: ["arena-block returned 429"] } }), { overlap: "public", retryDelays: [0] });
  expect(retried.blocks.total).toBe(6);
  await expect(collectRatio(stubSource({ failures: { 2: ["Invalid channel response"] } }), { overlap: "public", retryDelays: [0] })).rejects.toThrow("Invalid channel response");
});

test("a listed count that differs from the entries read is reported", async () => {
  const source = stubSource();
  const mismatched: RatioSource = { ...source, channels: async (page) => {
    const response = await source.channels(page);
    return { ...response, channels: response.channels.map(value => value.id === 1 ? { ...value, count: 9 } : value) };
  } };
  expect((await collectRatio(mismatched, { overlap: "public" })).scan?.countMismatches).toBe(1);
});

test("text report states the rule and ratios, and prints n/a without a public denominator", async () => {
  const report = await collectRatio(stubSource(), { overlap: "public", now: () => new Date("2026-10-14T12:00:00Z") });
  const text = formatRatioReport(report);
  expect(text).toContain("Block rule (public): a block in several channels counts once, as the most open visibility");
  expect(text).toContain("blocks, private per public: 1.50");
  const onlyPrivate = await collectRatio({ channels: async () => ({ accountId: 1, channels: [channel(1, "private", 1)], nextPage: null }),
    channelBlocks: async () => ({ blockIds: [1], channelEntries: 0, nextPage: null }) }, { overlap: "public" });
  expect(formatRatioReport(onlyPrivate)).toContain("private per public: n/a");
  expect(onlyPrivate.channelRatios.privatePerPublic).toBeNull();
});

test("daemon block route is authenticated, bounded, account-scoped and reads only block IDs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arena-ratio-route-")); directories.push(directory);
  const requests: Array<[number, number]> = [];
  const client = {
    me: async () => ({ id: 17 }),
    channelBlockPage: async (id: number, page: number) => {
      requests.push([id, page]);
      return { blockIds: [5, 6], channelEntries: 1, meta: { next_page: page + 1, has_more_pages: true } };
    },
  } as unknown as ArenaClient;
  const service = createService({ host: "localhost", port: 8790, publicBaseUrl: "https://engine.invalid", stateDirectory: directory,
    mediaDirectory: directory, accessToken: "test-access", arenaToken: "unused", credential: { schemaVersion: 1, profile: "shared", arenaTokenEnv: "ARENA_WRITE_ACCESS_TOKEN", expectedAccountId: 17 } }, { client });
  const call = (path: string, authorized = true, method = "GET") => service.handler(new Request("https://engine.invalid" + path, { method, headers: authorized ? { authorization: "Bearer test-access" } : {} }));
  try {
    expect((await call("/v1/channels/9/blocks", false)).status).toBe(401);
    expect((await call("/v1/channels/9/blocks?page=101")).status).toBe(400);
    expect((await call("/v1/channels/0/blocks")).status).toBe(404);
    expect((await call("/v1/channels/9/blocks", true, "POST")).status).toBe(404);
    expect(requests).toEqual([]);
    expect(await (await call("/v1/channels/9/blocks?page=3")).json()).toEqual({ channelId: 9, blockIds: [5, 6], channelEntries: 1, nextPage: 4 });
    expect(requests).toEqual([[9, 3]]);
  } finally { await service.close(); }
});

test("CLI ratio reads a stubbed daemon with GET requests only and never prints the token", async () => {
  const seen: string[] = [];
  const token = "fixture-token-must-not-print";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url);
    seen.push(`${request.method} ${url.pathname}`);
    if (request.headers.get("authorization") !== `Bearer ${token}`) return Response.json({ error: "denied" }, { status: 401 });
    if (url.pathname === "/v1/channels") return Response.json({ accountId: 17, nextPage: null, channels: [
      { id: 1, title: "a", slug: "a", visibility: "private", owner: { name: "J", slug: "josh" }, count: 2 },
      { id: 2, title: "b", slug: "b", visibility: "public", owner: { name: "J", slug: "josh" }, count: 1 }] });
    const match = url.pathname.match(/^\/v1\/channels\/(\d+)\/blocks$/);
    if (match) return Response.json({ channelId: Number(match[1]), blockIds: match[1] === "1" ? [7, 8] : [7], channelEntries: 0, nextPage: null });
    return Response.json({ error: "Not found" }, { status: 404 });
  } });
  const run = async (...args: string[]) => {
    const child = Bun.spawn([Bun.which("bun")!, "src/cli.ts", ...args], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe",
      env: { ...process.env, ARENA_BLOCK_ACCESS_TOKEN: token, ARENA_BLOCK_ENDPOINT: `http://127.0.0.1:${server.port}` } });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code, out, err };
  };
  try {
    const json = await run("ratio", "--json");
    expect(json.code).toBe(0);
    expect(JSON.parse(json.out)).toMatchObject({ accountId: 17, overlap: "public", channels: { private: 1, public: 1, total: 2 }, blocks: { private: 1, public: 1, total: 2 } });
    const both = JSON.parse((await run("ratio", "--overlap", "both", "--json")).out);
    expect(both.blocks).toMatchObject({ private: 2, public: 1, total: 2 });
    const text = await run("ratio", "--overlap", "private");
    expect(text.out).toContain("Block rule (private)");
    expect((await run("ratio", "--overlap", "sometimes")).code).toBe(1);
    for (const output of [json.out, json.err, text.out, text.err]) expect(output).not.toContain(token);
    expect(seen.every(line => line.startsWith("GET "))).toBe(true);
  } finally { server.stop(true); }
});
