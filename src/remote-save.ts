import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { ArenaClient } from "./arena.ts";
import type { ArenaBlockStore } from "./store.ts";
import type { CreationAttempt, PublicationReceipt, PublishRequest } from "./types.ts";
import { planHash } from "./compose.ts";
import { normalizeChannels } from "./config.ts";
import { saveSnapshotSchema, snapshotDefaultChannel, type SaveSnapshot } from "./provenance-schema.ts";
import { redactProvenance } from "./provenance-redaction.ts";
import { initialProvenancePatch, mergedMetadata, provenanceMetadata, validateMetadata, type Metadata } from "./connection-metadata.ts";

const policyChannelSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/).transform(value => normalizeChannels([value])[0]!);
export const remoteProvenancePolicySchema = z.object({
  defaultChannel: policyChannelSchema.optional(),
  inboxChannel: policyChannelSchema.optional(),
  mode: z.enum(["summary", "full"]),
  credentialProfile: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/),
  expectedAccountId: z.number().int().positive().safe(),
}).strict().superRefine((value, context) => {
  if (!(value.defaultChannel ?? value.inboxChannel) || value.defaultChannel && value.inboxChannel && value.defaultChannel !== value.inboxChannel) {
    context.addIssue({ code: "custom", path: ["defaultChannel"], message: "Configure one provenance default channel; legacy inboxChannel must agree" });
  }
}).transform(({ inboxChannel, ...value }) => ({ ...value, defaultChannel: (value.defaultChannel ?? inboxChannel)! }));
export type RemoteProvenancePolicy = z.input<typeof remoteProvenancePolicySchema>;
export type RemoteSaveRecord = {
  saveId: string;
  intent: {
    planHash: string; snapshot: SaveSnapshot; snapshotSha256: string; mode: "summary" | "full";
    accountId: number; credentialProfile: string; inboxChannelId: number; channelIds: number[]; metadata: Metadata;
  };
  attemptedChannels: number[];
  state: "prepared" | "pending" | "verified" | "unknown";
  attemptId?: string; blockId?: number; receiptId?: string; connectionId?: number;
};
export type RemoteSaveEvent = {
  saveId: string;
  intent: {
    planHash: string; receiptId: string; blockId: number; snapshot: SaveSnapshot; snapshotSha256: string;
    mode: "summary" | "full"; accountId: number; credentialProfile: string; inboxChannelId: number;
    channelIds: number[]; originalSaveId?: string;
  };
  state: "prepared" | "pending" | "verified";
  connectionId?: number;
  initialPlacementAttempted?: boolean;
};
export type RemoteConnectionMigration = {
  saveId: string; accountId: number; blockId: number; fromChannelId: number; fromConnectionId: number;
  toChannelId: number; toConnectionId: number; metadataSha256: string; migratedAt: string;
};

/** A fresh save cannot replace an unfinished original block or its provenance. */
export class RetainedSaveRecoveryError extends Error {
  readonly code = "retained_recovery";
}
/** Optional until an existing installation has the migration journal schema. Absence never authorizes relocation. */
export function remoteConnectionMigration(store: ArenaBlockStore, saveId: string): RemoteConnectionMigration | undefined {
  return (store as ArenaBlockStore & { remoteConnectionMigration?: (id: string) => RemoteConnectionMigration | undefined }).remoteConnectionMigration?.(saveId);
}
export function legacyReplayMigration(store: ArenaBlockStore, snapshot: SaveSnapshot, snapshotSha256: string): RemoteConnectionMigration | undefined {
  const direct = store.remoteSave(snapshot.saveId), event = store.remoteSaveEvent(snapshot.saveId);
  const original = direct ?? (event?.intent.originalSaveId ? store.remoteSave(event.intent.originalSaveId) : undefined);
  const migration = original && remoteConnectionMigration(store, original.saveId);
  const intent = direct?.intent ?? event?.intent;
  if (!original || !migration || !intent || intent.snapshotSha256 !== snapshotSha256 || !isDeepStrictEqual(intent.snapshot, snapshot)
    || intent.inboxChannelId !== migration.fromChannelId || original.blockId !== migration.blockId
    || original.intent.accountId !== migration.accountId || original.intent.inboxChannelId !== migration.fromChannelId
    || original.connectionId !== migration.fromConnectionId) return undefined;
  return migration;
}
type Json = Record<string, unknown>;
function object(value: unknown): Json | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined; }
function id(value: unknown): number | undefined { return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined; }
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Original block provenance remains immutable; later saves have separate durable events. */
export class RemoteSaveManager {
  private readonly policy?: z.infer<typeof remoteProvenancePolicySchema>;
  constructor(private readonly client: ArenaClient, private readonly store: ArenaBlockStore, policy?: RemoteProvenancePolicy) {
    this.policy = policy && remoteProvenancePolicySchema.parse(policy);
    if (this.policy) this.store.requirePrivateState();
  }

