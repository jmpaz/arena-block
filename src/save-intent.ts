import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile, rename, rm, link, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { blockPlanSchema, type BlockPlan, type PublicationReceipt, type CreationAttempt } from "./types.ts";
import { planHash } from "./compose.ts";
import { credentialProfile, routeSave, type SaveOrigin, type UserConfig } from "./config.ts";
import { provenanceMetadata, validateMetadata } from "./connection-metadata.ts";
import { redactProvenance } from "./provenance-redaction.ts";
import packageInfo from "../package.json";
import { initiatorSchema, saveSnapshotSchema, type SaveSnapshot } from "./provenance-schema.ts";
export { initiatorSchema, saveSnapshotSchema } from "./provenance-schema.ts";
export type { SaveSnapshot, Initiator } from "./provenance-schema.ts";
export type SaveIntent = { snapshot: SaveSnapshot; snapshotSha256: string; remoteMetadata?: Record<string, string | number | boolean>; remoteWriteImplemented: true; remoteQualification: "existing_account_full_snapshot_fixtures" };

export function snapshotBytes(snapshot: SaveSnapshot): string { return JSON.stringify(snapshot); }
export function snapshotHash(snapshot: SaveSnapshot): string { return createHash("sha256").update(snapshotBytes(snapshot)).digest("hex"); }

/** No network, credential resolution, image decoding, or block mutation. */
export function prepareSaveIntent(planInput: BlockPlan, config: UserConfig, options: {
  origin: SaveOrigin; initiator: z.input<typeof initiatorSchema>; destinations?: string[]; legacyDefaults?: string[];
  operation?: SaveSnapshot["invocation"]["operation"]; saveId?: string; createdAt?: string;
  sourceRevision?: string;
  sourceId?: string;
  inputSourceRefs?: string[];
  inputDestinationArgs?: string[];
  force?: boolean;
  credentialProfile?: string;
  client?: SaveSnapshot["client"];
}): SaveIntent {
  const parsed = blockPlanSchema.parse(planInput);
  const { hash, ...content } = parsed;
  if (planHash(content) !== hash) throw new Error("Plan hash does not match its snapshot");
  const redacted = redactProvenance(content);
  const plan: BlockPlan = { ...redacted.value, hash: redacted.paths.length ? planHash(redacted.value) : hash };
  const profile = credentialProfile(config, options.origin, options.credentialProfile);
  const initiator = redactProvenance(initiatorSchema.parse(options.initiator));
  const client = options.client ? redactProvenance(options.client) : undefined;
  const invocation = redactProvenance({ operation: options.operation ?? "save-intent", arguments: "structured_only", force: options.force ?? false,
    inputs: { sourceRefs: options.inputSourceRefs ?? plan.sources.map(source => source.canonicalUrl), destinationArgs: options.inputDestinationArgs ?? options.destinations ?? [],
      basis: options.inputSourceRefs ? "declared_arguments" : "canonical_from_plan" } });
  const snapshot = saveSnapshotSchema.parse({
    schemaVersion: 1, schema: "arena-block.save.v1", saveId: z.uuid().parse(options.saveId ?? randomUUID()),
    createdAt: z.iso.datetime().parse(options.createdAt ?? new Date().toISOString()), origin: options.origin,
    initiator: initiator.value,
    ...(client ? { client: client.value } : {}),
    authentication: { credentialProfile: profile.name, ...(profile.expectedAccountId ? { expectedAccountId: profile.expectedAccountId } : {}), authenticatedAccountVerified: false },
    invocation: invocation.value,
    application: { name: "arena-block", version: packageInfo.version,
      ...(options.sourceRevision ? { sourceRevision: z.string().regex(/^[a-f0-9]{40}$/).parse(options.sourceRevision) } : {}),
      ...(options.sourceId ? { sourceId: options.sourceId } : {}) },
    routing: routeSave(config, options.destinations ?? [], options.legacyDefaults), plan,
    redaction: { policy: "known_credentials_v1", paths: [...redacted.paths.map(path => `plan.${path}`), ...initiator.paths.map(path => `initiator.${path}`), ...invocation.paths.map(path => `invocation.${path}`), ...(client?.paths.map(path => `client.${path}`) ?? [])], originalPlanHashOmitted: redacted.paths.length > 0 },
    fidelity: { originalPlanPreserved: redacted.paths.length === 0, rawCommandCaptured: false, imageBytesIncluded: false, renderedArtifactCreated: false, renderedIngredientsComplete: false },
  });
  if (Buffer.byteLength(snapshotBytes(snapshot)) > 2 * 1024 * 1024) throw new Error("Private provenance snapshot exceeds 2 MiB; no save was attempted");
  const snapshotSha256 = snapshotHash(snapshot);
  const remoteMetadata = config.provenance.remoteSnapshot === "none" || !snapshot.routing.defaultChannel?.included ? undefined : provenanceMetadata(snapshot, config.provenance.remoteSnapshot);
  return { snapshot, snapshotSha256, ...(remoteMetadata ? { remoteMetadata } : {}), remoteWriteImplemented: true, remoteQualification: "existing_account_full_snapshot_fixtures" };
}

