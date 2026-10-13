import { expect, test } from "bun:test";
import { resolveCapture } from "../extension/src/core.ts";
import { BrowserSaver, browserCanPublish, routeBrowserDestinations, type BrowserSaveIntent } from "../extension/src/browser-save.ts";
import { BrowserOAuth } from "../extension/src/browser-auth.ts";
import { composePlan } from "../packages/core/compose.ts";

function fixture() {
  const intents = new Map<string, BrowserSaveIntent>();
  const calls: Array<{ url: string; method: string; body?: any }> = [];
  let postMode: "ok" | "ambiguous" | "reject" | "hang" = "ok";
  let account = 42;
  let blockFields: Record<string, any> = {};
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input), method = init?.method ?? "GET";
    calls.push({ url, method, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (url.endsWith("/me")) return Response.json({ data: { id: account } });
    if (url.endsWith("/channels/one")) return Response.json({ data: { id: 10 } });
    if (url.endsWith("/channels/two")) return Response.json({ data: { id: 20 } });
    if (url.endsWith("/blocks") && method === "POST") {
      if (postMode === "hang") return new Promise<Response>(() => {});
      if (postMode === "ambiguous") throw new TypeError("transport closed after write");
      if (postMode === "reject") return new Response(null, { status: 403 });
      const payload = JSON.parse(String(init?.body));
      blockFields = { type: String(payload.value).startsWith("arena-block text ") ? "Text" : "Link",
        title: payload.title, description: payload.description ?? null, content: payload.value };
      return Response.json({ data: { id: 900 } });
    }
    if (url.endsWith("/blocks/900")) {
      if (method === "PUT") Object.assign(blockFields, JSON.parse(String(init?.body)));
      return Response.json({ data: { id: 900, state: "available", type: "Link", ...blockFields } });
    }
    if (url.includes("/blocks/900/connections")) return Response.json({ data: [{ id: 10 }, { id: 20 }],
      meta: { current_page: 1, total_pages: 1, has_more_pages: false } });
    throw new Error(`Unexpected request ${method} ${url}`);
  }) as typeof fetch;
  const store = {
    async get(id: string) { return intents.get(id); },
    async put(intent: BrowserSaveIntent) { intents.set(intent.saveId, structuredClone(intent)); },
  };
  const restart = () => new BrowserSaver({ async token() { return "fake-token"; } }, store, fetcher);
  return { saver: restart(), restart, intents, store, fetcher, calls,
    setMode(mode: typeof postMode) { postMode = mode; }, setAccount(id: number) { account = id; } };
}

test("default channel uses CLI fallback and always semantics", () => {
  expect(routeBrowserDestinations([], { channel: "one", mode: "fallback" })).toEqual(["one"]);
  expect(routeBrowserDestinations(["two"], { channel: "one", mode: "fallback" })).toEqual(["two"]);
  expect(routeBrowserDestinations(["two"], { channel: "one", mode: "always" })).toEqual(["one", "two"]);
  expect(routeBrowserDestinations(["one"], { channel: "one", mode: "always" })).toEqual(["one"]);
});

test("direct browser text creation finalizes exact URL-leading writing after staging", async () => {
  const f = fixture();
  const plan = composePlan([{ provider: "x", id: "7", canonicalUrl: "https://x.com/fixture/status/7",
    author: { handle: "fixture" }, text: "https://example.com/reference writes about field notes. Café 👋", media: [] }]);
  await f.saver.prepare("text-staging", plan, ["one"]);
  expect((await f.saver.create("text-staging")).phase).toBe("saved");
  const create = f.calls.find(call => call.method === "POST")!.body;
  expect(create.value).toBe(`arena-block text ${plan.hash}`);
  const update = f.calls.find(call => call.method === "PUT")!.body;
  expect(update.content).toBe(plan.block.markdown);
  expect(update.description).toBe("");
  expect(f.intents.get("text-staging")!.plan.sources).toEqual(plan.sources);
});