  private location(record: RemoteSaveRecord) {
    const migration = remoteConnectionMigration(this.store, record.saveId);
    if (!migration) return { channelId: record.intent.inboxChannelId, connectionId: record.connectionId };
    if (migration.accountId !== record.intent.accountId || migration.blockId !== record.blockId
      || migration.fromChannelId !== record.intent.inboxChannelId || migration.fromConnectionId !== record.connectionId) {
      throw new Error("Provenance relocation does not match the immutable original save");
    }
    return { channelId: migration.toChannelId, connectionId: migration.toConnectionId, migration };
  }

  /** Only a byte-identical original save can replay its retired automatic destination at the verified relocation. */
  replayDestinations(record: RemoteSaveRecord | undefined, destinations: string[]): string[] {
    if (!record) return destinations;
    const location = this.location(record);
    if (!location.migration) return destinations;
    const oldDefault = snapshotDefaultChannel(record.intent.snapshot)?.channel;
    return normalizeChannels(destinations.map(value => value === String(location.migration!.fromChannelId) || value === oldDefault ? String(location.channelId) : value));
  }

  replaySaveDestinations(saveId: string | undefined, destinations: string[]): string[] {
    if (!saveId) return destinations;
    const original = this.store.remoteSave(saveId);
    if (original) return this.replayDestinations(original, destinations);
    const event = this.store.remoteSaveEvent(saveId);
    const first = event?.intent.originalSaveId && this.store.remoteSave(event.intent.originalSaveId);
    if (!event || !first || this.location(first).migration?.fromChannelId !== event.intent.inboxChannelId) return destinations;
    const location = this.location(first);
    const oldDefault = snapshotDefaultChannel(event.intent.snapshot)?.channel;
    return normalizeChannels(destinations.map(target => target === String(event.intent.inboxChannelId) || target === oldDefault ? String(location.channelId) : target));
  }

  async withLease<T>(saveId: string | undefined, action: () => Promise<T>): Promise<T> {
    if (!saveId) return action();
    const owner = crypto.randomUUID();
    if (!this.store.reserveRemoteSaveLease(saveId, owner)) throw new Error("This save is active in another publisher; inspect or retry the same save later");
    try { return await action(); } finally { this.store.releaseRemoteSaveLease(saveId, owner); }
  }

  private async scope(signal?: AbortSignal): Promise<{ accountId: number; inboxChannelId: number }> {
    if (!this.policy) throw new Error("Remote provenance is disabled on this daemon; configure an explicit existing-account policy first");
    signal?.throwIfAborted();
    const [account, channel] = await Promise.all([this.client.me(signal), this.client.channel(this.policy.defaultChannel, signal)]);
    const accountId = id(account.id), inboxChannelId = id(channel.id);
    if (accountId !== this.policy.expectedAccountId) throw new Error("Authenticated Are.na account does not match the daemon's expected account");
    if (!inboxChannelId || channel.visibility !== "private" || id(object(channel.owner)?.id) !== accountId || object(channel.owner)?.type !== "User" || object(channel.can)?.add_to !== true) throw new Error("Provenance default channel must be confirmed owned, private and writable before a save or update");
    return { accountId, inboxChannelId };
  }

