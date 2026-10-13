import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { composePlan, planHash } from "../src/compose.ts";
import { blockPlanSchema } from "../src/types.ts";
import { captureRenderRecipe, MosaicLayoutError } from "../packages/core/render-recipe.ts";
import { prepareSaveIntent } from "../src/save-intent.ts";
import { userConfigSchema } from "../src/config.ts";
import { ArenaClient, ArenaPublisher } from "../src/arena.ts";
import { ArenaBlockStore } from "../src/store.ts";
import { SaveGateway } from "../src/save-gateway.ts";
import { MockApi } from "./fixtures/remote-api.ts";
import frozen from "./fixtures/x-danhollick-qr-thread-plan.json";

const original = blockPlanSchema.parse(frozen);
const probes = { "10.1": { width: 1280, height: 720, duration: 13.73, fps: 30.008, audio: false } };
const replan = () => composePlan(original.sources, original.policy);
const directory = await mkdtemp(join(tmpdir(), "arena-mixed-recovery-"));
afterAll(() => rm(directory, { recursive: true, force: true }));
const id = "e5b776f3-4d60-446b-8a18-14fdc7a66e8f";
const config = userConfigSchema.parse({ defaultChannel: { channel: "901", mode: "always" }, provenance: { remoteSnapshot: "full" } });
const retained = prepareSaveIntent(original, config, { origin: "cli", initiator: { kind: "human" }, operation: "publish", destinations: ["901"], saveId: id });
const failure = { code: "media_budget", message: "Mosaic selection is too dense for a legible 1920x1918 composition. Keep every image with local render --layout reading --output-dir <path>, or choose --layout wallpaper for an overview that may require zoom. Neither preview publishes a block.", retryable: false };

const status = (overrides = {}) => ({ operationId: id, saveId: id, phase: "not_saved", active: false, cancelRequested: false,
  failure, authentication: { accountId: 47, credentialProfile: "shared", authenticatedAccountVerified: true }, ...overrides });

test("the exact retained QR thread keeps its hash and still fails its frozen layout", () => {
  const before = JSON.stringify(original);
  const { hash, ...body } = original;
  expect(planHash(body)).toBe(hash);
  expect(() => captureRenderRecipe(original, probes)).toThrow(MosaicLayoutError);
  expect(() => captureRenderRecipe(original, probes)).toThrow("1920x1918");
  expect(() => captureRenderRecipe(original, probes)).not.toThrow("choose --layout wallpaper");
  expect(JSON.stringify(original)).toBe(before);
});

test("new mixed-media plans retain all 17 posts, 14 images, the animation, writing, quotes and policy", () => {
  const before = JSON.stringify(original), next = replan(), recipe = captureRenderRecipe(next, probes)!;
  expect(next.hash).toBe("266c0cfa0c9ccc972c9042702a2c56a4bb59b7be546ea58e75e23dce2c2868c8");
  expect(next.sources).toEqual(original.sources); expect(next.policy).toEqual(original.policy);
  expect(next.sources).toHaveLength(17);
  expect(next.block.selectedMedia).toEqual(original.block.selectedMedia);
  const { layout: _old, ...oldBlock } = original.block, { layout: _new, ...newBlock } = next.block;
  expect(newBlock).toEqual(oldBlock);
  expect(recipe).toMatchObject({ width: 1920, height: 1612, duration: 13.73, audio: [] });
  expect(recipe.tiles.filter(tile => tile.kind === "image")).toHaveLength(14);
  expect(recipe.tiles.filter(tile => tile.kind === "video")).toHaveLength(1);
  expect(recipe.tiles.map(tile => tile.ref)).toEqual(original.block.selectedMedia);
  expect(Math.min(...recipe.tiles.map(tile => Math.min(tile.rect.width, tile.rect.height)))).toBe(320);
  for (const tile of recipe.tiles) {
    expect(tile.rect.x + tile.rect.width).toBeLessThanOrEqual(recipe.width);
    expect(tile.rect.y + tile.rect.height).toBeLessThanOrEqual(recipe.height);
  }
  expect(replan()).toEqual(next); expect(JSON.stringify(original)).toBe(before);
});