/** Each owned bundle is private and commits atomically; snapshots are never edited for results. */
export async function writeSaveIntent(intent: SaveIntent, root: string, signal?: AbortSignal): Promise<string> {
  const snapshot = saveSnapshotSchema.parse(intent.snapshot);
  const serialized = snapshotBytes(snapshot);
  if (createHash("sha256").update(serialized).digest("hex") !== intent.snapshotSha256) throw new Error("Provenance snapshot changed after preparation");
  let remoteMetadata;
  if (intent.remoteMetadata) {
    validateMetadata(intent.remoteMetadata);
    const complete = intent.remoteMetadata.ab_snapshot_complete;
    if (typeof complete !== "boolean") throw new Error("Provenance envelope has no explicit completeness mode");
    remoteMetadata = provenanceMetadata(snapshot, complete ? "full" : "summary");
    if (Object.keys(intent.remoteMetadata).length !== Object.keys(remoteMetadata).length
      || Object.entries(remoteMetadata).some(([key, value]) => intent.remoteMetadata![key] !== value)) {
      throw new Error("Provenance envelope does not match its snapshot");
    }
  }
  // Freeze serialized bytes before the first await: a caller cannot race file creation with changes.
  const envelope = JSON.stringify({ saveId: snapshot.saveId, planHash: snapshot.plan.hash, snapshotSha256: intent.snapshotSha256,
    ...(remoteMetadata ? { remoteMetadata } : {}), remoteWriteImplemented: true, remoteQualification: "existing_account_full_snapshot_fixtures" }, null, 2) + "\n";
  signal?.throwIfAborted();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const suffix = randomUUID();
  const directory = join(root, `save-${snapshot.saveId}-${suffix}`);
  const staging = join(root, `.staging-${suffix}`);
  await mkdir(staging, { mode: 0o700 });
  try {
    await writeFile(join(staging, "snapshot.json"), serialized, { mode: 0o600, flag: "wx" });
    await writeFile(join(staging, "intent.json"), envelope, { mode: 0o600, flag: "wx" });
    signal?.throwIfAborted();
    await rename(staging, directory);
    return directory;
  } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
}

/** A separate terminal result keeps the original strings and recipe untouched. */
export async function writeSaveResult(directory: string, outcome: { receipt?: PublicationReceipt; attempt?: CreationAttempt; error?: string }): Promise<void> {
  const redacted = redactProvenance(outcome);
  const state = outcome.receipt?.status === "rolled_back" ? "rolled_back" : outcome.receipt?.status === "rollback_failed" ? "rollback_failed"
    : outcome.attempt?.status === "rejected" ? "not_saved"
    : outcome.receipt?.pendingDestinations?.length ? "placements_partial"
    : outcome.receipt?.remoteProvenance && outcome.receipt.remoteProvenance.state !== "verified" ? "provenance_pending"
    : outcome.receipt?.status === "verified" ? "saved"
    : outcome.receipt?.stage === "connecting" ? "placements_partial" : outcome.receipt ? "saved_needs_attention" : "unknown";
  const identity = JSON.parse(await readFile(join(directory, "intent.json"), "utf8"));
  const saveId = z.uuid().parse(identity.saveId);
  const serialized = JSON.stringify({ saveId, snapshotSha256: z.string().regex(/^[a-f0-9]{64}$/).parse(identity.snapshotSha256), recordedAt: new Date().toISOString(), ...redacted.value,
    state, redactedPaths: redacted.paths, remoteProvenanceWritten: outcome.receipt?.remoteProvenance?.state === "verified" }, null, 2) + "\n";
  const staging = join(directory, `.result-${randomUUID()}.json`);
  try {
    await writeFile(staging, serialized, { mode: 0o600, flag: "wx" });
    // Hard-link commits a complete result without replacing an existing terminal outcome.
    await link(staging, join(directory, "result.json"));
  } finally { await rm(staging, { force: true }); }
}
