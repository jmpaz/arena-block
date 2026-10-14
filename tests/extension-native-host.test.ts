import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { webPlan } from "../packages/core/capture.ts";
import { composePlan } from "../packages/core/compose.ts";
import { handle } from "../extension/native-host.ts";

function frame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

test("native host save uses a retained ID and never returns the daemon bearer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arena-block-host-test-"));
  const configPath = join(directory, "config.json");
  await writeFile(configPath, JSON.stringify({ schemaVersion: 1 }));
  const oldToken = process.env.ARENA_BLOCK_ACCESS_TOKEN;
  const oldEndpoint = process.env.ARENA_BLOCK_ENDPOINT;
  const oldConfig = process.env.ARENA_BLOCK_CONFIG;
  process.env.ARENA_BLOCK_ACCESS_TOKEN = "test-token";
  process.env.ARENA_BLOCK_ENDPOINT = "http://127.0.0.1:8790";
  process.env.ARENA_BLOCK_CONFIG = configPath;
  const calls: { path: string; body?: any }[] = [];
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-token");
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path: `${url.pathname}${url.search}`, body });
    return Response.json({ saveId: body.snapshot.saveId, phase: "prepared" }, { status: 202 });
  }) as typeof fetch;
  try {
    const saveId = crypto.randomUUID();
    const plan = webPlan({ url: "https://example.com/story" });
    const result = await handle({ id: "b", action: "save", saveId, plan, destinations: ["test-channel"] }, fakeFetch);
    expect(result).toEqual({ saveId, phase: "prepared" });
    expect(JSON.stringify(result)).not.toContain("test-token");
    expect(calls.map(call => call.path)).toEqual(["/v1/saves?async=1"]);
    expect(calls[0]?.body.snapshot.saveId).toBe(saveId);
    expect(calls[0]?.body.snapshot.routing.destinations).toEqual(["test-channel"]);
    expect(calls[0]?.body.snapshot.origin).toBe("cli");
  } finally {
    if (oldToken === undefined) delete process.env.ARENA_BLOCK_ACCESS_TOKEN; else process.env.ARENA_BLOCK_ACCESS_TOKEN = oldToken;
    if (oldEndpoint === undefined) delete process.env.ARENA_BLOCK_ENDPOINT; else process.env.ARENA_BLOCK_ENDPOINT = oldEndpoint;
    if (oldConfig === undefined) delete process.env.ARENA_BLOCK_CONFIG; else process.env.ARENA_BLOCK_CONFIG = oldConfig;
    await rm(directory, { recursive: true, force: true });
  }
});

test("native host checks Forum Magnum capability before submitting a save", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arena-block-host-capability-"));
  const configPath = join(directory, "config.json");
  await writeFile(configPath, JSON.stringify({ schemaVersion: 1 }));
  const oldToken = process.env.ARENA_BLOCK_ACCESS_TOKEN;
  const oldEndpoint = process.env.ARENA_BLOCK_ENDPOINT;
  const oldConfig = process.env.ARENA_BLOCK_CONFIG;
  process.env.ARENA_BLOCK_ACCESS_TOKEN = "test-token";
  process.env.ARENA_BLOCK_ENDPOINT = "http://127.0.0.1:8790";
  process.env.ARENA_BLOCK_CONFIG = configPath;
  let capabilities: string[] = [];
  const calls: string[] = [];
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method} ${url.pathname}${url.search}`);
    if (url.pathname === "/v1/version") return Response.json({ version: "0.1.0", revision: null, sourceId: "fixture",
      platform: "fixture", schemaVersion: 1, packagePath: null, planCapabilities: capabilities });
    const body = JSON.parse(String(init?.body));
    return Response.json({ saveId: body.snapshot.saveId, phase: "prepared" }, { status: 202 });
  }) as typeof fetch;
  try {
    const saveId = crypto.randomUUID();
    const plan = composePlan([{ provider: "forum_magnum", id: "commentA",
      canonicalUrl: "https://www.lesswrong.com/posts/postA/?commentId=commentA",
      author: { handle: "writer" }, text: "A public comment", storyTitle: "A post", media: [] }]);
    const request = { id: "forum", action: "save" as const, saveId, plan, destinations: ["test-channel"] };
    await expect(handle(request, fakeFetch)).rejects.toThrow("No save was submitted");
    expect(calls).toEqual(["GET /v1/version"]);
    capabilities = ["forum-magnum-posts-v1"];
    const result = await handle(request, fakeFetch);
    expect(result).toEqual({ saveId, phase: "prepared" });
    expect(calls).toEqual(["GET /v1/version", "GET /v1/version", "POST /v1/saves?async=1"]);
    const combined = composePlan([
      ...Array.from({ length: 21 }, (_, index) => ({ provider: "x" as const, id: String(index + 1),
        canonicalUrl: `https://x.com/writer/status/${index + 1}`, author: { handle: "writer" },
        text: `Part ${index + 1}`, media: [] })),
      plan.sources[0]!,
    ], { threadExpansion: "on" });
    const combinedId = crypto.randomUUID();
    const combinedRequest = { id: "combined", action: "save" as const, saveId: combinedId,
      plan: combined, destinations: ["test-channel"] };
    await expect(handle(combinedRequest, fakeFetch)).rejects.toThrow("No save was submitted");
    expect(calls.at(-1)).toBe("GET /v1/version");
    capabilities = ["forum-magnum-posts-v1", "expanded-source-count-32-v1"];
    expect(await handle(combinedRequest, fakeFetch)).toEqual({ saveId: combinedId, phase: "prepared" });
    expect(calls.slice(-2)).toEqual(["GET /v1/version", "POST /v1/saves?async=1"]);
  } finally {
    if (oldToken === undefined) delete process.env.ARENA_BLOCK_ACCESS_TOKEN; else process.env.ARENA_BLOCK_ACCESS_TOKEN = oldToken;
    if (oldEndpoint === undefined) delete process.env.ARENA_BLOCK_ENDPOINT; else process.env.ARENA_BLOCK_ENDPOINT = oldEndpoint;
    if (oldConfig === undefined) delete process.env.ARENA_BLOCK_CONFIG; else process.env.ARENA_BLOCK_CONFIG = oldConfig;
    await rm(directory, { recursive: true, force: true });
  }
});

test("native messaging rejects unknown actions before contacting a daemon", async () => {
  const child = Bun.spawn(["bun", "extension/native-host.ts"], {
    cwd: join(import.meta.dir, ".."), stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: { PATH: process.env.PATH ?? "" },
  });
  child.stdin.write(frame({ id: "bad", action: "fetch", url: "https://example.com" }));
  child.stdin.end();
  const [output, exit] = await Promise.all([new Response(child.stdout).arrayBuffer(), child.exited]);
  expect(exit).toBe(0);
  const buffer = Buffer.from(output);
  const length = buffer.readUInt32LE(0);
  const reply = JSON.parse(buffer.subarray(4, 4 + length).toString("utf8"));
  expect(reply.ok).toBe(false);
  expect(reply.value).toBeUndefined();
});