test("already-valid mixed layouts retain their hashes from b1ca4d1", () => {
  const post = {provider:"x" as const,id:"1",canonicalUrl:"https://x.com/fixture/status/1",author:{handle:"fixture"},text:"Source prose",media:[
    {ref:"1.1",kind:"video" as const,url:"https://example.test/v.mp4",width:1280,height:720,alt:""},
    {ref:"1.2",kind:"image" as const,url:"https://example.test/i.jpg",width:2024,height:1012,alt:""}]};
  expect(composePlan([post],{media:"all"}).hash).toBe("9cb9d95729333463b0db2a03bf6edee42b5a664176789ca755fb3e1d31553c67");
  expect(composePlan([post],{media:"all",mediaOrder:["1.2","1.1"]}).hash).toBe("0ebdfe7ef48496319c2a54d5abb4ef61d2fe541d1b7764d5f2f65a4c13624ed9");
});

test("mixed fallback retains an explicit complete reverse order and still rejects impossible aspect ratios", () => {
  const order = [...original.block.selectedMedia].reverse();
  const next = composePlan(original.sources, { ...original.policy, mediaOrder: order });
  expect(captureRenderRecipe(next, probes)!.tiles.map(tile => tile.ref)).toEqual(order);
  const extreme = structuredClone(original.sources.slice(0, 1));
  extreme[0]!.media = [{ ...original.sources[9]!.media[0]!, ref: "1.1", width: 1, height: 100000 },
    { ...original.sources[0]!.media[0]!, ref: "1.2", width: 100000, height: 1 }];
  const impossible = composePlan(extreme, { media: "all" });
  expect(impossible.block.selectedMedia).toEqual(["1.1", "1.2"]);
  expect(() => captureRenderRecipe(impossible, { "1.1": { width: 1, height: 100000, duration: 1, fps: 30, audio: false } })).toThrow(MosaicLayoutError);
});

async function cli(args: string[], scenario = "valid") {
  const name = crypto.randomUUID(), preload = join(directory, name + ".ts"), ledger = join(directory, name + ".json");
  const data = { snapshot: structuredClone(retained.snapshot), snapshotSha256: retained.snapshotSha256, remoteMode: "full" };
  if (scenario === "redacted") data.snapshot.fidelity.originalPlanPreserved = false;
  if (scenario === "unchanged") data.snapshot.plan = replan();
  if (scenario === "tampered") data.snapshot.plan.block.markdown = "Changed";
  if (scenario === "adapter") data.snapshot.origin = "mcp-local";
  if (scenario === "edited") {
    data.snapshot.plan.block.title = "Reviewed title";
    data.snapshot.plan.block.markdown = "Reviewed writing";
    data.snapshot.plan.block.description = "Reviewed description";
    const {hash: _hash, ...body} = data.snapshot.plan; data.snapshot.plan.hash = planHash(body);
  }
  if (scenario === "selection") {
    data.snapshot.plan.block.selectedMedia.pop();
    const {hash: _hash, ...body} = data.snapshot.plan; data.snapshot.plan.hash = planHash(body);
  }
  await Bun.write(preload, `${scenario === "exact-source" ? `const {SocialResolver}=await import(${JSON.stringify(new URL("../src/providers/index.ts", import.meta.url).href)});SocialResolver.prototype.resolveComposition=async(refs,extra,policy)=>{if(refs[0]!==${JSON.stringify(original.block.canonicalSource)}||extra.length||policy.media!=="all"||policy.threadExpansion!=="on")throw new Error("Changed acquisition intent");return {posts:${JSON.stringify(original.sources)},policy:${JSON.stringify(original.policy)}};};` : ""}const calls=[];let reads=0;globalThis.fetch=async(input,init)=>{
    const url=new URL(String(input)),path=url.pathname,method=init?.method??"GET";
    calls.push({path,method,...(init?.body?{body:JSON.parse(init.body)}:{})});await Bun.write(${JSON.stringify(ledger)},JSON.stringify(calls));
    if(path==="/v1/saves/${id}/intent")return Response.json(${JSON.stringify(data)});
    if(path==="/v1/saves/${id}"){reads++;return Response.json(${JSON.stringify(scenario === "unsafe" ? status({ phase: "unknown" }) : scenario === "active" ? status({ active: true }) : status())});}
    if(path==="/v1/save-policy")return Response.json({credential:{profile:"shared",arenaTokenEnv:"ARENA_WRITE_ACCESS_TOKEN"},mcpPublishingEnabled:false});
    if(path==="/v1/saves"){const input=JSON.parse(init.body),submitted=input.snapshot.saveId;return Response.json(${JSON.stringify(scenario)}==="exact-source"?{...${JSON.stringify(status())},operationId:submitted,saveId:submitted,phase:"saved",failure:undefined,receipt:{id:"fixture-receipt",planHash:input.plan.hash,blockId:123,blockUrl:"https://www.are.na/block/123",destinations:input.snapshot.routing.destinations,connectionIds:[],status:"verified",createdAt:"2026-10-13T17:00:00Z",updatedAt:"2026-10-13T17:00:00Z"}}:{...${JSON.stringify(status())},operationId:submitted,saveId:submitted},{status:202});}
    throw new Error("Unexpected request:"+path);
  };`);
  if (scenario === "race") {
    const script = await Bun.file(preload).text();
    await Bun.write(preload, script.replace(`return Response.json(${JSON.stringify(status())});`, `return Response.json(reads===1?${JSON.stringify(status())}:${JSON.stringify(status({ active: true }))});`));
  }
  const child = Bun.spawn([Bun.which("bun")!, "--preload", preload, "src/cli.ts", ...args], { env: { ...process.env, HOME: directory,
    ARENA_BLOCK_ENDPOINT: "https://fixture.invalid", ARENA_BLOCK_ACCESS_TOKEN: "fixture-only", ARENA_BLOCK_DEFAULT_CHANNELS: "", ARENA_BLOCK_PROVENANCE_DIR: join(directory, "provenance") }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code, calls: await Bun.file(ledger).exists() ? await Bun.file(ledger).json() : [] };
}

test("replan-save reads only the retained source snapshot, creates a private new plan, and preserves the original", async () => {
  const path = join(directory, "recovered.json"), before = JSON.stringify(retained);
  const result = await cli(["replan-save", id, "--output", path]);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ originalSaveId: id, originalPlanHash: original.hash, planHash: replan().hash, published: false, destinations: ["901"] });
  expect(await Bun.file(path).json()).toEqual(replan());
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(result.calls).toEqual([{path:`/v1/saves/${id}`,method:"GET"},{path:`/v1/saves/${id}/intent`,method:"GET"},{path:`/v1/saves/${id}`,method:"GET"}]);
  expect(result.stderr).toContain("new save UUID"); expect(JSON.stringify(retained)).toBe(before);
  const again = await cli(["replan-save", id, "--output", path]); expect(again.code).toBe(1);
  expect(await Bun.file(path).json()).toEqual(replan());
});

