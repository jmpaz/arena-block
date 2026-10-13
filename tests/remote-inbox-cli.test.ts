import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareSaveIntent } from "../src/save-intent.ts";
import { userConfigSchema } from "../src/config.ts";
import { composePlan } from "../src/compose.ts";

const root = await mkdtemp(join(tmpdir(), "arena-inbox-cli-"));
afterAll(() => rm(root, { recursive: true, force: true }));
const plan = composePlan([{ provider: "x", id: "1", canonicalUrl: "https://x.com/example/status/1", author: { handle: "example" }, text: "Original complete text", media: [] }]);
const planPath = join(root, "plan.json"); await writeFile(planPath, JSON.stringify(plan));
async function run(args: string[], config: unknown, mockPublication = false, input?: string, options: { journalFailure?: boolean; publicationMode?: "failed" | "lost"; storedIntent?: { snapshot: unknown; snapshotSha256: string } } = {}) {
  const id = crypto.randomUUID(), configPath = join(root, `${id}-config.json`), ledger = join(root, `${id}-calls.json`), preload = join(root, `${id}-preload.ts`), journal = join(root, `${id}-journal`);
  await writeFile(configPath, JSON.stringify(config));
  await writeFile(ledger, "[]");
  const fault = options.journalFailure ? `const fs=await import("node:fs/promises");const {mock}=await import("bun:test");mock.module("node:fs/promises",()=>({...fs,link:async()=>{throw new Error("fixture journal failure");}}));` : "";
  await writeFile(preload, `${fault}const stored=${JSON.stringify(options.storedIntent ?? null)};const calls=[];globalThis.fetch=async(input,init)=>{const path=new URL(String(input)).pathname; const body=init?.body?JSON.parse(init.body):undefined;calls.push({path,method:init?.method??"GET",body});await Bun.write(${JSON.stringify(ledger)},JSON.stringify(calls));if(stored){const receipt={id:"fixture-receipt",planHash:stored.snapshot.plan.hash,blockId:123,blockUrl:"https://www.are.na/block/123",destinations:stored.snapshot.routing.destinations,connectionIds:[77],status:"verified",createdAt:"2026-10-05T19:00:00Z",updatedAt:"2026-10-05T19:00:00Z"};const status={saveId:stored.snapshot.saveId,operationId:stored.snapshot.saveId,phase:"saved",active:false,cancelRequested:false,authentication:{accountId:700,credentialProfile:"shared",authenticatedAccountVerified:true},receipt};const root="/v1/saves/"+stored.snapshot.saveId;if(path===root+"/intent")return Response.json(stored);if(path===root||path===root+"/cancel"||path===root+"/retry")return Response.json(status);}if(${mockPublication}&&path==="/v1/save-policy"){return Response.json({credential:{profile:"shared",arenaTokenEnv:"ARENA_WRITE_ACCESS_TOKEN",expectedAccountId:700},mcpPublishingEnabled:true});}if(${mockPublication}&&["/v1/saves","/v1/mcp-saves"].includes(path)&&init?.method==="POST"){if(${JSON.stringify(options.publicationMode)}==="lost")throw new Error("ECONNRESET fixture");const receipt={id:"fixture-receipt",planHash:body.plan.hash,blockId:123,blockUrl:"https://www.are.na/block/123",destinations:body.snapshot.routing.destinations,connectionIds:[77],status:${JSON.stringify(options.publicationMode)}==="failed"?"needs_attention":"verified",createdAt:"2026-10-05T19:00:00Z",updatedAt:"2026-10-05T19:00:00Z"};return ${JSON.stringify(options.publicationMode)}==="failed"?Response.json({error:"Fixture processing failed",receipt},{status:422}):Response.json({saveId:body.snapshot.saveId,operationId:body.snapshot.saveId,phase:"saved",active:false,cancelRequested:false,authentication:{accountId:700,credentialProfile:"shared",authenticatedAccountVerified:true},receipt});}throw new Error("Unexpected network request");};`);
  const child = Bun.spawn([Bun.which("bun")!, "--preload", preload, "src/cli.ts", ...args], {
    env: { ...process.env, HOME: root, ARENA_BLOCK_CONFIG: configPath, ARENA_BLOCK_ENDPOINT: "https://fixture.invalid", ARENA_BLOCK_ACCESS_TOKEN: mockPublication ? "fixture-only" : "", ARENA_BLOCK_DEFAULT_CHANNELS: "", ARENA_BLOCK_PROVENANCE_DIR: journal },
    stdout: "pipe", stderr: "pipe", stdin: input === undefined ? "ignore" : "pipe",
  });
  if (input !== undefined && typeof child.stdin !== "number" && child.stdin) { child.stdin.write(input); child.stdin.end(); }
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code, calls: JSON.parse(await readFile(ledger, "utf8")), journal };
}

