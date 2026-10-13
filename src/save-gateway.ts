import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { blockPlanSchema, publicationStateSchema, type PublishRequest } from "./types.ts";
import { saveSnapshotSchema, snapshotDefaultChannel, type SaveSnapshot } from "./provenance-schema.ts";
import { snapshotHash } from "./save-intent.ts";
import { planHash } from "./compose.ts";
import { redactProvenance } from "./provenance-redaction.ts";
import { normalizeChannels, type SaveOrigin } from "./config.ts";
import { abortable, deadline } from "./bounded-io.ts";
import type { ArenaClient, ArenaPublisher } from "./arena.ts";
import type { ArenaBlockStore } from "./store.ts";
import { legacyReplayMigration, RetainedSaveRecoveryError, type RemoteProvenancePolicy } from "./remote-save.ts";

export const saveSubmissionSchema = z.object({
  plan: blockPlanSchema,
  snapshot: saveSnapshotSchema,
  snapshotSha256: z.string().regex(/^[a-f0-9]{64}$/),
  remoteMode: z.enum(["summary", "full"]).optional(),
}).strict();
export const retainedIntentSchema = saveSubmissionSchema.omit({ plan: true });
export type SaveSubmission = z.infer<typeof saveSubmissionSchema>;
export type SaveContext = { submission: SaveSubmission; accountId?: number; credentialProfile: string; observation: "prepared" | "running" | "interrupted" | "failed"; cancelRequested: boolean;
  failure?: { code: "media_budget" | "media_inspection" | "authorization" | "deadline" | "retained_recovery"; message: string; retryable?: boolean } };
export const saveStatusSchema = publicationStateSchema.extend({
  saveId: z.uuid(),
  phase: z.enum(["prepared", "running", "saved", "partial", "unknown", "cancelled", "not_saved"]),
  active: z.boolean(), cancelRequested: z.boolean(),
  failure: z.object({ code: z.enum(["media_budget", "media_inspection", "authorization", "deadline", "retained_recovery"]), message: z.string(), retryable: z.boolean().optional() }).strict().optional(),
  authentication: z.discriminatedUnion("authenticatedAccountVerified", [
    z.object({ accountId: z.number().int().positive().safe(), credentialProfile: z.string(), authenticatedAccountVerified: z.literal(true) }).strict(),
    z.object({ credentialProfile: z.string(), authenticatedAccountVerified: z.literal(false) }).strict(),
  ]),
}).strict();
export type SaveStatus = z.infer<typeof saveStatusSchema>;
export type SaveBackend = { save(input: SaveSubmission, signal?: AbortSignal): Promise<SaveStatus>; status(id: string, signal?: AbortSignal): Promise<SaveStatus>; cancel(id: string, signal?: AbortSignal): Promise<SaveStatus> };

/** All transports share the publisher, operation journal and immutable account scope. */
export class SaveGateway {
  private active = new Map<string, { controller: AbortController; pending: Promise<unknown>; submission: SaveSubmission; cancelRequested: boolean }>();
  private stopping = false;
  constructor(private readonly client: ArenaClient, private readonly publisher: ArenaPublisher, private readonly store: ArenaBlockStore,
    private readonly credential: { profile: string; expectedAccountId?: number }, private readonly remotePolicy?: RemoteProvenancePolicy, private readonly timeoutMs = 300_000) {}

