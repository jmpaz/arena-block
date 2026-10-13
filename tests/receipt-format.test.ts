import { expect, test } from "bun:test";
import { formatHumanReceipt, receiptOutputMode } from "../src/receipt-format.ts";
import { arenaDestination } from "../src/url.ts";
import type { PublicationReceipt } from "../src/types.ts";

const receipt: PublicationReceipt = {
  id: "private-receipt", planHash: "private-plan-hash", blockId: 123,
  blockUrl: "https://www.are.na/block/123", destinations: ["first", "second"],
  connectionIds: [41, 42], status: "verified", createdAt: "2026-10-06T00:00:00Z", updatedAt: "2026-10-06T00:01:00Z",
  mediaArtifact: { hash: "a".repeat(64), url: "https://media.example.test/asset.mp4", mimeType: "video/mp4", size: 200 },
};

test("terminal defaults to human while pipes retain JSON; explicit flags override", () => {
  expect(receiptOutputMode({}, true)).toBe("human");
  expect(receiptOutputMode({}, false)).toBe("json");
  expect(receiptOutputMode({ json: true }, true)).toBe("json");
  expect(receiptOutputMode({ human: true }, false)).toBe("human");
  expect(() => receiptOutputMode({ json: true, human: true }, false)).toThrow("either --json or --human");
});

test("human receipt leads with the block and destinations without private identifiers", () => {
  const output = formatHumanReceipt(receipt);
  expect(output).toBe("Saved to https://www.are.na/block/123\nChannels:\n  first\n  second\nMedia: https://media.example.test/asset.mp4");
  for (const hidden of [receipt.id, receipt.planHash, "Block ID", "Connection IDs", receipt.createdAt]) expect(output).not.toContain(hidden);
});

test("attention keeps pending channels and issue visible; verbose reveals recovery identifiers", () => {
  const partial: PublicationReceipt = { ...receipt, status: "needs_attention", destinations: ["first"], pendingDestinations: ["second"], error: "Are.na block processing failed" };
  const output = formatHumanReceipt(partial);
  expect(output).toContain("Save needs attention: https://www.are.na/block/123\nRequested channels:\n  first\nPlacement check:\n  second\nMedia:");
  expect(output).toContain("Issue: Are.na block processing failed");
  const details = formatHumanReceipt(partial, { verbose: true, saveId: "save-uuid", provenanceDirectory: "/private/snapshot" });
  for (const value of ["Receipt ID: private-receipt", "Save UUID: save-uuid", "Block ID: 123", "Connection IDs: 41, 42", "Plan hash: private-plan-hash", "Created: 2026-10-06T00:00:00Z", "Private save snapshot: /private/snapshot"]) expect(details).toContain(value);
});

test("verified status with pending placements is attention, and punctuation in channel names stays unambiguous", () => {
  const partial: PublicationReceipt = { ...receipt, destinations: ["9002", "math-slug"], pendingDestinations: ["9002", "math-slug"],
    stage: "connecting", error: "Channel reconciliation exceeded its bound", remoteProvenance: { saveId: crypto.randomUUID(), snapshotSha256: "b".repeat(64), accountId: 47, credentialProfile: "shared", inboxChannelId: 9002, state: "unknown" } };
  const names = { "9002": "Notes, links | Inbox", "math-slug": "math, problems / proofs" };
  const output = formatHumanReceipt(partial, { channelNames: names });
  expect(output).toContain("Requested channels:\n  math, problems / proofs\n  Notes, links | Inbox (default)");
  expect(output).toContain("Placement check:\n  Notes, links | Inbox\n  math, problems / proofs");
  expect(output).not.toContain("Saved to "); expect(output).not.toContain("9002");
  const complete = formatHumanReceipt({ ...partial, stage: undefined, pendingDestinations: undefined, error: undefined,
    remoteProvenance: { ...partial.remoteProvenance!, state: "verified" } }, { channelNames: names });
  expect(complete.split("\n")[0]).toBe("Saved to https://www.are.na/block/123");
});

test("explicit channel URL and numeric default resolve to one displayed physical Inbox", () => {
  const explicit = arenaDestination("https://www.are.na/example-user/inbox-fixture")!;
  const duplicate: PublicationReceipt = { ...receipt, destinations: ["9002", explicit], pendingDestinations: ["9002", explicit],
    stage: "connecting", remoteProvenance: { saveId: crypto.randomUUID(), snapshotSha256: "b".repeat(64), accountId: 47, credentialProfile: "shared", inboxChannelId: 9002, state: "pending" } };
  const display = { channelNames: { "9002": "Inbox", [explicit]: "Inbox" }, channelIds: { "9002": 9002, [explicit]: 9002 },
    channelSlugs: { "9002": explicit, [explicit]: explicit } };
  const output = formatHumanReceipt(duplicate, display);
  expect(output).toContain("Requested channels:\n  Inbox\nPlacement check:\n  Inbox");
  expect(output).not.toContain("Inbox (default)");
  expect(output.match(/  Inbox/g)).toHaveLength(2); // once per status section, never twice in one section
  const saved = formatHumanReceipt({ ...duplicate, pendingDestinations: undefined, stage: undefined,
    remoteProvenance: { ...duplicate.remoteProvenance!, state: "verified" } }, display);
  expect(saved).toContain("Saved to https://www.are.na/block/123\nChannels:\n  Inbox\nMedia:");
});

test("distinct channels sharing a title stay separate and show their slugs", () => {
  const output = formatHumanReceipt({ ...receipt, destinations: ["101", "another-inbox"], connectionIds: [41, 42] }, {
    channelNames: { "101": "Inbox", "another-inbox": "Inbox" }, channelIds: { "101": 101, "another-inbox": 202 },
    channelSlugs: { "101": "inbox-alpha", "another-inbox": "inbox-beta" },
  });
  expect(output).toContain("Channels:\n  Inbox (inbox-alpha)\n  Inbox (inbox-beta)");
  expect(output).not.toContain("Channel ID");
});