test.each(["unsafe", "active", "race", "redacted", "unchanged", "tampered", "adapter", "selection"])("replan-save refuses %s recovery without writing or publishing", async scenario => {
  const path = join(directory, scenario + ".json"), result = await cli(["replan-save", id, "--output", path], scenario);
  expect(result.code).toBe(1); expect(await Bun.file(path).exists()).toBe(false);
  expect(result.calls.every((call: {method: string}) => call.method === "GET")).toBe(true);
});

test("replanning preserves approved title,description and writing while changing only geometry", async () => {
  const path = join(directory, "edited.json"), result = await cli(["replan-save", id, "--output", path], "edited");
  expect(result.code).toBe(0);
  const plan = await Bun.file(path).json();
  expect(plan.block).toMatchObject({title:"Reviewed title",markdown:"Reviewed writing",description:"Reviewed description"});
  expect(plan.sources).toEqual(original.sources); expect(plan.policy).toEqual(original.policy);
  expect(plan.block.selectedMedia).toEqual(original.block.selectedMedia);
  expect(plan.block.quoteCoverage).toEqual(original.block.quoteCoverage);
  expect(captureRenderRecipe(plan,probes)!.tiles).toHaveLength(15);
});

test.each([false, true])("a dense publishing failure gives a usable replanning command and no futile retry (human:%s)", async human => {
  const path = join(directory, "frozen.json"); await Bun.write(path, JSON.stringify(original));
  const result = await cli(["publish", "--plan", path, "--to", "901", ...(human ? ["--human", "--verbose"] : [])]);
  expect(result.code).toBe(1);
  const submitted = result.calls.find((call: {method: string}) => call.method === "POST").body.snapshot.saveId;
  expect(result.stderr).toContain(`arena-block replan-save ${submitted} --output <new-plan.json>`);
  expect(result.stderr).not.toContain("arena-block retry-save");
  expect(result.stderr).not.toContain("local render --layout reading");
  expect(result.stderr).not.toContain("choose --layout wallpaper");
  expect(result.stderr).toContain("1920x1918");
  expect(result.calls.filter((call: {method: string}) => call.method === "POST")).toHaveLength(1);
});