  async prepare(request: PublishRequest, signal?: AbortSignal): Promise<RemoteSaveRecord | undefined> {
    if (!request.remoteSave) {
      const existing = this.store.latestReceiptForPlan(request.plan.hash);
      if (existing?.remoteProvenance && !request.force) throw new Error("This plan has remote provenance; resume its receipt or replay its original save intent");
      return undefined;
    }
    if (!this.policy) throw new Error("Remote provenance is disabled on this daemon");
    const snapshot = saveSnapshotSchema.parse(request.remoteSave.snapshot);
    if (request.operationId !== snapshot.saveId || request.remoteSave.mode !== this.policy.mode
      || snapshot.authentication.credentialProfile !== this.policy.credentialProfile
      || snapshot.authentication.expectedAccountId !== undefined && snapshot.authentication.expectedAccountId !== this.policy.expectedAccountId
      || snapshot.invocation.force !== request.force || snapshot.invocation.operation !== "publish") throw new Error("Remote save does not match the daemon policy or publication operation");
    if (hash(snapshot) !== request.remoteSave.snapshotSha256) throw new Error("Remote snapshot checksum mismatch");
    const { hash: originalHash, ...content } = request.plan;
    if (planHash(content) !== originalHash) throw new Error("Publication plan checksum mismatch");
    const redacted = redactProvenance(content);
    const expectedPlan = { ...redacted.value, hash: redacted.paths.length ? planHash(redacted.value) : originalHash };
    if (!isDeepStrictEqual(snapshot.plan, expectedPlan) || !isDeepStrictEqual(redactProvenance(snapshot).value, snapshot)) throw new Error("Remote snapshot must contain this publication's redacted plan and structured arguments");
    if (snapshot.fidelity.originalPlanPreserved !== (redacted.paths.length === 0)
      || snapshot.redaction.originalPlanHashOmitted !== (redacted.paths.length > 0)) throw new Error("Remote snapshot fidelity does not match its plan");
    const priorOriginal = this.store.remoteSave(snapshot.saveId);
    const relocation = priorOriginal && this.location(priorOriginal).migration;
    const priorEvent = this.store.remoteSaveEvent(snapshot.saveId);
    const eventOriginal = priorEvent?.intent.originalSaveId && this.store.remoteSave(priorEvent.intent.originalSaveId);
    const eventRelocation = eventOriginal && this.location(eventOriginal).migration;
    const inbox = snapshotDefaultChannel(snapshot);
    if (!inbox?.included || inbox.channel !== this.policy.defaultChannel && !relocation && !eventRelocation
      || !isDeepStrictEqual(normalizeChannels(request.destinations), snapshot.routing.destinations)) throw new Error("Remote provenance requires the configured default channel in the exact planned destinations");
    // Serialize and clone before any await; callers cannot race a capsule with authorization reads.
    const frozen = JSON.parse(JSON.stringify(snapshot)) as SaveSnapshot;
    if (Buffer.byteLength(JSON.stringify(frozen), "utf8") > 2 * 1024 * 1024)
      throw new Error("Remote save event exceeds the private 2 MiB snapshot bound; no write was attempted");
    const { accountId, inboxChannelId } = await this.scope(signal);
    if (priorOriginal && relocation) {
      if (!isDeepStrictEqual(priorOriginal.intent.snapshot, frozen) || priorOriginal.intent.snapshotSha256 !== request.remoteSave.snapshotSha256
        || priorOriginal.intent.planHash !== originalHash || priorOriginal.intent.accountId !== accountId || relocation.toChannelId !== inboxChannelId
        || priorOriginal.intent.credentialProfile !== this.policy.credentialProfile || priorOriginal.intent.mode !== this.policy.mode
        || !priorOriginal.receiptId || !priorOriginal.blockId) throw new Error("Relocated save replay must preserve its exact original intent and authenticated scope");
      const receipt = this.store.receipt(priorOriginal.receiptId);
      if (!receipt || receipt.blockId !== priorOriginal.blockId) throw new Error("Relocated save has no retained original receipt; no new creation was attempted");
      await this.authorizeReceipt(receipt, signal);
      return priorOriginal;
    }
    if (priorEvent && eventRelocation) {
      if (!isDeepStrictEqual(priorEvent.intent.snapshot, frozen) || priorEvent.intent.snapshotSha256 !== request.remoteSave.snapshotSha256
        || priorEvent.intent.accountId !== accountId || priorEvent.intent.inboxChannelId !== eventRelocation.fromChannelId
        || eventRelocation.toChannelId !== inboxChannelId || priorEvent.intent.credentialProfile !== this.policy.credentialProfile
        || priorEvent.intent.mode !== this.policy.mode) throw new Error("Relocated later event must replay its exact original intent and authenticated scope");
      const receipt = this.store.receipt(priorEvent.intent.receiptId);
      if (!receipt || receipt.blockId !== priorEvent.intent.blockId) throw new Error("Relocated event has no original block receipt; no creation was attempted");
      await this.authorizeReceipt(receipt, signal);
      return undefined;
    }
    const channelIds = await this.client.channelIds(request.destinations, signal);
    if (!channelIds.includes(inboxChannelId)) throw new Error("Resolved destinations do not include the authorized inbox");
    await this.authorizeChannels(channelIds, signal);
    const existing = !request.force && (this.store.operationState(frozen.saveId)?.receipt ?? this.store.latestReceiptForPlan(originalHash));
    if (existing && !priorOriginal) {
      const previous = this.store.remoteSaveEvent(frozen.saveId);
      const original = existing.remoteProvenance ? this.store.remoteSaveForReceipt(existing.id) : undefined;
      if (existing.remoteProvenance && (!original || original.saveId !== existing.remoteProvenance.saveId
        || original.blockId !== existing.blockId || original.intent.accountId !== accountId
        || this.location(original).channelId !== inboxChannelId || original.intent.credentialProfile !== this.policy.credentialProfile
        || original.intent.mode !== this.policy.mode))
        throw new Error("Existing block's original remote provenance is missing or has another authenticated scope");
      if (!previous && (existing.status !== "verified" || existing.pendingDestinations?.length
        || existing.remoteProvenance?.state !== undefined && existing.remoteProvenance.state !== "verified")) {
        if (!original) {
          const block = await this.client.block(existing.blockId, signal);
          if (id(object(block.user)?.id) !== accountId) throw new Error("Existing block belongs to another or unverified account");
        }
        throw new RetainedSaveRecoveryError(`The existing block is not fully verified at ${existing.blockUrl}. Inspect its original receipt: arena-block inspect ${existing.id}${original ? `; recover that save with arena-block retry-save ${original.saveId}` : `; resume that receipt with arena-block resume ${existing.id}`}`);
      }
      const event: RemoteSaveEvent = {
        saveId: frozen.saveId,
        intent: { planHash: originalHash, receiptId: existing.id, blockId: existing.blockId,
          snapshot: frozen, snapshotSha256: request.remoteSave.snapshotSha256, mode: request.remoteSave.mode,
          accountId, credentialProfile: this.policy.credentialProfile, inboxChannelId, channelIds,
          ...(original ? { originalSaveId: original.saveId } : {}) },
        state: "prepared",
      };
      if (previous) {
        if (!isDeepStrictEqual(previous.intent, event.intent)) throw new Error("Remote save event ID already belongs to another immutable intent");
      } else {
        if (this.store.pendingRemoteSaveEvent(existing.id, event.saveId))
          throw new Error("A prior Inbox metadata event is unresolved; replay that save before starting another");
        this.store.saveRemoteSaveEvent(event);
      }
      return undefined;
    }
    if (this.store.remoteSaveEvent(frozen.saveId)) throw new Error("This save ID already belongs to a later event; it cannot create another block");
    const metadata = provenanceMetadata(frozen, request.remoteSave.mode);
    const record: RemoteSaveRecord = {
      saveId: frozen.saveId,
      intent: { planHash: originalHash, snapshot: frozen, snapshotSha256: request.remoteSave.snapshotSha256, mode: request.remoteSave.mode,
        accountId, credentialProfile: this.policy.credentialProfile, inboxChannelId, channelIds,
        metadata: { ...metadata, ab_actor_id: accountId, ab_actor_verified: true } },
      attemptedChannels: [], state: "prepared",
    };
    validateMetadata(record.intent.metadata);
    const previous = priorOriginal;
    // Replaying is allowed only for byte-identical intent and the same verified account/channel scope.
    if (previous) {
      if (!isDeepStrictEqual(previous.intent, record.intent)) throw new Error("Remote save ID already belongs to another intent or authenticated scope");
      return previous;
    }
    if (existing) throw new Error("This plan already has a block; a new save ID must not replace its original event. Resume the receipt");
    this.store.saveRemoteSave(record);
    return record;
  }

