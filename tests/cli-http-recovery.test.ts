import { afterEach, expect, test } from "bun:test";
import { ArenaBlockClient, OwnerHttpError, PublicationError } from "../src/client.ts";
import { composePlan } from "../src/compose.ts";
import { prepareSaveIntent } from "../src/save-intent.ts";
import { userConfigSchema } from "../src/config.ts";
import { checkVideoInputBudget, MediaBudgetError } from "../src/render.ts";
import { createService } from "../src/service.ts";
import { ArenaClient } from "../src/arena.ts";
import { MockApi } from "./fixtures/remote-api.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const plan = composePlan([{ provider: "x", id: "1", canonicalUrl: "https://x.com/fixture/status/1",
  author: { handle: "fixture" }, text: "A synthetic test post", media: [] }], { media: "none" });
const intent = prepareSaveIntent(plan, userConfigSchema.parse({ defaultDestinations: [], provenance: { local: false, remoteSnapshot: "none" } }),
  { origin: "cli", initiator: { kind: "human" }, operation: "publish", destinations: ["fixture"] });
const id = intent.snapshot.saveId;
const receipt = { id: crypto.randomUUID(), planHash: plan.hash, blockId: 42, blockUrl: "https://www.are.na/block/42",
  destinations: ["fixture"], connectionIds: [7], status: "verified", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
const status = (phase: string, active = false, extra: Record<string, unknown> = {}) => ({ operationId: id, saveId: id, phase, active,
  cancelRequested: false, authentication: { accountId: 47, credentialProfile: "shared", authenticatedAccountVerified: true }, ...extra });
const json = (value: unknown, httpStatus = 200, headers: Record<string, string> = {}) => Response.json(value, { status: httpStatus, headers });

test("non-JSON owner responses preserve HTTP status, content type and body class without leaking HTML", async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response("<html>private proxy page</html>", { status: 524, headers: { "content-type": "text/html" } }); }) as unknown as typeof fetch;
  const client = new ArenaBlockClient("https://owner.invalid", "fixture-token");
  const input = { plan, snapshot: intent.snapshot, snapshotSha256: intent.snapshotSha256 };
  try { await client.save(input); throw new Error("Expected rejection"); }
  catch (error) {
    expect(error).toBeInstanceOf(OwnerHttpError);
    expect(error).toMatchObject({ status: 524, contentType: "text/html", bodyClass: "html" });
    expect((error as Error).message).not.toContain("private proxy page");
  }
  expect(calls).toBe(1); // No blind repeat of a POST.
});

test("HTML with HTTP 200 is rejected as an unreadable owner response", async () => {
  globalThis.fetch = (async () => new Response("<!doctype html><title>proxy</title>", { status: 200,
    headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
  await expect(new ArenaBlockClient("https://owner.invalid", "fixture-token").save({ plan, snapshot: intent.snapshot,
    snapshotSha256: intent.snapshotSha256 })).rejects.toMatchObject({ status: 200, contentType: "text/html", bodyClass: "html" });
});

test("safe status GET honors transient 429 and 5xx before returning retained state", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    if (calls === 1) return new Response("<html>rate limited</html>", { status: 429, headers: { "content-type": "text/html", "retry-after": "0" } });
    if (calls === 2) return json({ error: "temporary" }, 503, { "retry-after": "0" });
    return json(status("saved", false, { receipt }));
  }) as unknown as typeof fetch;
  const value = await new ArenaBlockClient("https://owner.invalid", "fixture-token").saveStatus(id);
  expect(value.phase).toBe("saved"); expect(calls).toBe(3);
});

test("HTML from a timed-out save response checks the same ID and returns a delayed success", async () => {
  const requests: string[] = [];
  globalThis.fetch = (async (input: any) => {
    const path = new URL(String(input)).pathname + new URL(String(input)).search;
    requests.push(path);
    if (path === "/v1/saves?async=1") return new Response("<html>gateway timeout</html>", { status: 524, headers: { "content-type": "text/html" } });
    return json(status("saved", false, { receipt }));
  }) as unknown as typeof fetch;
  const result = await new ArenaBlockClient("https://owner.invalid", "fixture-token").publishIntent(plan, intent);
  expect(result.blockId).toBe(42);
  expect(requests.filter(path => path === "/v1/saves?async=1")).toHaveLength(1);
  expect(requests).toContain(`/v1/saves/${id}`);
});

