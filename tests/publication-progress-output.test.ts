import { expect, test } from "bun:test";
import { join } from "node:path";
import { composePlan } from "../src/compose.ts";
import { formatProgressLine, publicationWithProgress } from "../src/publication-progress.ts";
import type { PublicationReceipt } from "../src/types.ts";
import { PublicationError, type ArenaBlockClient } from "../src/client.ts";

const plan = composePlan([{ provider: "x", id: "1", canonicalUrl: "https://x.com/fixture/status/1", author: { handle: "fixture" }, text: "fixture", media: [] }]);
const receipt: PublicationReceipt = { id: "private-receipt", planHash: plan.hash, blockId: 123, blockUrl: "https://www.are.na/block/123",
  destinations: ["9002", "math-slug"], connectionIds: [47], status: "verified", createdAt: "2026-10-06T00:00:00Z", updatedAt: "2026-10-06T00:00:01Z" };

test("short stage text keeps exact UTF-8 separator and omits channel refs", () => {
  const line = formatProgressLine({ receipt: { ...receipt, stage: "processing" } }, 14);
  expect(line).toBe("Processing on Are.na · 14s");
  expect(Buffer.from(line).includes(Buffer.from([0xc2, 0xb7]))).toBe(true);
  expect(line).not.toContain("9002"); expect(line).not.toContain("math-slug");
});

test("interactive progress uses the selected terminal stream; piped and JSON modes stay silent", async () => {
  const writes: string[] = [];
  const sink = { isTTY: true, columns: 100, write(value: string) { writes.push(value); } };
  const daemon = { saveStatus: async () => ({ receipt: { ...receipt, stage: "processing" } }) } as unknown as ArenaBlockClient;
  await publicationWithProgress(daemon, plan, receipt.destinations, async () => { await Bun.sleep(1100); return receipt; }, undefined, "save-fixture", true, "stdout", sink);
  expect(writes.join("")).toContain("Processing on Are.na · 1s");
  expect(writes.join("")).not.toContain("9002"); expect(writes.join("")).not.toContain("math-slug");
  expect(writes.join("")).not.toContain("\u001b[31m");
  writes.length = 0;
  await publicationWithProgress(daemon, plan, receipt.destinations, async () => receipt, undefined, "save-fixture", true, "none", sink);
  expect(writes).toEqual([]);
  sink.isTTY = false;
  await publicationWithProgress(daemon, plan, receipt.destinations, async () => receipt, undefined, "save-fixture", true, "stdout", sink);
  expect(writes).toEqual([]);
});

test("C and UTF-8 locales emit the same valid UTF-8 progress bytes", () => {
  const source = `import {formatProgressLine} from ${JSON.stringify(join(import.meta.dir, "../src/publication-progress.ts"))}; process.stdout.write(formatProgressLine({},14));`;
  const outputs = ["C", "en_US.UTF-8"].map(locale => Bun.spawnSync([Bun.which("bun")!, "-e", source], { env: { ...process.env, LC_ALL: locale, LANG: locale } }));
  expect(outputs.every(output => output.exitCode === 0)).toBe(true);
  expect(outputs[0]!.stdout).toEqual(outputs[1]!.stdout);
  expect(Buffer.from(outputs[0]!.stdout).toString("utf8")).toBe("Preparing save · 14s");
  expect(Buffer.from(outputs[0]!.stdout).includes(Buffer.from([0xef, 0xbf, 0xbd]))).toBe(false);
});

test("Ctrl-C requests owner cancellation once even after submission, retaining a completed block", async () => {
  let cancels = 0;
  const daemon = { saveStatus: async () => ({ saveId: "save-fixture", phase: "saved", active: false, receipt }),
    cancelSave: async () => { cancels++; return { saveId: "save-fixture", phase: "saved", active: false, receipt }; } } as unknown as ArenaBlockClient;
  const pending = publicationWithProgress(daemon, plan, receipt.destinations,
    signal => new Promise<PublicationReceipt>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
    undefined, "save-fixture", true, "none");
  process.emit("SIGINT"); process.emit("SIGINT");
  await expect(pending).rejects.toMatchObject({ userInterrupted: true, receipt, message: expect.stringContaining("completed") });
  expect(cancels).toBe(1);
});

test("Ctrl-C leaves an active owner with a durable cancellation request and no repost", async () => {
  let cancels = 0;
  const status = { saveId: "save-fixture", phase: "partial", active: true, cancelRequested: true, receipt };
  const daemon = { saveStatus: async () => status, cancelSave: async () => { cancels++; return status; } } as unknown as ArenaBlockClient;
  const pending = publicationWithProgress(daemon, plan, receipt.destinations,
    signal => new Promise<PublicationReceipt>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
    undefined, "save-fixture", true, "none");
  process.emit("SIGINT");
  await expect(pending).rejects.toMatchObject({ userInterrupted: true, receipt, saveStatus: status,
    message: expect.stringContaining("Cancellation requested") });
  expect(cancels).toBe(1);
});

test("unreachable cancellation is reported as unconfirmed while retaining a known block", async () => {
  const daemon = { saveStatus: async () => { throw new Error("owner unavailable"); },
    cancelSave: async () => { throw new Error("owner unavailable"); } } as unknown as ArenaBlockClient;
  const pending = publicationWithProgress(daemon, plan, receipt.destinations,
    signal => new Promise<PublicationReceipt>((_resolve, reject) => signal.addEventListener("abort", () =>
      reject(new PublicationError("request interrupted", receipt)), { once: true })),
    undefined, "save-fixture", true, "none");
  process.emit("SIGINT");
  await expect(pending).rejects.toMatchObject({ userInterrupted: true, receipt,
    message: expect.stringContaining("could not be confirmed") });
});