  private async authorizeChannels(ids: number[], signal?: AbortSignal): Promise<void> {
    const channels = await Promise.all(ids.map(channelId => this.client.channel(channelId, signal)));
    if (channels.some((channel, index) => id(channel.id) !== ids[index] || object(channel.can)?.add_to !== true)) throw new Error("Every destination must be confirmed writable before its placement");
  }

  validateReuse(record: RemoteSaveRecord | undefined, receipt: PublicationReceipt): void {
    if (record && receipt.remoteProvenance?.saveId !== record.saveId) throw new Error("Existing block records another original save; its provenance must not be overwritten");
  }

  async authorizeReceipt(receipt: PublicationReceipt, signal?: AbortSignal): Promise<RemoteSaveRecord | undefined> {
    if (!receipt.remoteProvenance) return undefined;
    const record = this.store.remoteSaveForReceipt(receipt.id);
    if (!record || record.blockId !== receipt.blockId || record.saveId !== receipt.remoteProvenance.saveId) throw new Error("Remote publication journal is missing or inconsistent; no write attempted");
    const scope = await this.scope(signal);
    const location = this.location(record);
    if (scope.accountId !== record.intent.accountId || scope.inboxChannelId !== location.channelId
      || this.policy?.credentialProfile !== record.intent.credentialProfile || this.policy?.mode !== record.intent.mode) throw new Error("Remote publication must resume with its original authenticated account and policy");
    if (location.migration) await this.knownInboxConnection(record, receipt.blockId, signal);
    return record;
  }

