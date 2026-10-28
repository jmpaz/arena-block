import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArenaClient } from "../src/arena.ts";
import { createService } from "../src/service.ts";
import { collectRatio, formatRatioReport, type BlockRow, type BlockType, type ChannelRow, type RatioSource } from "../src/visibility-ratio.ts";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

const channel = (id: number, visibility: string, owner = "josh"): ChannelRow => ({ id, visibility, owner: { slug: owner } });
const channels = [channel(1, "private"), channel(2, "public"), channel(3, "closed"), channel(4, "private"), channel(5, "private", "group")];
const blocks = (start: number, ...visibilities: string[]): BlockRow[] => visibilities.map((visibility, index) => ({ id: start + index, visibility }));
const library: Record<BlockType, BlockRow[]> = {
  Text: blocks(100, "private", "private", "public"),
  Image: blocks(200, "public", "private", "orphan", "private", "public"),
  Link: blocks(300, "public"),
  Attachment: [],
  Embed: blocks(500, "private"),
};

/** Serves the library oldest or newest first; `window` stands in for a search backend that refuses deep pages. */
function stubSource(options: { pageSize?: number; window?: number; failures?: string[]; calls?: string[]; types?: Record<BlockType, BlockRow[]> } = {}): RatioSource {
  const pageSize = options.pageSize ?? 2, types = options.types ?? library;
  return {
    channels: async (page) => {
      options.calls?.push(`channels:${page}`);
      const slice = channels.slice((page - 1) * 3, page * 3);
      return { accountId: 17, channels: slice, nextPage: page * 3 < channels.length ? page + 1 : null };
    },
    blocks: async (type, sort, page) => {
      options.calls?.push(`${type}:${sort}:${page}`);
      const failure = options.failures?.shift();
      if (failure) throw new Error(failure);
      const all = type === "Block" ? Object.values(types).flat() : types[type];
      if (options.window !== undefined && (page - 1) * pageSize >= options.window) throw new Error("arena-block returned 400: Result window is too large");
      const ordered = sort === "created_at_asc" ? all : [...all].reverse();
      return { blocks: ordered.slice((page - 1) * pageSize, page * pageSize), total: all.length, nextPage: page * pageSize < all.length ? page + 1 : null };
    },
  };
}

test("channels count by channel visibility and blocks by Are.na's block visibility", async () => {
  const calls: string[] = [];
  const report = await collectRatio(stubSource({ calls }), { now: () => new Date("2026-10-28T12:00:00Z") });
  expect(report.channels).toEqual({ private: 3, closed: 1, public: 1, total: 5 });
  expect(report.owners).toEqual({ josh: { private: 2, closed: 1, public: 1, total: 4 }, group: { private: 1, closed: 0, public: 0, total: 1 } });
  expect(report.channelRatios).toEqual({ privatePerVisible: 1.5, privateShare: 0.6 });
  expect(report.blocks).toEqual({ private: 5, public: 4, orphan: 1, other: 0, total: 10 });
  expect(report.blockRatios).toEqual({ privatePerPublic: 1.25, privateShare: 0.5 });
  expect(report.coverage).toMatchObject({ reported: 10, read: 10, complete: true });
  expect(report.coverage.types.Image).toEqual({ reported: 5, read: 5 });
  expect(calls).toContain("Image:created_at_asc:3");
  expect(calls.some(call => call.endsWith("created_at_desc:1"))).toBe(false);
});

test("a listing refused past its search window is finished newest first", async () => {
  const calls: string[] = [];
  const report = await collectRatio(stubSource({ window: 4, calls }));
  expect(report.coverage).toMatchObject({ reported: 10, read: 10, complete: true });
  expect(report.blocks).toEqual({ private: 5, public: 4, orphan: 1, other: 0, total: 10 });
  expect(calls).toContain("Image:created_at_asc:3");
  expect(calls).toContain("Image:created_at_desc:1");
  expect(calls).not.toContain("Image:created_at_desc:2");
  expect(calls.some(call => call.startsWith("Text:created_at_desc"))).toBe(false);
});

test("a listing still short after both directions is reported instead of filled in", async () => {
  const image = blocks(200, "public", "private", "orphan", "private", "public", "private", "public");
  const report = await collectRatio(stubSource({ window: 2, types: { ...library, Image: image } }));
  expect(report.coverage.complete).toBe(false);
  expect(report.coverage.types.Image).toEqual({ reported: 7, read: 4 });
  expect(report.blocks.total).toBe(9);
  expect(formatRatioReport(report)).toContain("Read 9 of the 12 blocks Are.na reports; listings stopped short for Image 4 of 7.");
});