test("async save polls through slow rendering and never submits a second save", async () => {
  const requests: string[] = []; let reads = 0;
  globalThis.fetch = (async (input: any) => {
    const path = new URL(String(input)).pathname + new URL(String(input)).search;
    requests.push(path);
    if (path === "/v1/saves?async=1") return json(status("running", true), 202);
    reads++;
    return json(reads === 1 ? status("running", true) : status("saved", false, { receipt }));
  }) as unknown as typeof fetch;
  expect((await new ArenaBlockClient("https://owner.invalid", "fixture-token").publishIntent(plan, intent)).blockId).toBe(42);
  expect(requests.filter(path => path === "/v1/saves?async=1")).toHaveLength(1);
  expect(reads).toBe(2);
});

test("only a journal-proven pre-create interruption can auto-replay its original UUID", async () => {
  const requests: string[] = []; let reads = 0;
  globalThis.fetch = (async (input: any) => {
    const path = new URL(String(input)).pathname + new URL(String(input)).search;
    requests.push(path);
    if (path === "/v1/saves?async=1") return json(status("running", true), 202);
    if (path.endsWith("/retry?async=1")) return json(status("saved", false, { receipt }), 202);
    reads++; return json(status("unknown"));
  }) as unknown as typeof fetch;
  expect((await new ArenaBlockClient("https://owner.invalid", "fixture-token").publishIntent(plan, intent)).blockId).toBe(42);
  expect(requests.filter(path => path.endsWith("/retry?async=1"))).toEqual([`/v1/saves/${id}/retry?async=1`]);
  expect(reads).toBe(2);
});

test("a known block or denied authorization never triggers automatic replay", async () => {
  let retries = 0;
  globalThis.fetch = (async (input: any) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/retry")) retries++;
    return path === "/v1/saves" ? json(status("unknown", false, { receipt }), 202) : json(status("unknown", false, { receipt }));
  }) as unknown as typeof fetch;
  await expect(new ArenaBlockClient("https://owner.invalid", "fixture-token").publishIntent(plan, intent)).rejects.toBeInstanceOf(PublicationError);
  expect(retries).toBe(0);
  globalThis.fetch = (async () => json({ error: "Forbidden" }, 403)) as unknown as typeof fetch;
  await expect(new ArenaBlockClient("https://owner.invalid", "fixture-token").publishIntent(plan, intent)).rejects.toThrow("Forbidden");
  expect(retries).toBe(0);
});

test("a retained media-budget failure stops without retrying or creating a block", async () => {
  let retries = 0;
  globalThis.fetch = (async (input: any) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/retry")) retries++;
    return json(status("not_saved", false, { failure: { code: "media_budget", message: "Selected video 2.1 exceeds the media budget" } }), path === "/v1/saves" ? 202 : 200);
  }) as unknown as typeof fetch;
  await expect(new ArenaBlockClient("https://owner.invalid", "fixture-token").publishIntent(plan, intent))
    .rejects.toThrow("Selected video 2.1 exceeds the media budget");
  expect(retries).toBe(0);
});

test("a retained deadline does not automatically repeat a long pre-create render", async () => {
  let retries = 0;
  globalThis.fetch = (async (input: any) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/retry")) retries++;
    return json(status("unknown", false, { failure: { code: "deadline", message: "Save exceeded the bounded service deadline" } }), path === "/v1/saves" ? 202 : 200);
  }) as unknown as typeof fetch;
  await expect(new ArenaBlockClient("https://owner.invalid", "fixture-token").publishIntent(plan, intent))
    .rejects.toThrow("Save exceeded the bounded service deadline");
  expect(retries).toBe(0);
});

test("an old verified receipt is not returned while its replay is still active", async () => {
  let reads = 0;
  globalThis.fetch = (async (input: any) => {
    const path = new URL(String(input)).pathname;
    if (path === "/v1/saves") return json(status("saved", true, { receipt }), 202);
    reads++;
    return json(status("saved", false, { receipt }));
  }) as unknown as typeof fetch;
  expect((await new ArenaBlockClient("https://owner.invalid", "fixture-token").publishIntent(plan, intent)).blockId).toBe(42);
  expect(reads).toBe(1);
});