  /** A later save is an event on the existing block, never a replacement for its original capsule. */
  async completeEvent(saveId: string | undefined, receipt: PublicationReceipt, signal?: AbortSignal): Promise<void> {
    if (!saveId) return;
    const event = this.store.remoteSaveEvent(saveId);
    if (!event || event.state === "verified") return;
    if (!this.policy || receipt.id !== event.intent.receiptId || receipt.blockId !== event.intent.blockId
      || receipt.planHash !== event.intent.planHash || receipt.status !== "verified"
      || receipt.pendingDestinations?.length
      || event.intent.channelIds.length === 0) throw new Error("Later save event does not match a fully verified original receipt");
    const scope = await this.scope(signal);
    const original = receipt.remoteProvenance ? await this.authorizeReceipt(receipt, signal) : undefined;
    const relocation = original && this.location(original).migration;
    const eventChannelId = relocation && event.intent.inboxChannelId === relocation.fromChannelId ? relocation.toChannelId : event.intent.inboxChannelId;
    if (scope.accountId !== event.intent.accountId || scope.inboxChannelId !== eventChannelId
      || this.policy.credentialProfile !== event.intent.credentialProfile || this.policy.mode !== event.intent.mode)
      throw new Error("Later save event changed its authenticated account or Inbox policy");
    if (event.intent.originalSaveId !== original?.saveId) throw new Error("Later save event has another original provenance record");
    if (!original) {
      const block = await this.client.block(receipt.blockId, signal);
      if (id(object(block.user)?.id) !== scope.accountId) throw new Error("Legacy block does not belong to the authenticated account");
    }
    const originalConnection = original && this.location(original).connectionId;
    const evidence = originalConnection ? undefined : await this.placement(scope.inboxChannelId, receipt.blockId, signal);
    if (!originalConnection && !evidence) throw new Error("Default placement is unconfirmed; event metadata was not written");
    const connectionId = originalConnection
      ? await this.knownInboxConnection(original, receipt.blockId, signal)
      : original ? await this.verifyConnection(original, evidence!, receipt.blockId, signal) : id(evidence?.id);
    if (!connectionId) throw new Error("Inbox placement has no verified connection ID");
    const patch: Metadata = {
      ab_latest_save_id: event.saveId,
      ab_latest_snapshot_sha256: event.intent.snapshotSha256,
      ab_latest_receipt_id: receipt.id,
      ab_latest_event_kind: original ? "reused_block" : "legacy_block",
    };
    let current = await this.client.connection(connectionId, signal);
    if (id(current.id) !== connectionId || id(object(current.connected_by)?.id) !== scope.accountId)
      throw new Error("Inbox connection actor changed before event metadata update");
    this.validateEventMetadata(event, receipt, (current.metadata ?? {}) as Metadata, patch, original);
    event.state = "pending"; event.connectionId = connectionId; this.store.saveRemoteSaveEvent(event);
    if (!Object.entries(patch).every(([key, value]) => object(current.metadata)?.[key] === value))
      await this.client.updateConnectionMetadata(connectionId, patch, signal);
    current = await this.client.connection(connectionId, signal);
    if (id(current.id) !== connectionId || id(object(current.connected_by)?.id) !== scope.accountId)
      throw new Error("Inbox connection actor changed during event metadata readback");
    const metadata = (current.metadata ?? {}) as Metadata;
    if (original) initialProvenancePatch(metadata, original.intent.metadata);
    if (!Object.entries(patch).every(([key, value]) => metadata[key] === value))
      throw new Error("Inbox event metadata outcome remains pending; replay the same save");
    event.state = "verified"; this.store.saveRemoteSaveEvent(event);
  }

  private eventPlacementPatch(event: RemoteSaveEvent): Metadata {
    return { ab_latest_save_id: event.saveId, ab_latest_snapshot_sha256: event.intent.snapshotSha256,
      ab_latest_receipt_id: event.intent.receiptId, ab_latest_event_kind: "legacy_block" };
  }

  private validateEventMetadata(event: RemoteSaveEvent, receipt: PublicationReceipt, metadata: Metadata, patch: Metadata, original?: RemoteSaveRecord): void {
    if (original) initialProvenancePatch(metadata, original.intent.metadata);
    else if (metadata.ab_save_id !== undefined) throw new Error("Legacy Inbox connection has another original provenance record");
    const previousId = metadata.ab_latest_save_id;
    if (previousId !== undefined && previousId !== event.saveId) {
      if (typeof previousId !== "string") throw new Error("Inbox event pointer is invalid");
      const previous = this.store.remoteSaveEvent(previousId);
      if (!previous || previous.intent.receiptId !== receipt.id || previous.state !== "verified")
        throw new Error("Inbox event pointer belongs to an unknown or unresolved save; no metadata was overwritten");
    } else if (previousId === event.saveId) {
      for (const [key, value] of Object.entries(patch)) {
        if (metadata[key] !== undefined && metadata[key] !== value)
          throw new Error("This save ID already has conflicting Inbox event metadata");
      }
    } else if (Object.keys(patch).some(key => metadata[key] !== undefined)) {
      throw new Error("Inbox event metadata has no matching save ID; no metadata was overwritten");
    }
    mergedMetadata(metadata, patch);
  }