  status(id: string): SaveStatus {
    z.uuid().parse(id);
    const context = this.store.saveContext(id);
    if (!context) {
      const entry = this.active.get(id);
      if (!entry && !this.store.isSaveCancelled(id)) throw new Error("Save not found in this journal");
      return saveStatusSchema.parse({ operationId: id, saveId: id, phase: entry?.cancelRequested || this.store.isSaveCancelled(id) ? "cancelled" : "running", active: Boolean(entry), cancelRequested: entry?.cancelRequested ?? this.store.isSaveCancelled(id),
        authentication: { credentialProfile: this.credential.profile, authenticatedAccountVerified: false } });
    }
    const state = this.store.operationState(id) ?? { operationId: id };
    const active = this.active.has(id);
    const receipt = state.receipt;
    const event = this.store.remoteSaveEvent(id);
    const migration = legacyReplayMigration(this.store, context.submission.snapshot, context.submission.snapshotSha256);
    const relocated = migration && migration.blockId === receipt?.blockId;
    const oldDefault = snapshotDefaultChannel(context.submission.snapshot)?.channel;
    const targets = context.submission.snapshot.routing.destinations.map(target => relocated && (target === String(migration.fromChannelId) || target === oldDefault) ? String(migration.toChannelId) : target);
    const phase = !active && (!context.failure || context.failure.code === "deadline")
      && context.accountId !== undefined && receipt?.status === "verified"
      && targets.every(target => receipt.destinations.includes(target))
      && !receipt.pendingDestinations?.length && (!receipt.remoteProvenance || receipt.remoteProvenance.state === "verified")
      && (!event || event.state === "verified") ? "saved"
      : receipt ? "partial" : state.attempt && state.attempt.status !== "rejected" ? "unknown"
      : active ? "running" : context.cancelRequested ? "cancelled" : context.observation === "running" || context.observation === "interrupted" ? "unknown"
      : context.observation === "failed" || state.attempt?.status === "rejected" ? "not_saved" : "prepared";
    return saveStatusSchema.parse({ ...state, saveId: id, phase, active, cancelRequested: phase === "saved" ? false : context.cancelRequested,
      ...(phase !== "saved" && context.failure ? { failure: context.failure } : {}),
      authentication: context.accountId !== undefined ? { accountId: context.accountId, credentialProfile: context.credentialProfile, authenticatedAccountVerified: true } : { credentialProfile: context.credentialProfile, authenticatedAccountVerified: false } });
  }

  cancel(id: string): SaveStatus {
    z.uuid().parse(id);
    if (!this.store.saveContext(id) && !this.active.has(id)) { this.store.requestSaveCancellation(id); return this.status(id); }
    const before = this.status(id);
    if (before.phase === "saved" && !before.active) return before;
    this.store.requestSaveCancellation(id);
    const context = this.store.saveContext(id);
    if (context) this.store.updateSaveContext(id, { ...context, cancelRequested: true });
    const entry = this.active.get(id);
    if (entry) { entry.cancelRequested = true; entry.controller.abort(new Error("Save cancellation requested; committed blocks and connections are retained")); }
    return this.status(id);
  }

  intent(id: string): z.infer<typeof retainedIntentSchema> {
    z.uuid().parse(id);
    const context = this.store.saveContext(id);
    if (!context) throw new Error("Save intent not found in this journal");
    const { plan: _, ...intent } = context.submission;
    return structuredClone(intent);
  }

  replay(id: string): Promise<SaveStatus> {
    z.uuid().parse(id);
    const context = this.store.saveContext(id);
    if (!context) return Promise.reject(new Error("Original save intent not found in this journal"));
    return this.save(context.submission, context.submission.snapshot.origin);
  }

