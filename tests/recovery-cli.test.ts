import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composePlan } from "../src/compose.ts";
import type { PublicationReceipt } from "../src/types.ts";

const directory = await mkdtemp(join(tmpdir(), "arena-recovery-cli-"));
afterAll(() => rm(directory, { recursive: true, force: true }));
const plan = composePlan([{ provider: "x", id: "1", canonicalUrl: "https://x.com/example/status/1",
  author: { handle: "example" }, text: "Approved writing", media: [] }]);
const receipt: PublicationReceipt = {
  id: "saved-snapshot", planHash: plan.hash, blockId: 123, blockUrl: "https://www.are.na/block/123",
  destinations: ["first"], pendingDestinations: ["second"], connectionIds: [], status: "needs_attention", stage: "processing",
  createdAt: "2026-10-01T19:23:20.185Z", updatedAt: "2026-10-01T19:23:54.518Z", error: "Are.na block processing failed",
};
const planPath = join(directory, "plan.json"); await Bun.write(planPath, JSON.stringify(plan));

async function cli(args: string[], mode = "failed") {
  const id = crypto.randomUUID();
  const preload = join(directory, `${id}.ts`), ledger = join(directory, `${id}.json`);
  await Bun.write(preload, `const plan=${JSON.stringify(plan)}, receipt=${JSON.stringify(receipt)}, calls=[];let operationId,cancelled=false;
    globalThis.fetch = async (input, init) => {
      const url=new URL(String(input)); const path=url.pathname;
      calls.push({path, method:init?.method ?? "GET", ...(init?.body ? {body:JSON.parse(init.body)} : {})});
      if(init?.body)operationId=JSON.parse(init.body).snapshot?.saveId??operationId;
      await Bun.write(${JSON.stringify(ledger)}, JSON.stringify(calls));
      if(path==="/v1/save-policy")return Response.json({credential:{profile:"shared",arenaTokenEnv:"ARENA_WRITE_ACCESS_TOKEN"},mcpPublishingEnabled:false});
      if(path==="/v1/saves/"+operationId)return Response.json(${JSON.stringify(mode)} === "cancel"
        ? {saveId:operationId,operationId,phase:cancelled?"partial":"running",active:!cancelled,cancelRequested:cancelled,authentication:{accountId:47,credentialProfile:"shared",authenticatedAccountVerified:true},receipt}
        : {saveId:operationId,operationId,phase:"partial",active:false,cancelRequested:true,authentication:{accountId:47,credentialProfile:"shared",authenticatedAccountVerified:true},receipt});
      if(path==="/v1/saves/"+operationId+"/cancel"){cancelled=true;return Response.json({saveId:operationId,operationId,phase:"partial",active:false,cancelRequested:true,authentication:{accountId:47,credentialProfile:"shared",authenticatedAccountVerified:true},receipt});}
      if (path === "/v1/plans/"+plan.hash) return Response.json(plan);
      if (path === "/v1/publications/saved-snapshot") return Response.json(receipt);
      if (path === "/v1/publications" && !init?.body) return Response.json({receipt});
      if(path === "/v1/publication-operations/"+operationId)return Response.json({operationId,receipt});
      if (path === "/v1/publications/saved-snapshot/resume") return Response.json({...receipt, status:"verified", stage:undefined, pendingDestinations:undefined, error:undefined});
      if (path === "/v1/saves" && ${JSON.stringify(mode)} === "cancel") {
        const keepAlive=setInterval(() => {}, 100);
        setTimeout(() => process.kill(process.pid, "SIGINT"), 10);
        return new Promise((resolve,reject) => init.signal.addEventListener("abort", () => {clearInterval(keepAlive);reject(init.signal.reason);}, {once:true}));
      }
      if (path === "/v1/saves" && ${JSON.stringify(mode)} === "unknown") return Response.json({error:"Creation outcome is unknown", attempt:{id:"attempt-1",planHash:plan.hash,destinations:["first"],status:"creation_unknown",createdAt:receipt.createdAt}}, {status:422});
      if (path === "/v1/saves" && ${JSON.stringify(mode)} === "retained") return Response.json({
        error:"Original retained save requires recovery: arena-block retry-save 11111111-1111-4111-8111-111111111111",
        saveStatus:{saveId:operationId,operationId,phase:"not_saved",active:false,cancelRequested:false,
          failure:{code:"retained_recovery",message:"Original retained save requires recovery: arena-block retry-save 11111111-1111-4111-8111-111111111111"},
          authentication:{accountId:47,credentialProfile:"shared",authenticatedAccountVerified:true}}
      }, {status:422});
      if (path === "/v1/saves") return Response.json({error:receipt.error,receipt}, {status:422});
      throw new Error("Unexpected source or service request: " + path);
    };`);
  const child = Bun.spawn([Bun.which("bun")!, "--preload", preload, "src/cli.ts", ...args], {
    env: { ...process.env, HOME: directory, ARENA_BLOCK_ENDPOINT: "https://fixture.invalid", ARENA_BLOCK_ACCESS_TOKEN: "fixture-only" },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code, calls: await Bun.file(ledger).json() };
}

test("failed publishing gives a retained block and concrete inspection/recovery commands", async () => {
  const result = await cli(["publish", "--plan", planPath, "--to", "first"]);
  expect(result.code).toBe(1); expect(result.stdout).toBe("");
  expect(result.stderr).toContain(receipt.error!);
  expect(result.stderr).toContain("Block retained: " + receipt.blockUrl);
  expect(result.stderr).toContain("arena-block inspect saved-snapshot");
  expect(result.stderr).toContain("arena-block resume saved-snapshot");
});

test("explicit human failure leads with the existing block and issue without routine UUID or retry dump", async () => {
  const result = await cli(["publish", "--human", "--plan", planPath, "--to", "first"]);
  expect(result.code).toBe(1); expect(result.stdout).toBe("");
  expect(result.stderr).toContain("Save needs attention: https://www.are.na/block/123\nRequested channels:\n  first");
  expect(result.stderr).toContain("Issue: Are.na block processing failed");
  expect(result.stderr).toContain("Inspect: arena-block inspect saved-snapshot");
  expect(result.stderr).not.toContain("Save UUID:");
  expect(result.stderr).not.toContain("arena-block retry-save");
  expect(result.calls.filter((call: {method: string; path: string}) => call.method === "POST" && call.path === "/v1/saves")).toHaveLength(1);
});

test("inspection exposes approved content and pending placements without writes", async () => {
  const result = await cli(["inspect", receipt.id, "--json"]);
  expect(result.code).toBe(0); expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toEqual({ receipt, plan });
  expect(result.calls.every((call: {method: string}) => call.method === "GET")).toBe(true);
});

test("resume uses the chosen receipt, saved snapshot and pending/additional destinations", async () => {
  const result = await cli(["resume", receipt.id, "--to", "https://www.are.na/person/third"]);
  expect(result.code).toBe(0); expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toMatchObject({ id: receipt.id, status: "verified" });
  expect(result.calls).toEqual([
    { path: "/v1/publications/saved-snapshot", method: "GET" },
    { path: "/v1/plans/" + plan.hash, method: "GET" },
    { path: "/v1/publications/saved-snapshot/resume", method: "POST", body: { destinations: ["first", "second", "third"] } },
  ]);
});

test("SIGINT requests owner cancellation after submission without reposting or hiding the block", async () => {
  const result = await cli(["publish", "--plan", planPath, "--to", "first"], "cancel");
  expect(result.code).toBe(1); expect(result.stdout).toBe("");
  expect(result.stderr).toContain("Cancellation requested");
  expect(result.stderr).toContain("Block retained: " + receipt.blockUrl);
  expect(result.stderr).not.toContain("arena-block retry-save");
  expect(result.stderr).toContain("arena-block save-status");
  expect(result.stderr).not.toContain("Resume: arena-block resume");
  expect(result.calls.filter((call: {method: string; path: string}) => call.method === "POST" && call.path === "/v1/saves")).toHaveLength(1);
  expect(result.calls.filter((call: {method: string; path: string}) => call.method === "POST" && call.path.endsWith("/cancel"))).toHaveLength(1);
});

test("an unknown creation exposes an attempt rather than a made-up block or resume action", async () => {
  const result = await cli(["publish", "--plan", planPath, "--to", "first"], "unknown");
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("arena-block attempt attempt-1");
  expect(result.stderr).not.toContain("Block retained");
  expect(result.stderr).not.toContain("arena-block resume");
});

test("a fresh UUID blocked by an unfinished original points to the original save, not a fresh retry", async () => {
  const result = await cli(["publish", "--plan", planPath, "--to", "first"], "retained");
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("arena-block retry-save 11111111-1111-4111-8111-111111111111");
  expect(result.stderr).not.toContain("Recovery: arena-block retry-save ");
  expect(result.calls.filter((call: {method: string; path: string}) =>
    call.method === "POST" && call.path === "/v1/saves")).toHaveLength(1);
});