  /** An existing block's first new default placement carries its retained event summary. */
  async initialEventPlacement(receipt: PublicationReceipt, channelId: number, signal?: AbortSignal): Promise<Metadata | undefined> {
    const event = this.store.pendingRemoteSaveEvent(receipt.id, "");
    if (!event || event.intent.inboxChannelId !== channelId || event.intent.originalSaveId) return undefined;
    const scope = await this.scope(signal);
    const block = await this.client.block(receipt.blockId, signal);
    if (scope.accountId !== event.intent.accountId || scope.inboxChannelId !== channelId
      || event.intent.blockId !== receipt.blockId || id(object(block.user)?.id) !== scope.accountId)
      throw new Error("First default placement does not match the retained event and authenticated block");
    const patch = this.eventPlacementPatch(event); validateMetadata(patch);
    event.initialPlacementAttempted = true; event.state = "pending"; this.store.saveRemoteSaveEvent(event);
    return patch;
  }

  async verifyInitialEventPlacement(receipt: PublicationReceipt, channelId: number, signal?: AbortSignal): Promise<void> {
    const event = this.store.pendingRemoteSaveEvent(receipt.id, "");
    if (!event || event.intent.inboxChannelId !== channelId || event.intent.originalSaveId) return;
    const scope = await this.scope(signal), block = await this.client.block(receipt.blockId, signal);
    if (scope.accountId !== event.intent.accountId || scope.inboxChannelId !== channelId
      || event.intent.blockId !== receipt.blockId || id(object(block.user)?.id) !== scope.accountId)
      throw new Error("Default event placement does not match the retained event and authenticated block");
    const evidence = await this.placement(channelId, receipt.blockId, signal);
    if (!evidence) throw new Error("First default event placement remains unconfirmed; later placements were not sent");
    const connectionId = id(evidence.id)!;
    const connection = await this.client.connection(connectionId, signal);
    if (id(connection.id) !== connectionId || id(object(connection.connected_by)?.id) !== event.intent.accountId)
      throw new Error("First default event provenance remains unconfirmed; later placements were not sent");
    const metadata = (connection.metadata ?? {}) as Metadata, patch = this.eventPlacementPatch(event);
    this.validateEventMetadata(event, receipt, metadata, patch);
    if (event.initialPlacementAttempted && !Object.entries(patch).every(([key, value]) => metadata[key] === value))
      throw new Error("First default event provenance remains unconfirmed; later placements were not sent");
    event.connectionId = connectionId; this.store.saveRemoteSaveEvent(event);
  }

  creationPayload(payload: Json, record?: RemoteSaveRecord): Json {
    if (!record) return payload;
    const { channel_ids: _, channels: __, ...block } = payload;
    return { ...block, channels: [{ id: record.intent.inboxChannelId, metadata: record.intent.metadata }] };
  }

  beforeCreation(record: RemoteSaveRecord, attempt: CreationAttempt): void {
    record.attemptId = attempt.id; record.attemptedChannels = [record.intent.inboxChannelId]; record.state = "pending";
    this.store.saveRemoteSave(record);
  }
  creationUnknown(record: RemoteSaveRecord): void { record.state = "unknown"; this.store.saveRemoteSave(record); }
  recordCreated(record: RemoteSaveRecord, receipt: PublicationReceipt): void {
    record.blockId = receipt.blockId; record.receiptId = receipt.id; record.state = "pending";
    this.store.saveRemoteSave(record);
  }
  receiptState(record: RemoteSaveRecord): NonNullable<PublicationReceipt["remoteProvenance"]> {
    const location = this.location(record);
    return { saveId: record.saveId, snapshotSha256: record.intent.snapshotSha256, accountId: record.intent.accountId,
      credentialProfile: record.intent.credentialProfile, inboxChannelId: location.channelId,
      ...(location.connectionId ? { connectionId: location.connectionId } : {}), state: record.state === "verified" ? "verified" : record.state === "unknown" ? "unknown" : "pending" };
  }

  private async placement(channelId: number, blockId: number, signal?: AbortSignal): Promise<Json | undefined> {
    const row = await this.client.channelPlacement(channelId, blockId, signal);
    if (!row) return undefined;
    const connection = object(row.connection);
    if (!id(connection?.id)) throw new Error("Channel evidence has no valid connection ID");
    return connection;
  }