  async save(input: SaveSubmission, origin: SaveOrigin, signal?: AbortSignal): Promise<SaveStatus> {
    if (this.stopping) throw new Error("Daemon is stopping; inspect retained save status before recovery");
    // Freeze and validate before the first await. Caller edits cannot race account checks.
    const submission = structuredClone(saveSubmissionSchema.parse(input));
    const { snapshot, snapshotSha256, plan, remoteMode } = submission;
    this.validate(submission, origin);
    this.store.requirePrivateState();
    const id = snapshot.saveId;
    const previous = this.store.saveContext(id);
    if (previous && !isDeepStrictEqual(previous.submission, submission)) throw new Error("Save UUID already belongs to a different immutable intent");
    const running = this.active.get(id);
    if (running) {
      if (!isDeepStrictEqual(running.submission, submission)) throw new Error("Save UUID already belongs to a different active intent");
      return this.status(id);
    }
    if (this.active.size >= 16) throw new Error("Daemon has sixteen active saves; inspect status or cancel an existing save");
    const preCancelled = !previous && this.store.isSaveCancelled(id);
    this.store.recordSaveContext(id, { submission, credentialProfile: this.credential.profile, observation: "prepared", cancelRequested: preCancelled });
    if (preCancelled) return this.status(id);
    // A deliberate replay after a recorded cancellation starts one new bounded attempt.
    if (previous) {
      this.store.clearSaveCancellation(id);
      this.store.updateSaveContext(id, { ...previous, observation: "prepared", cancelRequested: false, failure: undefined });
    }
    const controller = new AbortController();
    let publishingStarted = false;
    const bounded = deadline(this.timeoutMs, controller.signal);
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
    // Install the operation before authorization reads so a concurrent cancellation can reach it.
    const pending = Promise.resolve().then(async () => {
      bounded.throwIfAborted();
      const me = await this.client.me(bounded);
      const accountId = z.number().int().positive().safe().parse(me.id);
      if (this.credential.expectedAccountId !== undefined && this.credential.expectedAccountId !== accountId
        || snapshot.authentication.expectedAccountId !== undefined && snapshot.authentication.expectedAccountId !== accountId) throw new Error("Authenticated Are.na account does not match the selected profile");
      // Legacy plan reuse must prove block ownership under this actual account before writes.
      const reused = this.store.operationState(id)?.receipt ?? (!snapshot.invocation.force ? this.store.latestReceiptForPlan(plan.hash) : undefined);
      if (reused) {
        const block = await this.client.block(reused.blockId, bounded);
        if ((block.user as { id?: unknown } | undefined)?.id !== accountId) throw new Error("Existing receipt belongs to another or unverified account; use separate account state");
        // A repeated ordinary publish has a new UUID. Finish the retained original
        // under its own publisher lease before creating a later-save event. Resume
        // reconciles each attempted placement, so no second block or connect is
        // inferred from a cancelled client's last response.
        if (reused.remoteProvenance && reused.remoteProvenance.saveId !== id
          && (reused.status !== "verified" || reused.pendingDestinations?.length
            || reused.remoteProvenance.state !== "verified")) {
          try {
            await this.publisher.resume(reused.id, [...new Set([...reused.destinations, ...(reused.pendingDestinations ?? [])])], bounded);
          } catch (error) {
            if (bounded.aborted) throw error;
            const reason = error instanceof Error ? error.message : "unknown recovery error";
            if (reason.includes("Are.na block processing failed")) {
              throw new RetainedSaveRecoveryError(`The original retained block has failed processing on Are.na: ${reason}. Repeating publish will not create a replacement. Inspect arena-block inspect ${reused.id} and the block itself before choosing a repair; if Are.na later makes it available, retry the original save with arena-block retry-save ${reused.remoteProvenance.saveId}`);
            }
            throw new RetainedSaveRecoveryError(`The original retained block could not yet be recovered: ${reason}. Inspect arena-block inspect ${reused.id}; retry its original save with arena-block retry-save ${reused.remoteProvenance.saveId}`);
          }
        }
      }
      // Cancellation can also land after Are.na accepts POST but before its
      // response reaches us. Reconcile that original UUID first; an unresolved
      // create must never be replaced by a fresh POST from this new UUID.
      const attempt = !reused && this.store.unresolvedCreation(plan.hash);
      const original = attempt && this.store.remoteSaveForAttempt(attempt.id, plan.hash);
      if (attempt && !original && remoteMode)
        throw new RetainedSaveRecoveryError(`Unresolved creation has no unique original save identity; inspect arena-block attempt ${attempt.id} before another save`);
      if (original && original.saveId !== id) {
        const context = this.store.saveContext(original.saveId);
        if (!context || context.accountId !== accountId || context.credentialProfile !== this.credential.profile
          || context.submission.plan.hash !== plan.hash)
          throw new RetainedSaveRecoveryError(`Original creation has unresolved account or intent; inspect arena-block attempt ${attempt!.id} before another save`);
        const recovered = await this.save(context.submission, context.submission.snapshot.origin, bounded);
        if (recovered.phase !== "saved")
          throw new RetainedSaveRecoveryError(`Original creation is still active or uncertain; inspect arena-block save-status ${original.saveId} before another save`);
      }
      bounded.throwIfAborted();
      this.store.bindSaveAccount(this.credential.profile, accountId);
      const context: SaveContext = { submission, accountId, credentialProfile: this.credential.profile, observation: "running", cancelRequested: this.store.isSaveCancelled(id) };
      this.store.updateSaveContext(id, context);
      // A cancellation received during account verification remains effective after journaling.
      bounded.throwIfAborted();
      const request: PublishRequest = { plan, destinations: snapshot.routing.destinations, force: snapshot.invocation.force, operationId: id,
        ...(remoteMode ? { remoteSave: { snapshot, snapshotSha256, mode: remoteMode } } : {}) };
      publishingStarted = true;
      await this.publisher.publish(request, bounded);
    }).catch(error => {
      const context = this.store.saveContext(id);
      if (context) {
        const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
        const status = error && typeof error === "object" && "status" in error ? error.status : undefined;
        const failure = error instanceof RetainedSaveRecoveryError
          ? { code: "retained_recovery" as const, message: error.message }
          : code === "media_budget" || code === "media_inspection"
          ? { code, message: error instanceof Error ? error.message : "Selected media could not be prepared",
              retryable: code === "media_inspection" && Boolean(error && typeof error === "object" && "retryable" in error && error.retryable === true) }
          : status === 401 || status === 403 ? { code: "authorization" as const, message: `Are.na denied access (HTTP ${status})` }
          : /Authenticated Are.na account does not match/.test(error instanceof Error ? error.message : "")
            ? { code: "authorization" as const, message: "Authenticated Are.na account does not match the selected profile" }
            : bounded.aborted && !controller.signal.aborted ? { code: "deadline" as const, message: "Save exceeded the bounded service deadline before completion" } : undefined;
        this.store.updateSaveContext(id, { ...context, observation: bounded.aborted ? "interrupted" : "failed", ...(failure ? { failure } : {}) });
      }
      throw error;
    }).finally(() => {
      this.active.delete(id);
      signal?.removeEventListener("abort", abort);
    });
    this.active.set(id, { controller, pending, submission, cancelRequested: false });
    try { await abortable(pending, bounded); return this.status(id); }
    catch (error) {
      const status = this.store.saveContext(id) ? this.status(id) : undefined;
      if (status?.phase === "saved" && publishingStarted && bounded.aborted) return status;
      throw Object.assign(error instanceof Error ? error : new Error("Save interrupted"), { saveStatus: status });
    }
  }