test("a restarted browser verifies a lost update response without another PUT or POST", async () => {
  const f = fixture(), fetch = f.fetcher;
  const saver = new BrowserSaver({ async token() { return "fake-token"; } }, f.store,
    (async (input, init) => {
      const response = await fetch(input, init);
      if (init?.method === "PUT") throw new TypeError("Fixture lost update response");
      return response;
    }) as typeof fetch);
  const plan = await resolveCapture({ primary: ["https://example.com/article"], extras: [], policy: {} });
  await saver.prepare("lost-update", plan, ["one"]);
  expect((await saver.create("lost-update")).initialFields?.status).toBe("attempted");
  expect((await f.restart().check("lost-update")).phase).toBe("saved");
  expect(f.calls.filter(call => call.method === "PUT")).toHaveLength(1);
  expect(f.calls.filter(call => call.method === "POST")).toHaveLength(1);
});

test("direct browser save freezes plan, account, channels and verifies placement", async () => {
  const f = fixture();
  const plan = await resolveCapture({ primary: ["https://example.com/article"], extras: [], policy: {} });
  await f.saver.prepare("save-a", plan, ["two"], { channel: "one", mode: "always" });
  plan.block.title = "Later editor change";
  const outcome = await f.saver.create("save-a");
  expect(outcome.phase).toBe("saved");
  expect(outcome.blockId).toBe(900);
  expect(outcome.plan.block.title).not.toBe("Later editor change");
  expect(outcome.channelIds).toEqual([10, 20]);
  expect(f.calls.filter(call => call.method === "POST")).toHaveLength(1);
  expect(f.calls.find(call => call.method === "POST")?.body.channel_ids).toEqual([10, 20]);
  await f.saver.create("save-a");
  expect(f.calls.filter(call => call.method === "POST")).toHaveLength(1);
});

test("ambiguous browser POST never replays and wrong account cannot write", async () => {
  const f = fixture();
  const plan = await resolveCapture({ primary: ["https://example.com/article"], extras: [], policy: {} });
  await f.saver.prepare("save-b", plan, ["one"]);
  f.setAccount(43);
  await expect(f.saver.create("save-b")).rejects.toThrow("account changed");
  expect(f.calls.filter(call => call.method === "POST")).toHaveLength(0);
  f.setAccount(42);
  f.setMode("ambiguous");
  expect((await f.saver.create("save-b")).phase).toBe("unknown");
  expect((await f.saver.create("save-b")).phase).toBe("unknown");
  expect(f.calls.filter(call => call.method === "POST")).toHaveLength(1);
});

test("media composite falls back to helper and interrupted create becomes unknown", async () => {
  const media = await resolveCapture({ primary: ["https://x.com/author/status/3"], extras: [], policy: { media: "all", threadExpansion: "off" } },
    undefined, (async () => Response.json({ code: 200, tweet: { id: "3", author: { screen_name: "author" },
      text: "With image", media: { photos: [{ url: "https://example.test/image.jpg" }] } } })) as unknown as typeof fetch);
  expect(browserCanPublish(media)).toBe(false);
  const f = fixture();
  await expect(f.saver.prepare("media", media, ["one"])).rejects.toThrow("local helper");
  const plain = await resolveCapture({ primary: ["https://example.com/plain"], extras: [], policy: {} });
  const prepared = await f.saver.prepare("interrupted", plain, ["one"]);
  f.intents.set(prepared.saveId, { ...prepared, phase: "creating" });
  expect((await f.saver.check(prepared.saveId)).phase).toBe("unknown");
  expect(f.calls.filter(call => call.method === "POST")).toHaveLength(0);
});

test("checking a live background create does not prematurely mark its POST unknown", async () => {
  const f = fixture();
  const plan = await resolveCapture({ primary: ["https://example.com/plain"], extras: [], policy: {} });
  const prepared = await f.saver.prepare("still-creating", plan, ["one"]);
  f.intents.set(prepared.saveId, { ...prepared, phase: "creating", creatingAt: Date.now() });
  expect((await f.saver.check(prepared.saveId)).phase).toBe("creating");
  expect(f.calls.filter(call => call.method === "POST")).toHaveLength(0);
});