test("help uses ASCII ranges, x.com and Delvetown without promising publish layout options", async () => {
  const result = await cli(["publish", "--help"]);
  expect(result.code).toBe(0); expect(result.stdout).toContain("Delvetown"); expect(result.stdout).toContain("x.com/AT Protocol");
  expect(result.stdout).toContain("1-600"); expect(result.stdout).toContain("0-8"); expect(result.stdout).not.toContain("--layout");
  expect(result.stdout).not.toMatch(/[–�]/);
});

test("the exact reported command composes all captured media and submits one new immutable save", async () => {
  const result = await cli(["publish", "--media", "all", "--to", "https://www.are.na/josh-pazmino/inbox-pfzlyqs4uuc", original.block.canonicalSource, "--thread-expansion", "on"], "exact-source");
  expect(result.code).toBe(0); expect(result.stderr).toBe("");
  const submits = result.calls.filter((call: {method: string}) => call.method === "POST");
  expect(submits).toHaveLength(1); expect(submits[0].body.plan).toEqual(replan());
  expect(submits[0].body.snapshot.plan).toEqual(replan());
  expect(submits[0].body.snapshot.saveId).not.toBe(id);
  expect(submits[0].body.snapshot.invocation.inputs.sourceRefs).toEqual([original.block.canonicalSource]);
  expect(submits[0].body.snapshot.routing.destinations).toEqual(["inbox-pfzlyqs4uuc"]);
  expect(JSON.parse(result.stdout)).toMatchObject({status:"verified",planHash:replan().hash});
});

test("mocked publication creates the new layout once and replays the same UUID without duplicate blocks", async () => {
  const root = join(directory, "publisher"), store = new ArenaBlockStore(join(root, "state.sqlite"), { private: true });
  const api = new MockApi(), client = new ArenaClient("fixture-only", "https://arena.invalid/v3", async (...args) => { const reply = await api.fetch(...args);
    if (args[1]?.method === "POST" && new URL(String(args[0])).pathname === "/v3/blocks") for (const block of api.blocks.values()) block.type = "Attachment";
    return reply; }, 100);
  const policy = { inboxChannel: "901", mode: "full" as const, credentialProfile: "shared", expectedAccountId: 47 };
  let renders = 0;
  const publisher = new ArenaPublisher(client, store, { publicBaseUrl: "https://fixture.invalid", mediaDirectory: root, remoteProvenance: policy,
    render: async plan => { renders++; expect(captureRenderRecipe(plan, probes)!.tiles).toHaveLength(15); return { hash: "a".repeat(64), path: join(root,"mock.mp4"), extension: "mp4", mimeType: "video/mp4", size: 255557 }; } });
  const gateway = new SaveGateway(client, publisher, store, { profile: "shared", expectedAccountId: 47 }, policy, 5000);
  try {
    await expect(gateway.save({plan:original,snapshot:retained.snapshot,snapshotSha256:retained.snapshotSha256,remoteMode:"full"},"cli")).rejects.toThrow("1920x1918");
    expect(gateway.status(id)).toMatchObject({phase:"not_saved",active:false}); expect(api.creates()).toBe(0);
    const frozenContext = structuredClone(store.saveContext(id));
    const next = replan(), intent = prepareSaveIntent(next, config, { origin: "cli", initiator: { kind: "human" }, operation: "publish", destinations: ["901"] });
    const input = { plan: next, snapshot: intent.snapshot, snapshotSha256: intent.snapshotSha256, remoteMode: "full" as const };
    const first = await gateway.save(input, "cli"), second = await gateway.save(input, "cli");
    expect(first.phase).toBe("saved"); expect(second.receipt!.blockId).toBe(first.receipt!.blockId);
    expect(api.creates()).toBe(1); expect(renders).toBe(2);
    expect(store.saveContext(id)).toEqual(frozenContext); expect(gateway.status(id).phase).toBe("not_saved");
    expect(api.blocks.get(first.receipt!.blockId)!.description.markdown).toBe(next.block.markdown);
    expect(store.saveContext(intent.snapshot.saveId)!.submission.plan).toEqual(next);
    expect(JSON.stringify(original)).toBe(JSON.stringify(blockPlanSchema.parse(frozen)));
  } finally { await gateway.close(); store.close(); }
});