test("cancelling a CLI wait stops polling without replaying or cancelling a committed owner save", async () => {
  const controller = new AbortController();
  let retries = 0, cancels = 0;
  globalThis.fetch = (async (input: any) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/retry")) retries++;
    if (path.endsWith("/cancel")) cancels++;
    if (path === "/v1/saves") queueMicrotask(() => controller.abort(new Error("User stopped waiting")));
    return json(status("running", true), path === "/v1/saves" ? 202 : 200);
  }) as unknown as typeof fetch;
  await expect(new ArenaBlockClient("https://owner.invalid", "fixture-token").publishIntent(plan, intent, undefined, controller.signal))
    .rejects.toThrow("User stopped waiting");
  expect(retries).toBe(0);
  expect(cancels).toBe(0);
});

test("oversized selected video is rejected before copying media or reserving a block", () => {
  expect(() => checkVideoInputBudget("2.1", 1701.886, 2_246_937_335)).toThrow(MediaBudgetError);
  expect(() => checkVideoInputBudget("2.1", 1701.886, 2_246_937_335)).toThrow("28 minutes");
  expect(() => checkVideoInputBudget("1.1", 112.043, 124_253_653)).not.toThrow();
  expect(() => checkVideoInputBudget("1.1", 112.043, undefined)).toThrow(MediaBudgetError);
  expect(() => checkVideoInputBudget("1.1", 112.043, Number.NaN)).toThrow(MediaBudgetError);
});

test("async owner route acknowledges a save while rendering waits, then retains its result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arena-async-route-"));
  const api = new MockApi();
  const client = new ArenaClient("fixture", "https://arena.invalid/v3", (...args) => api.fetch(...args));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const service = createService({ host: "127.0.0.1", port: 8790, stateDirectory: directory, mediaDirectory: join(directory, "media"),
    publicBaseUrl: "https://fixture.invalid", accessToken: "owner", arenaToken: "fixture",
    credential: { schemaVersion: 1, profile: "shared", arenaTokenEnv: "ARENA_WRITE_ACCESS_TOKEN", expectedAccountId: 47 } },
  { client, render: async () => { await gate; return undefined; } });
  const selected = prepareSaveIntent(plan, userConfigSchema.parse({ credentialProfiles: { shared: { arenaTokenEnv: "ARENA_WRITE_ACCESS_TOKEN", expectedAccountId: 47 } } }),
    { origin: "cli", initiator: { kind: "human" }, operation: "publish", destinations: ["901"] });
  const input = { plan, snapshot: selected.snapshot, snapshotSha256: selected.snapshotSha256 };
  const request = (path: string, method = "GET", body?: unknown) => service.handler(new Request(`https://fixture.invalid${path}`,
    { method, headers: { authorization: "Bearer owner", ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }));
  try {
    const accepted = await request("/v1/saves?async=1", "POST", input);
    expect(accepted.status).toBe(202);
    expect((await accepted.json()).saveId).toBe(selected.snapshot.saveId);
    expect(api.creates()).toBe(0);
    release();
    let phase = "running";
    for (let attempt = 0; attempt < 30 && phase !== "saved"; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      phase = (await (await request(`/v1/saves/${selected.snapshot.saveId}`)).json()).phase;
    }
    expect(phase).toBe("saved");
    expect(api.creates()).toBe(1);
    const changed = prepareSaveIntent(plan, userConfigSchema.parse({ credentialProfiles: { shared: { arenaTokenEnv: "ARENA_WRITE_ACCESS_TOKEN", expectedAccountId: 47 } } }),
      { origin: "cli", initiator: { kind: "human" }, operation: "publish", destinations: ["902"], saveId: selected.snapshot.saveId });
    const rejected = await request("/v1/saves?async=1", "POST", { plan, snapshot: changed.snapshot, snapshotSha256: changed.snapshotSha256 });
    expect(rejected.status).toBe(422);
    expect((await rejected.json()).error).toContain("immutable intent");
    expect(api.creates()).toBe(1);
  } finally { release(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});