  async reconcileCreation(record: RemoteSaveRecord, attempt: CreationAttempt, signal?: AbortSignal): Promise<number> {
    if (record.attemptId !== attempt.id || record.intent.planHash !== attempt.planHash) throw Object.assign(new Error("This unresolved creation belongs to another save; no retry attempted"), { attempt });
    const scan = await this.client.channelContents(record.intent.inboxChannelId, signal);
    const matches = scan.entries.filter(entry => entry.type !== "Channel" && object(object(entry.connection)?.metadata)?.ab_save_id === record.saveId);
    if (!scan.complete || matches.length !== 1 || !id(matches[0]?.id)) throw Object.assign(new Error("Creation outcome remains unknown after bounded inbox reconciliation; no new block was created"), { attempt });
    const blockId = id(matches[0]!.id)!;
    if (record.blockId && record.blockId !== blockId) throw new Error("Reconciled block conflicts with the durable known block");
    await this.verifyConnection(record, object(matches[0]!.connection)!, blockId, signal, false);
    return blockId;
  }

  private async verifyConnection(record: RemoteSaveRecord, evidence: Json, blockId: number, signal?: AbortSignal, allowRepair = true): Promise<number> {
    const connectionId = id(evidence.id);
    if (!connectionId) throw new Error("Missing verified inbox connection ID");
    const connection = await this.client.connection(connectionId, signal);
    // GET connection has no documented block/channel IDs. The scoped contents read above supplies that mapping.
    if (connection.id !== connectionId || this.location(record).connectionId && this.location(record).connectionId !== connectionId
      || id(object(connection.connected_by)?.id) !== record.intent.accountId) throw new Error("Inbox connection does not match its channel evidence, block, and authenticated actor");
    const current = (connection.metadata ?? {}) as Metadata;
    const proposed = record.intent.metadata;
    initialProvenancePatch(current, proposed);
    const matches = Object.entries(proposed).every(([key, value]) => current[key] === value);
    if (!matches) {
      if (!allowRepair) throw new Error("Reconciled save metadata is incomplete; creation outcome remains unknown");
      await this.client.updateConnectionMetadata(connectionId, proposed, signal);
      const verified = await this.client.connection(connectionId, signal);
      this.assertReadback(record, verified, connectionId);
    }
    return connectionId;
  }

  /** A recorded connection needs current block membership, without enumerating a growing Inbox. */
  private async knownInboxConnection(record: RemoteSaveRecord, blockId: number, signal?: AbortSignal): Promise<number> {
    const location = this.location(record);
    if (!location.connectionId || !(await this.client.completeBlockConnections(blockId, signal)).has(location.channelId))
      throw new Error("Recorded Inbox connection has no confirmed block membership");
    const connection = await this.client.connection(location.connectionId, signal);
    this.assertReadback(record, connection, location.connectionId);
    return location.connectionId;
  }

  private assertReadback(record: RemoteSaveRecord, connection: Json, connectionId: number): void {
    if (connection.id !== connectionId || id(object(connection.connected_by)?.id) !== record.intent.accountId) throw new Error("Provenance readback has a different connection or authenticated actor");
    const current = (connection.metadata ?? {}) as Metadata;
    initialProvenancePatch(current, record.intent.metadata);
    if (!Object.entries(record.intent.metadata).every(([key, value]) => current[key] === value)) throw new Error("Original provenance changed during readback; outcome remains unknown");
  }

