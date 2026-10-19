import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArenaClient, ArenaPublisher } from "../src/arena.ts";
import { ArenaBlockStore } from "../src/store.ts";
import { blockPlanSchema, publicationReceiptSchema } from "../src/types.ts";

test("retained SoundCloud save and receipt IDs stay distinct and incomplete custody cannot create a replacement", async () => {
  const plan = blockPlanSchema.parse(await Bun.file(new URL("fixtures/soundcloud-url-legacy-plan.json", import.meta.url)).json());
  const saveId = "1831c224-4108-43e1-8427-1f40ed1f2cd9", receiptId = "a24b6c90-3ef4-4fc2-aa0f-60d2fab7928f";
  const receipt = publicationReceiptSchema.parse({ id: receiptId, planHash: plan.hash, blockId: 51589137,
    blockUrl: "https://www.are.na/block/51589137", destinations: ["901", "902"], pendingDestinations: ["901", "902"], connectionIds: [],
    status: "needs_attention", stage: "verifying", error: "Expected Link block, received Embed", createdAt: "2026-10-19T20:01:33.406Z", updatedAt: "2026-10-19T20:01:37.181Z",
    remoteProvenance: { saveId, snapshotSha256: "92719d5aab7be194d5782f7e23ea565b8abeb6cfb7bec9f80749ad81954059c5",
      accountId: 47, credentialProfile: "fixture-only", inboxChannelId: 901, state: "pending" } });
  const directory = await mkdtemp(join(tmpdir(), "arena-soundcloud-retained-"));
  const store = new ArenaBlockStore(join(directory, "state.sqlite"));
  const requests: string[] = [];
  const client = new ArenaClient("fixture-only", "https://arena.invalid/v3", async input => {
    requests.push(String(input)); throw new Error("Missing journal must stop before any remote request");
  });
  const publisher = new ArenaPublisher(client, store, { publicBaseUrl: "https://media.invalid", mediaDirectory: join(directory, "media"), render: async () => {
    throw new Error("Retained URL plan must not render a replacement");
  } });
  try {
    store.savePlan(plan); store.saveReceipt(receipt); store.beginOperation(saveId, plan.hash); store.bindOperationReceipt(saveId, receipt);
    expect(store.operationState(saveId)?.receipt?.id).toBe(receiptId); expect(store.receipt(saveId)).toBeUndefined();
    await expect(publisher.resume(saveId, [])).rejects.toThrow("receipt not found");
    await expect(publisher.resume(receiptId, [])).rejects.toThrow("journal is missing or inconsistent");
    expect(requests).toEqual([]);
    expect(store.receipt(receiptId)).toEqual(receipt);
    expect(store.receipt(receiptId)!.pendingDestinations).toEqual(["901", "902"]);
    expect(store.receipt(receiptId)!.connectionIds).toEqual([]);
    expect(store.plan(plan.hash)!.plan).toEqual(plan);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});