  private validate({ snapshot, snapshotSha256, plan, remoteMode }: SaveSubmission, origin: SaveOrigin): void {
    if (Buffer.byteLength(JSON.stringify(snapshot)) > 2 * 1024 * 1024 || snapshotHash(snapshot) !== snapshotSha256) throw new Error("Save snapshot exceeds its bound or checksum does not match");
    if (snapshot.origin !== origin || snapshot.invocation.operation !== "publish" || snapshot.authentication.credentialProfile !== this.credential.profile) throw new Error("Save transport, operation or selected credential profile does not match this daemon");
    const { hash, ...content } = plan;
    if (planHash(content) !== hash) throw new Error("Publication plan checksum mismatch");
    const redacted = redactProvenance(content);
    const expectedPlan = { ...redacted.value, hash: redacted.paths.length ? planHash(redacted.value) : hash };
    if (!isDeepStrictEqual(expectedPlan, snapshot.plan) || !isDeepStrictEqual(redactProvenance(snapshot).value, snapshot)
      || snapshot.fidelity.originalPlanPreserved !== (redacted.paths.length === 0) || snapshot.redaction.originalPlanHashOmitted !== (redacted.paths.length > 0)) throw new Error("Save snapshot does not preserve this plan's declared fidelity");
    if (!isDeepStrictEqual(normalizeChannels(snapshot.routing.destinations), snapshot.routing.destinations)) throw new Error("Save destinations must be normalized and unique");
    const defaultChannel = snapshotDefaultChannel(snapshot);
    const migration = legacyReplayMigration(this.store, snapshot, snapshotSha256);
    const legacyReplay = migration && String(migration.toChannelId) === (this.remotePolicy?.defaultChannel ?? this.remotePolicy?.inboxChannel);
    if (remoteMode && (!this.remotePolicy || remoteMode !== this.remotePolicy.mode
      || defaultChannel?.channel !== (this.remotePolicy.defaultChannel ?? this.remotePolicy.inboxChannel) && !legacyReplay
      || !defaultChannel?.included)) throw new Error("Remote provenance requires the explicitly configured daemon policy and default channel");
    if (this.credential.expectedAccountId !== undefined && snapshot.authentication.expectedAccountId !== undefined && snapshot.authentication.expectedAccountId !== this.credential.expectedAccountId) throw new Error("Requested account does not match the selected daemon profile");
  }

  async close(): Promise<boolean> {
    this.stopping = true;
    const pending = [...this.active.values()];
    for (const entry of pending) entry.controller.abort(new Error("Daemon is stopping; inspect the journal before recovery"));
    try { await abortable(Promise.allSettled(pending.map(entry => entry.pending)), deadline(10_000)); return true; }
    catch { return false; } // Leave SQLite open if a misbehaving renderer still owns journal work.
  }
}
