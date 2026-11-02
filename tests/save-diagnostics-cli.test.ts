import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composePlan } from "../src/compose.ts";
import { prepareSaveIntent } from "../src/save-intent.ts";
import { userConfigSchema } from "../src/config.ts";

const root = await mkdtemp(join(tmpdir(), "arena-save-diagnosis-cli-"));
afterAll(() => rm(root, { recursive: true, force: true }));
const config = userConfigSchema.parse({ provenance: { local: false, remoteSnapshot: "none" } });
const plan = composePlan([{ provider: "x", id: "1", canonicalUrl: "https://x.com/example/status/1", author: { handle: "example" }, text: "Test post", media: [] }]);
const initialIntent = prepareSaveIntent(plan, config, { origin: "cli", initiator: { kind: "human" }, operation: "publish", destinations: ["missing-channel"] });

async function run(command: "save-status" | "publish", human = false) {
  const id = crypto.randomUUID(), configPath = join(root, `${id}-config.json`), planPath = join(root, `${id}-plan.json`);
  const preload = join(root, `${id}-preload.ts`), ledger = join(root, `${id}-calls.json`);
  await writeFile(configPath, JSON.stringify(config)); await writeFile(planPath, JSON.stringify(plan));
  await writeFile(preload, `
let intent=${JSON.stringify({ snapshot: initialIntent.snapshot, snapshotSha256: initialIntent.snapshotSha256 })};
const calls=[];
const status=()=>({saveId:intent.snapshot.saveId,operationId:intent.snapshot.saveId,phase:"not_saved",active:false,cancelRequested:false,authentication:{accountId:47,credentialProfile:"shared",authenticatedAccountVerified:true}});
globalThis.fetch=async(input,init)=>{
 const url=new URL(String(input)),path=url.pathname,method=init?.method??"GET";
 calls.push({path,method});await Bun.write(${JSON.stringify(ledger)},JSON.stringify(calls));
 if(path==="/v1/save-policy")return Response.json({credential:{profile:"shared",arenaTokenEnv:"ARENA_WRITE_ACCESS_TOKEN",expectedAccountId:47},mcpPublishingEnabled:true});
 if(path==="/v1/saves"&&method==="POST"){
  const body=JSON.parse(init.body);intent={snapshot:body.snapshot,snapshotSha256:body.snapshotSha256};return Response.json(status());
 }
 if(path==="/v1/saves/"+intent.snapshot.saveId)return Response.json(status());
 if(path==="/v1/saves/"+intent.snapshot.saveId+"/intent")return Response.json(intent);
 if(path==="/v1/channel-labels")return Response.json({error:"Are.na GET /channels/missing-channel returned 404"},{status:400});
 throw Error("Unexpected fixture request: "+method+" "+path);
};`);
  const args = command === "save-status" ? [command, initialIntent.snapshot.saveId]
    : [command, "--plan", planPath, "--to", "missing-channel", ...(human ? ["--human", "--verbose"] : ["--json"])];
  const child = Bun.spawn([process.execPath, "--preload", preload, "src/cli.ts", ...args], {
    env: { ...process.env, HOME: root, ARENA_BLOCK_CONFIG: configPath, ARENA_BLOCK_ENDPOINT: "https://fixture.invalid", ARENA_BLOCK_ACCESS_TOKEN: "fixture-only", ARENA_BLOCK_DEFAULT_CHANNELS: "" },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code, calls: JSON.parse(await readFile(ledger, "utf8")) as Array<{ method: string; path: string }> };
}

test("save-status adds a confirmed channel diagnosis without changing journal fields or writing", async () => {
  const result = await run("save-status");
  expect(result.code, result.stderr).toBe(0);
  const status = JSON.parse(result.stdout);
  expect(status).toMatchObject({ phase: "not_saved", active: false, diagnosis: { code: "destination_unavailable", channel: "missing-channel", httpStatus: 404, basis: "read_only_channel_lookup" } });
  expect(status.failure).toBeUndefined(); expect(status.receipt).toBeUndefined(); expect(status.attempt).toBeUndefined();
  expect(result.calls.every(call => call.method === "GET")).toBe(true);
  expect(result.calls.map(call => call.path)).toEqual([`/v1/saves/${initialIntent.snapshot.saveId}`, `/v1/saves/${initialIntent.snapshot.saveId}/intent`, "/v1/channel-labels"]);
});
for (const human of [true, false]) test(`publish ${human ? "human" : "JSON"} failures identify missing channels without suggesting a futile retry`, async () => {
  const result = await run("publish", human);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('Destination "missing-channel" is unavailable (Are.na HTTP 404).');
  expect(result.stderr).toContain("Status: arena-block save-status ");
  expect(result.stderr).not.toContain("retry-save");
  expect(result.calls.filter(call => call.method !== "GET")).toEqual([{ method: "POST", path: "/v1/saves" }]);
});