test("cached-plan dry run uses inbox fallback without source, daemon, media or Are.na requests", async () => {
  const result = await run(["publish", "--plan", planPath, "--dry-run"], { remoteInbox: { channel: "90001" } });
  expect(result.code).toBe(0); expect(result.stderr).toBe(""); expect(result.calls).toEqual([]);
  const intent = JSON.parse(result.stdout);
  expect(intent.snapshot.routing.destinations).toEqual(["90001"]);
  expect(intent.snapshot.origin).toBe("cli"); expect(intent.snapshot.initiator.kind).toBe("unknown");
  expect(intent.snapshot.plan).toEqual(plan); expect(intent.remoteWriteImplemented).toBe(true); expect(intent.remoteQualification).toBe("existing_account_full_snapshot_fixtures");
});
test("always-mode dry run puts the default first, then the active destination, with bounded full metadata", async () => {
  const result = await run(["publish", "--plan", planPath, "--to", "other", "--to", "090001", "--dry-run", "--initiator", "agent", "--agent", "fixture agent"], { remoteInbox: { channel: "90001", mode: "always" }, provenance: { remoteSnapshot: "full" } });
  expect(result.code).toBe(0); expect(result.calls).toEqual([]);
  const intent = JSON.parse(result.stdout);
  expect(intent.snapshot.routing.destinations).toEqual(["90001", "other"]);
  expect(intent.snapshot.initiator).toMatchObject({ kind: "agent", label: "fixture agent" });
  expect(intent.remoteMetadata.ab_snapshot_complete).toBe(true);
});
test("save-intent writes a private snapshot without invoking any network action", async () => {
  const output = join(root, "owned-drafts");
  const result = await run(["save-intent", "--plan", planPath, "--output-dir", output], { remoteInbox: { channel: "90001" } });
  expect(result.code).toBe(0); expect(result.calls).toEqual([]);
  const saved = JSON.parse(result.stdout);
  expect(saved.remoteWriteImplemented).toBe(true); expect(saved.remoteQualification).toBe("existing_account_full_snapshot_fixtures");
  expect(JSON.parse(await readFile(join(saved.directory, "snapshot.json"), "utf8")).plan).toEqual(plan);
  expect((await readdir(saved.directory)).sort()).toEqual(["intent.json", "snapshot.json"]);
});
test("full metadata overflow stops before bundle creation or any mutation", async () => {
  const oversized = composePlan([{ provider: "x", id: "1", canonicalUrl: "https://x.com/example/status/1", author: { handle: "example" }, text: "漢".repeat(8000), media: [] }]);
  const path = join(root, "oversized.json"); await writeFile(path, JSON.stringify(oversized));
  const result = await run(["publish", "--plan", path, "--dry-run"], { remoteInbox: { channel: "90001" }, provenance: { local: true, remoteSnapshot: "full" } });
  expect(result.code).toBe(1); expect(result.stdout).toBe(""); expect(result.calls).toEqual([]);
  expect(result.stderr).toContain("metadata");
});
test("mocked publication uses the snapshot save identity and keeps receipt separate from original bytes", async () => {
  const result = await run(["publish", "--plan", planPath], { remoteInbox: { channel: "90001" }, provenance: { local: true } }, true);
  expect(result.code).toBe(0);
  const receipt = JSON.parse(result.stdout); expect(receipt.id).toBe("fixture-receipt");
  const [name] = await readdir(result.journal); const saved = join(result.journal, name!);
  const snapshot = JSON.parse(await readFile(join(saved, "snapshot.json"), "utf8"));
  const writes = result.calls.filter((call: any) => call.method === "POST");
  expect(writes).toHaveLength(1); expect(writes[0].body.snapshot.saveId).toBe(snapshot.saveId);
  expect(writes[0].body.snapshot.routing.destinations).toEqual(["90001"]);
  expect(snapshot.plan).toEqual(plan);
  expect(JSON.parse(await readFile(join(saved, "result.json"), "utf8"))).toMatchObject({ receipt, remoteProvenanceWritten: false });
  expect(result.stderr).toBe("");
});
test("piped publish keeps the full JSON contract; explicit human and verbose stay opt-in", async () => {
  const args = ["publish", "--plan", planPath, "--to", "first", "--to", "second"];
  const config = {};
  const machine = await run(args, config, true);
  expect(machine.code).toBe(0); expect(machine.stderr).toBe("");
  expect(JSON.parse(machine.stdout)).toMatchObject({ id: "fixture-receipt", blockId: 123, destinations: ["first", "second"], connectionIds: [77], planHash: plan.hash });
  const human = await run([...args, "--human"], config, true);
  expect(human.code).toBe(0); expect(human.stderr).toBe("");
  expect(human.stdout).toBe("Saved to https://www.are.na/block/123\nChannels:\n  first\n  second\n");
  const verbose = await run([...args, "--human", "--verbose"], config, true);
  expect(verbose.code).toBe(0); expect(verbose.stdout).toContain("Plan hash: " + plan.hash);
  expect(verbose.stdout).toContain("Connection IDs: 77");
  const explicitJson = await run([...args, "--json"], config, true);
  expect(JSON.parse(explicitJson.stdout)).toEqual(JSON.parse(machine.stdout));
  const conflicting = await run([...args, "--json", "--human"], config, true);
  expect(conflicting.code).toBe(1); expect(conflicting.calls).toEqual([]);
  expect(conflicting.stderr).toContain("Choose either --json or --human");
});
test("alternate account profiles cannot silently use the ordinary daemon", async () => {
  for (const config of [
    { remoteInbox: { channel: "90001" }, credentialProfiles: { shared: { arenaTokenEnv: "ARENA_ASSISTANT_TOKEN" } } },
  ]) {
    const result = await run(["publish", "--plan", planPath], config, true);
    expect(result.code).toBe(1); expect(result.calls.map((call: any) => call.method)).toEqual(["GET"]); expect(result.stdout).toBe("");
  }
});
test("remote publication sends a bound capsule for daemon policy and account verification", async () => {
  const result = await run(["publish", "--plan", planPath], { remoteInbox: { channel: "90001" }, provenance: { remoteSnapshot: "full" }, credentialProfiles: { shared: { arenaTokenEnv: "ARENA_WRITE_ACCESS_TOKEN", expectedAccountId: 700 } } }, true);
  expect(result.code).toBe(0);
  const writes = result.calls.filter((call: any) => call.method === "POST");
  expect(writes).toHaveLength(1); expect(writes[0].body.remoteMode).toBe("full");
  expect(writes[0].body.snapshot.saveId).toBe(writes[0].body.snapshot.saveId);
  expect(writes[0].body.snapshot.authentication.authenticatedAccountVerified).toBe(false);
});
test("local result I/O failure never obscures a successful receipt or retries publication", async () => {
  const result = await run(["publish", "--plan", planPath], { remoteInbox: { channel: "90001" }, provenance: { local: true } }, true, undefined, { journalFailure: true });
  expect(result.code).toBe(0); expect(JSON.parse(result.stdout).id).toBe("fixture-receipt");
  expect(result.stderr).toContain("Block saved: https://www.are.na/block/123");
  expect(result.stderr).toContain("Private result could not be recorded");
  expect(result.stderr).toContain("arena-block inspect fixture-receipt");
  expect(result.calls.filter((call: any) => call.method === "POST")).toHaveLength(1);
});
test("journal failure preserves the authoritative publication failure and recovery receipt", async () => {
  const result = await run(["publish", "--plan", planPath], { remoteInbox: { channel: "90001" }, provenance: { local: true } }, true, undefined, { journalFailure: true, publicationMode: "failed" });
  expect(result.code).toBe(1); expect(result.stdout).toBe("");
  expect(result.stderr).toContain("Fixture processing failed");
  expect(result.stderr).toContain("arena-block resume fixture-receipt");
  expect(result.stderr).not.toContain("fixture journal failure");
  expect(result.calls.filter((call: any) => call.method === "POST")).toHaveLength(1);
});
test("a lost daemon response journals unknown and retains the save identity without reposting", async () => {
  const result = await run(["publish", "--plan", planPath], { remoteInbox: { channel: "90001" }, provenance: { local: true } }, true, undefined, { publicationMode: "lost" });
  expect(result.code).toBe(1); expect(result.calls.filter((call: any) => call.method === "POST")).toHaveLength(1);
  expect(result.stderr).toContain("Save UUID: " + result.calls.find((call: any) => call.method === "POST").body.snapshot.saveId);
  expect(result.stderr).toContain("arena-block retry-save");
  const [name] = await readdir(result.journal), saved = join(result.journal, name!);
  const outcome = JSON.parse(await readFile(join(saved, "result.json"), "utf8"));
  expect(outcome.state).toBe("unknown");
  expect(outcome.saveId).toBe(result.calls.find((call: any) => call.method === "POST").body.snapshot.saveId);
});
test("stdio MCP discovery and a harmless preparation call emit protocol messages only", async () => {
  const messages = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "fixture", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "arena_block_preview_save", arguments: { plan } } },
  ].map(value => JSON.stringify(value)).join("\n") + "\n";
  const result = await run(["mcp"], { remoteInbox: { channel: "90001" } }, false, messages);
  expect(result.code).toBe(0); expect(result.stderr).toBe(""); expect(result.calls).toEqual([]);
  const responses = result.stdout.trim().split("\n").map(value => JSON.parse(value));
  expect(responses.map(value => value.id)).toEqual([1, 2, 3]);
  expect(responses[2].result.structuredContent.snapshot.origin).toBe("mcp-local");
  expect(responses[2].result.structuredContent.remoteWriteImplemented).toBe(true);
  expect(responses[2].result.structuredContent.remoteQualification).toBe("existing_account_full_snapshot_fixtures");
});
test("stdio burst capacity responses preserve each incoming request ID", async () => {
  const messages = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "fixture", version: "1" } } },
    ...Array.from({ length: 24 }, (_, index) => ({ jsonrpc: "2.0", id: index + 2, method: "ping" })),
  ].map(value => JSON.stringify(value)).join("\n") + "\n";
  const result = await run(["mcp"], {}, false, messages);
  expect(result.code).toBe(0); expect(result.calls).toEqual([]);
  const responses = result.stdout.trim().split("\n").map(value => JSON.parse(value));
  expect(responses.map(value => value.id).sort((a, b) => a - b)).toEqual(Array.from({ length: 25 }, (_, index) => index + 1));
});
test("explicit profile dry run selects its declared account without resolving any credential", async () => {
  const result = await run(["publish", "--plan", planPath, "--to", "active", "--dry-run", "--profile", "assistant"], { credentialProfiles: { shared: { arenaTokenEnv: "ARENA_WRITE_ACCESS_TOKEN" }, assistant: { arenaTokenEnv: "ARENA_ASSISTANT_TOKEN", expectedAccountId: 48 } } });
  expect(result.code).toBe(0); expect(result.calls).toEqual([]); expect(JSON.parse(result.stdout).snapshot.authentication).toEqual({ credentialProfile: "assistant", expectedAccountId: 48, authenticatedAccountVerified: false });
});


test("CLI status, cancel and retry use the retained UUID and original daemon intent", async () => {
  const intent = prepareSaveIntent(plan, userConfigSchema.parse({}), { origin: "cli", initiator: { kind: "human" }, operation: "publish", destinations: ["active"] });
  const options = { storedIntent: { snapshot: intent.snapshot, snapshotSha256: intent.snapshotSha256 } };
  for (const command of ["save-status", "cancel-save", "retry-save"]) {
    const result = await run([command, intent.snapshot.saveId], {}, true, undefined, options);
    expect(result.code).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(command === "retry-save" ? output.id : output.saveId).toBe(command === "retry-save" ? "fixture-receipt" : intent.snapshot.saveId);
    expect(result.calls.map((call: any) => call.path)).toEqual(command === "retry-save" ? [`/v1/saves/${intent.snapshot.saveId}/intent`, `/v1/saves/${intent.snapshot.saveId}/retry`] : [`/v1/saves/${intent.snapshot.saveId}${command === "cancel-save" ? "/cancel" : ""}`]);
    const writes = result.calls.filter((call: any) => call.method === "POST");
    expect(writes).toHaveLength(command === "save-status" ? 0 : 1);
    if (writes.length) expect(writes[0].body).toEqual({});
  }
});