test("rate limits are retried and a failed first page stops the count", async () => {
  const retried = await collectRatio(stubSource({ failures: ["arena-block returned 429"] }), { retryDelays: [0] });
  expect(retried.blocks.total).toBe(10);
  await expect(collectRatio(stubSource({ failures: ["Invalid block catalog response"] }), { retryDelays: [0] })).rejects.toThrow("Invalid block catalog response");
});

test("text report lists both tables, the ratios and the coverage", async () => {
  const text = formatRatioReport(await collectRatio(stubSource(), { now: () => new Date("2026-10-28T12:00:00Z") }));
  expect(text).toContain("Account 17, 2026-10-28T12:00:00.000Z, channel list live");
  expect(text).toContain("Channels: 1.50 private per closed or public, 60.0% private.");
  expect(text).toContain("Blocks: 1.25 private per public, 50.0% private.");
  expect(text).toContain("Read all 10 blocks Are.na reports for this account.");
  expect(text).not.toContain("other");
  const odd = { ...library, Text: blocks(100, "private", "unlisted"), Image: [], Link: [], Embed: [] };
  const privateOnly = await collectRatio(stubSource({ types: { ...odd, Text: blocks(100, "private") } }));
  expect(formatRatioReport(privateOnly)).toContain("Blocks: n/a private per public, 100.0% private.");
  expect(formatRatioReport(await collectRatio(stubSource({ types: odd })))).toMatch(/other\s+1/);
});

test("daemon block route is authenticated, bounded, account-scoped and returns IDs with visibility", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arena-ratio-route-")); directories.push(directory);
  const requests: Array<[number, string, string, number]> = [];
  const client = {
    me: async () => ({ id: 17 }),
    ownedBlockPage: async (accountId: number, type: string, sort: string, page: number) => {
      requests.push([accountId, type, sort, page]);
      return { blocks: [{ id: 5, visibility: "private" }], total: 40_000, meta: { next_page: page + 1, has_more_pages: true } };
    },
  } as unknown as ArenaClient;
  const service = createService({ host: "localhost", port: 8790, publicBaseUrl: "https://engine.invalid", stateDirectory: directory,
    mediaDirectory: directory, accessToken: "test-access", arenaToken: "unused", credential: { schemaVersion: 1, profile: "shared", arenaTokenEnv: "ARENA_WRITE_ACCESS_TOKEN", expectedAccountId: 17 } }, { client });
  const call = (path: string, authorized = true, method = "GET") => service.handler(new Request("https://engine.invalid" + path, { method, headers: authorized ? { authorization: "Bearer test-access" } : {} }));
  try {
    expect((await call("/v1/account/blocks", false)).status).toBe(401);
    expect((await call("/v1/account/blocks?page=1001")).status).toBe(400);
    expect((await call("/v1/account/blocks?type=Channel")).status).toBe(400);
    expect((await call("/v1/account/blocks?sort=updated_at_desc")).status).toBe(400);
    expect((await call("/v1/account/blocks", true, "POST")).status).toBe(404);
    expect(requests).toEqual([]);
    expect(await (await call("/v1/account/blocks?type=Image&sort=created_at_desc&page=150")).json())
      .toEqual({ accountId: 17, type: "Image", blocks: [{ id: 5, visibility: "private" }], total: 40_000, nextPage: 151 });
    expect(requests).toEqual([[17, "Image", "created_at_desc", 150]]);
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
      { id: 1, title: "a", slug: "a", visibility: "private", owner: { name: "J", slug: "josh" } },
      { id: 2, title: "b", slug: "b", visibility: "public", owner: { name: "J", slug: "josh" } }] });
    if (url.pathname === "/v1/account/blocks") {
      const type = url.searchParams.get("type");
      const rows = type === "Block" ? [{ id: 7, visibility: "private" }, { id: 8, visibility: "public" }]
        : type === "Text" ? [{ id: 7, visibility: "private" }] : type === "Image" ? [{ id: 8, visibility: "public" }] : [];
      return Response.json({ accountId: 17, type, blocks: rows, total: rows.length, nextPage: null });
    }
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
    expect(JSON.parse(json.out)).toMatchObject({ accountId: 17, channels: { private: 1, public: 1, total: 2 },
      blocks: { private: 1, public: 1, total: 2 }, coverage: { reported: 2, read: 2, complete: true } });
    const text = await run("ratio");
    expect(text.out).toContain("Read all 2 blocks Are.na reports for this account.");
    expect((await run("ratio", "--overlap", "both")).code).toBe(1);
    for (const output of [json.out, json.err, text.out, text.err]) expect(output).not.toContain(token);
    expect(seen.every(line => line.startsWith("GET "))).toBe(true);
  } finally { server.stop(true); }
});
