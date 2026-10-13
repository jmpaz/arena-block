import { composePlan, planHash } from "../../src/compose.ts";
import { prepareSaveIntent } from "../../src/save-intent.ts";
import { userConfigSchema } from "../../src/config.ts";
import type { PublishRequest } from "../../src/types.ts";
import { provenanceMetadata, validateMetadata, type MetadataPatch } from "../../src/connection-metadata.ts";
import { saveSnapshotSchema } from "../../src/provenance-schema.ts";

export const QUALIFICATION_SAVE_IDS = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"] as const;
export const QUALIFICATION_APPROVAL = "one-private-channel-two-fictional-blocks" as const;
export const qualificationChannelPayload = {
  title: "arena-block test", visibility: "private",
  description: "Private arena-block qualification fixtures. Both blocks are fictional; no source post was fetched. Retain fixtures for review.",
};
export const qualificationBoundaryPatch: MetadataPatch = {
  ab_test_keep: "keep", ab_test_remove: "remove", ab_test_ascii: "a".repeat(2000),
  ab_test_unicode: "😀".repeat(500), ["k".repeat(40)]: 1,
};
export const qualificationMergePatch: MetadataPatch = { ab_test_keep: "kept_changed", ab_test_remove: null, ab_test_number: 42, ab_test_bool: false };

/** Compose synthetic source records for the mock publisher. */
export function qualificationRequests(channelId: number, accountId: number): PublishRequest[] {
  if (![channelId, accountId].every(value => Number.isSafeInteger(value) && value > 0) || channelId === 90001) throw new Error("Qualification requires a new fixture channel; the real Remote Inbox is excluded");
  const config = userConfigSchema.parse({ remoteInbox: { channel: String(channelId), mode: "always" }, provenance: { remoteSnapshot: "full" },
    credentialProfiles: { shared: { arenaTokenEnv: "ARENA_WRITE_ACCESS_TOKEN", expectedAccountId: accountId } } });
  return QUALIFICATION_SAVE_IDS.map((saveId, index) => {
    const text = index === 0 ? "Fictional fixture 1. This tests private connection metadata, merge, null deletion, and bounded scalar values. No actual post was fetched."
      : `Fictional fixture 2. Unicode across UTF-8 chunk boundaries:\n${"😀漢é".repeat(300)}\nThis is invented test content. No actual post was fetched.`;
    const plan = composePlan([{ provider: "x", id: `fictional-${index + 1}`, canonicalUrl: `https://example.invalid/arena-block-test/${index + 1}`,
      author: { handle: `fictional_fixture_${index + 1}` }, text, media: [] }], { media: "none" });
    plan.block.title = `arena-block test — fictional fixture ${index + 1}`;
    plan.block.description = "Invented qualification fixture. Retain for review.";
    const { hash: _, ...content } = plan; plan.hash = planHash(content);
    const intent = prepareSaveIntent(plan, config, { origin: "cli", initiator: { kind: "agent", label: "arena-block qualification runner" }, operation: "publish",
      destinations: [String(channelId)], saveId, createdAt: "2026-10-05T00:00:00Z" });
    return { plan, destinations: [String(channelId)], force: false, operationId: saveId,
      remoteSave: { snapshot: intent.snapshot, snapshotSha256: intent.snapshotSha256, mode: "full" } };
  });
}

export function qualificationPlan() {
  // Use the fixture destination while preparing the local review data.
  const fixtures = qualificationRequests(999999901, 700);
  validateMetadata(qualificationBoundaryPatch, true); validateMetadata(qualificationMergePatch, true);
  return {
    schemaVersion: 1, approvalStatus: "pending", executionPerformed: false,
    account: { existingExpectedAccountId: 700, tokenReference: "ARENA_WRITE_ACCESS_TOKEN", newAccountOrToken: false },
    channelCreate: { method: "POST", path: "/v3/channels", payload: { ...qualificationChannelPayload, metadata: { ab_test_run_id: "<owned checkpoint run UUID>" } } },
    placeholder: { channelId: 999999901, meaning: "Replace only with the ID returned by the single approved new private channel creation" },
    budgets: { channelCreates: 1, blockCreates: 2, connectionCreates: 0, blockUpdates: 2, connectionMetadataUpdates: 4, reads: 120 },
    sequence: [
      "GET /me: verify the existing authenticated account before any write.",
      "Create one private arena-block test channel; durably retain its returned ID. Lost channel response stops without retry.",
      "Create fictional fixture 1 with full provenance on its sole private connection, then verify source text and channel-scoped connection ID.",
      "Read/write/read the boundary patch on fixture 1's verified connection; preserve all snapshot chunks and unrelated keys.",
      "Merge the second patch: change keep, delete remove with null, add number/bool; confirm omitted values survive and snapshot checksum is unchanged.",
      "Create fictional fixture 2 once; deliberately discard that one successful create response locally, then reconcile its save UUID in the fixture channel before replay.",
      "Replay both original operations. Confirm two blocks and two mapped connections, identical original capsules, and zero POST /connections or additional POST /blocks.",
      "Read channel visibility/owner/collaborators and final contents; retain both fixtures and all journals. No cleanup, visibility changes, other account reads, or real Inbox access.",
    ],
    boundaries: { ASCIIString: 2000, unicodeStringUTF16: 1000, unicodeStringUTF8: 2000, keyLength: 40, chunkUTF8Max: 1800,
      invalidCasesOfflineOnly: ["2001-character scalar", "41-character key", "51 keys", "merged object over 32 KiB", "full snapshot over reserved budget"] },
    fixtures: fixtures.map(input => {
      const metadata = provenanceMetadata(saveSnapshotSchema.parse(input.remoteSave!.snapshot), "full");
      return { request: input, metadataBytes: Buffer.byteLength(JSON.stringify(metadata)), keys: Object.keys(metadata).length,
        chunkCount: metadata.ab_snapshot_chunks, chunks: Object.entries(metadata).filter(([key]) => /^ab_snapshot_\d\d$/.test(key)).map(([key, value]) => ({ key, bytes: Buffer.byteLength(String(value)), utf16: String(value).length })) };
    }),
    boundaryPatch: qualificationBoundaryPatch, mergePatch: qualificationMergePatch,
    limits: [
      "Controlled local response loss does not establish server failure atomicity or exactly-once guarantees.",
      "Duplicate prevention is tested by replay/reconciliation; the runner forbids a deliberate duplicate-connect POST. Raw server duplicate semantics remain unqualified.",
      "Owner-token update behavior and returned private visibility can be qualified here. Cross-account ACL and unauthenticated privacy probes are outside this one-account approval.",
      "The runner does not activate installed config, run a daemon, publish user sources, create credentials, or deploy MCP.",
    ],
  };
}