  async ensurePlacements(receipt: PublicationReceipt, destinations: string[], signal?: AbortSignal): Promise<PublicationReceipt> {
    const record = (await this.authorizeReceipt(receipt, signal))!;
    try {
      const snapshot = this.store.receiptSnapshot(receipt.id);
      const location = this.location(record);
      const inherited = this.replayDestinations(record, [...snapshot.receipt.destinations, ...(snapshot.receipt.pendingDestinations ?? [])]);
      const known = normalizeChannels([...inherited, ...destinations]);
      const resolved = await Promise.all(known.map(async target => (await this.client.channelIds([target], signal))[0]!));
      const ids = [location.channelId, ...new Set(resolved.filter(channelId => channelId !== location.channelId))];
      await this.authorizeChannels(ids, signal);
      // Resolve the first Inbox connection by contents, then use its durable ID and
      // block-scoped membership on later saves as the Inbox grows.
      let connectionId: number;
      if (location.connectionId) connectionId = await this.knownInboxConnection(record, receipt.blockId, signal);
      else {
        const inbox = await this.placement(location.channelId, receipt.blockId, signal);
        if (!inbox) throw new Error("Initial inbox placement is unconfirmed; no duplicate connect was attempted");
        connectionId = await this.verifyConnection(record, inbox, receipt.blockId, signal);
        record.connectionId = connectionId;
      }
      const observed = new Map<number, number>();
      observed.set(location.channelId, connectionId);
      // Read the complete block connection list before scheduling missing placements.
      const membership = await this.client.completeBlockConnections(receipt.blockId, signal);
      for (const channelId of ids.filter(channelId => channelId !== location.channelId)) {
        if (!membership.has(channelId)) continue;
        const connection = await this.placement(channelId, receipt.blockId, signal);
        if (!connection) throw new Error("Block membership has no matching channel connection ID; no new placement was attempted");
        observed.set(channelId, id(connection.id)!);
        this.store.rememberBlockConnectionAttempts(receipt.blockId, [channelId], `save:${record.saveId}`);
      }
      this.store.rememberBlockConnectionAttempts(receipt.blockId, [...observed.keys()], `save:${record.saveId}`);
      const missing = ids.filter(channelId => !observed.has(channelId));
      for (const channelId of missing) {
        // Another client may have connected the block since the first read.
        if ((await this.client.completeBlockConnections(receipt.blockId, signal)).has(channelId)) {
          const connection = await this.placement(channelId, receipt.blockId, signal);
          if (!connection) throw new Error("Block membership has no matching channel connection ID; no new placement was attempted");
          observed.set(channelId, id(connection.id)!);
          this.store.rememberBlockConnectionAttempts(receipt.blockId, [channelId], `save:${record.saveId}`);
          continue;
        }
        if (record.attemptedChannels.includes(channelId)) throw new Error("A previously attempted placement remains unknown; no duplicate connect was attempted");
        signal?.throwIfAborted();
        if (!this.store.reserveBlockConnectionAttempt(receipt.blockId, channelId, `save:${record.saveId}`))
          throw new Error("This physical placement was already attempted by a retained intent; no duplicate connect was attempted");
        // Reserve before POST; response loss can only be resolved by subsequent reads.
        record.attemptedChannels = [...new Set([...record.attemptedChannels, channelId])]; record.state = "pending";
        this.store.saveRemoteSave(record);
        signal?.throwIfAborted();
        await this.client.connectWithMetadata(receipt.blockId, [{ id: channelId }], signal);
        const connection = await this.placement(channelId, receipt.blockId, signal);
        if (!connection) throw new Error("Placement response was not confirmed in its destination channel; later placements were not sent");
        observed.set(channelId, id(connection.id)!);
      }
      this.store.rememberBlockConnectionAttempts(receipt.blockId, [...observed.keys()], `save:${record.saveId}`);
      const patch: Metadata = { ab_result_status: "verified", ab_block_id: receipt.blockId, ab_receipt_id: receipt.id };
      const before = await this.client.connection(connectionId, signal);
      initialProvenancePatch((before.metadata ?? {}) as Metadata, record.intent.metadata);
      if (!Object.entries(patch).every(([key, value]) => object(before.metadata)?.[key] === value)) await this.client.updateConnectionMetadata(connectionId, patch, signal);
      const after = await this.client.connection(connectionId, signal);
      this.assertReadback(record, after, connectionId);
      if (!Object.entries(patch).every(([key, value]) => object(after.metadata)?.[key] === value)) throw new Error("Provenance outcome update remains pending");
      record.state = "verified"; this.store.saveRemoteSave(record);
      if (location.migration) this.store.updateReceipt(receipt.id, value => ({ ...value,
        destinations: this.replayDestinations(record, value.destinations),
        pendingDestinations: value.pendingDestinations && this.replayDestinations(record, value.pendingDestinations) }));
      const current = this.store.receiptSnapshot(receipt.id);
      // Resolve each argument independently: slug aliases can collapse to one numeric channel.
      const confirmed = known.filter((_, index) => observed.has(resolved[index]!));
      const retiredDefault = location.migration && observed.has(location.channelId)
        ? [String(location.migration.fromChannelId), snapshotDefaultChannel(record.intent.snapshot)!.channel] : [];
      const next = this.store.confirmPlacements(receipt.id, current.revision, confirmed, [...new Set(observed.values())], retiredDefault);
      if (!next) throw new Error("Placement intent changed while confirming; resume the retained receipt");
      return this.store.updateReceipt(receipt.id, value => ({ ...value, remoteProvenance: this.receiptState(record) }));
    } catch (error) {
      record.state = "unknown"; this.store.saveRemoteSave(record);
      this.store.updateReceipt(receipt.id, value => ({ ...value, remoteProvenance: this.receiptState(record) }));
      throw error;
    }
  }
}
