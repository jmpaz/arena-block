import { createHash } from "node:crypto";
import type { SaveSnapshot } from "./save-intent.ts";
import { blockPlanSchema } from "./types.ts";
import { planHash } from "./compose.ts";
import { saveSnapshotSchema } from "./provenance-schema.ts";

export type Metadata = Record<string, string | number | boolean>;
export type MetadataPatch = Record<string, string | number | boolean | null>;
export const METADATA_BYTES = 32 * 1024;
export const PROVENANCE_BYTES = 28_000;

/** Verified v3 limits, including the OpenAPI per-string limit. Byte accounting is conservative. */
export function validateMetadata(value: unknown, patch = false): asserts value is MetadataPatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Connection metadata must be an object");
  const entries = Object.entries(value);
  if (entries.length > 50) throw new Error("Connection metadata exceeds 50 keys");
  for (const [key, scalar] of entries) {
    if (!/^[A-Za-z0-9_]{1,40}$/.test(key)) throw new Error("Invalid connection metadata key");
    if (scalar === null && patch) continue;
    if (typeof scalar === "string") {
      if (scalar.length > 2000) throw new Error("Connection metadata string exceeds 2000 characters");
    } else if (!(typeof scalar === "boolean" || typeof scalar === "number" && Number.isFinite(scalar))) {
      throw new Error("Connection metadata values must be finite scalar values");
    }
  }
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > METADATA_BYTES) throw new Error("Connection metadata exceeds 32 KiB");
}

export function mergedMetadata(current: Metadata, patch: MetadataPatch): Metadata {
  validateMetadata(current); validateMetadata(patch, true);
  const merged = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete merged[key]; else Object.defineProperty(merged, key, { value, enumerable: true, writable: true, configurable: true });
  }
  validateMetadata(merged);
  return merged;
}

/** Initial snapshots belong to one logical save; later saves use separate journal events. */
export function initialProvenancePatch(current: Metadata, proposed: Metadata): Metadata {
  validateMetadata(current); validateMetadata(proposed);
  if (current.ab_save_id !== undefined && (current.ab_save_id !== proposed.ab_save_id || current.ab_snapshot_sha256 !== proposed.ab_snapshot_sha256)) {
    throw new Error("This connection already records a different save snapshot; original provenance must not be overwritten");
  }
  if (current.ab_save_id !== undefined) {
    const owned = (key: string) => key.startsWith("ab_snapshot_") || ["ab_schema", "ab_save_id", "ab_plan_hash", "ab_origin", "ab_initiator_kind", "ab_credential_profile", "ab_account_verified"].includes(key);
    for (const key of new Set([...Object.keys(current), ...Object.keys(proposed)])) {
      if (owned(key) && current[key] !== proposed[key]) throw new Error("Original snapshot encoding must not be replaced or leave stale chunks");
    }
  }
  mergedMetadata(current, proposed);
  return proposed;
}

function chunks(value: string): string[] {
  const result: string[] = []; let current = "", bytes = 0;
  // Iterate code points to avoid cutting a surrogate pair, while bounding UTF-16 length too.
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > 1800) { result.push(current); current = ""; bytes = 0; }
    current += character; bytes += size;
  }
  if (current) result.push(current);
  return result;
}

/** Full export either fits exactly or rejects before publication; summary explicitly declares incompleteness. */
export function provenanceMetadata(snapshotInput: SaveSnapshot, mode: "summary" | "full"): Metadata {
  const snapshot = saveSnapshotSchema.parse(snapshotInput);
  const serialized = JSON.stringify(snapshot);
  const metadata: Metadata = {
    ab_schema: 1, ab_save_id: snapshot.saveId,
    ab_snapshot_sha256: createHash("sha256").update(serialized).digest("hex"),
    ab_plan_hash: snapshot.plan.hash, ab_origin: snapshot.origin,
    ab_initiator_kind: snapshot.initiator.kind,
    ab_credential_profile: snapshot.authentication.credentialProfile,
    ab_account_verified: false, ab_snapshot_complete: mode === "full",
  };
  if (mode === "full") {
    const parts = chunks(serialized);
    metadata.ab_snapshot_encoding = "json_utf8_chunks_v1";
    metadata.ab_snapshot_chunks = parts.length;
    parts.forEach((part, index) => { metadata[`ab_snapshot_${String(index).padStart(2, "0")}`] = part; });
  }
  validateMetadata(metadata);
  if (Object.keys(metadata).length > 40 || Buffer.byteLength(JSON.stringify(metadata), "utf8") > PROVENANCE_BYTES) {
    throw new Error("Complete remote provenance exceeds its reserved 40-key/28,000-byte budget; choose explicit summary mode or retain the private snapshot. No save was attempted");
  }
  return metadata;
}

export function readProvenanceMetadata(metadata: Metadata): SaveSnapshot {
  validateMetadata(metadata);
  if (metadata.ab_schema !== 1 || metadata.ab_snapshot_complete !== true || metadata.ab_snapshot_encoding !== "json_utf8_chunks_v1"
    || typeof metadata.ab_snapshot_chunks !== "number" || !Number.isInteger(metadata.ab_snapshot_chunks) || metadata.ab_snapshot_chunks < 1 || metadata.ab_snapshot_chunks > 29) {
    throw new Error("Metadata does not contain a complete supported snapshot");
  }
  let serialized = "";
  for (let i = 0; i < metadata.ab_snapshot_chunks; i++) {
    const part = metadata[`ab_snapshot_${String(i).padStart(2, "0")}`];
    if (typeof part !== "string") throw new Error("Missing provenance chunk");
    serialized += part;
  }
  if (createHash("sha256").update(serialized).digest("hex") !== metadata.ab_snapshot_sha256) throw new Error("Provenance checksum mismatch");
  const snapshot = saveSnapshotSchema.parse(JSON.parse(serialized));
  if (snapshot.schemaVersion !== 1 || snapshot.schema !== "arena-block.save.v1" || snapshot.saveId !== metadata.ab_save_id || snapshot.plan?.hash !== metadata.ab_plan_hash) throw new Error("Provenance envelope identity mismatch");
  const plan = blockPlanSchema.parse(snapshot.plan);
  const { hash, ...content } = plan;
  if (planHash(content) !== hash) throw new Error("Provenance plan checksum mismatch");
  if (snapshot.origin !== metadata.ab_origin || snapshot.initiator.kind !== metadata.ab_initiator_kind
    || snapshot.authentication.credentialProfile !== metadata.ab_credential_profile || metadata.ab_account_verified !== false) {
    throw new Error("Provenance envelope identity mismatch");
  }
  return snapshot;
}