test("a late incomplete placement check cannot erase a saved receipt", async () => {
  const f = fixture();
  const plan = await resolveCapture({ primary: ["https://example.com/plain"], extras: [], policy: {} });
  await f.saver.prepare("placement-race", plan, ["one"]);
  await f.saver.create("placement-race");
  const saved = f.intents.get("placement-race")!;
  f.intents.set("placement-race", { ...saved, phase: "created" });
  let release: ((value: Response) => void) | undefined;
  let checks = 0;
  const held = new Promise<Response>(resolve => { release = resolve; });
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("/blocks/900/connections")) {
      checks++;
      return checks === 1 ? held : Response.json({ data: [{ id: 10 }],
        meta: { current_page: 1, total_pages: 1, has_more_pages: false } });
    }
    return f.fetcher(input, init);
  }) as typeof fetch;
  const saver = new BrowserSaver({ async token() { return "fake-token"; } }, f.store, fetcher);
  const first = saver.check("placement-race");
  for (let i = 0; i < 30 && checks < 1; i++) await Promise.resolve();
  expect(checks).toBe(1);
  expect((await saver.check("placement-race")).phase).toBe("saved");
  release!(Response.json({ data: [], meta: { current_page: 1, total_pages: 1, has_more_pages: false } }));
  expect((await first).phase).toBe("saved");
  expect(f.intents.get("placement-race")?.phase).toBe("saved");
});

test("a stopped worker cannot replay an interrupted POST through a fresh adapter", async () => {
  const f = fixture();
  const plan = await resolveCapture({ primary: ["https://example.com/plain"], extras: [], policy: {} });
  await f.saver.prepare("worker-stop", plan, ["one"]);
  f.setMode("hang");
  void f.saver.create("worker-stop");
  for (let attempt = 0; attempt < 30 &&
    (f.intents.get("worker-stop")?.phase !== "creating" || !f.calls.some(call => call.method === "POST")); attempt++)
    await Promise.resolve();
  const creating = f.intents.get("worker-stop");
  expect(creating?.phase).toBe("creating");
  expect(f.calls.filter(call => call.method === "POST")).toHaveLength(1);
  f.intents.set("worker-stop", { ...creating!, creatingAt: Date.now() - 31_000 });
  const afterRestart = f.restart();
  expect((await afterRestart.check("worker-stop")).phase).toBe("unknown");
  expect((await afterRestart.create("worker-stop")).phase).toBe("unknown");
  expect(f.calls.filter(call => call.method === "POST")).toHaveLength(1);
});

test("a definite authorization rejection can retry the same frozen intent", async () => {
  const f = fixture();
  const plan = await resolveCapture({ primary: ["https://example.com/plain"], extras: [], policy: {} });
  await f.saver.prepare("auth-retry", plan, ["one"]);
  f.setMode("reject");
  expect((await f.saver.create("auth-retry")).phase).toBe("rejected");
  f.setMode("ok");
  expect((await f.saver.create("auth-retry")).phase).toBe("saved");
  expect(f.calls.filter(call => call.method === "POST")).toHaveLength(2);
});

test("PKCE sign-in checks state and keeps token in per-user browser storage", async () => {
  const values = new Map<string, unknown>();
  let authorize: URL | undefined;
  const identity = { getRedirectURL: () => "https://extension.chromiumapp.org/",
    async launchWebAuthFlow({ url }: { url: string }) {
      authorize = new URL(url);
      return `https://extension.chromiumapp.org/?code=fake-code&state=${authorize.searchParams.get("state")}`;
    } };
  const storage = { async get(key: string) { return { [key]: values.get(key) }; },
    async set(entries: Record<string, unknown>) { for (const [key, value] of Object.entries(entries)) values.set(key, value); },
    async remove(key: string) { values.delete(key); } };
  const auth = new BrowserOAuth("public-client-id", identity, storage, (async (_url: string | URL | Request, init?: RequestInit) => {
    const params = new URLSearchParams(String(init?.body));
    expect(params.get("code_verifier")?.length).toBeGreaterThan(42);
    expect(params.get("client_secret")).toBeNull();
    return Response.json({ access_token: "per-user-token", scope: "write", expires_in: 3600 });
  }) as typeof fetch);
  await auth.signIn();
  expect(authorize?.searchParams.get("code_challenge_method")).toBe("S256");
  expect(await auth.token()).toBe("per-user-token");
  await auth.signOut();
  await expect(auth.token()).rejects.toThrow("Connect your Are.na account");
});
