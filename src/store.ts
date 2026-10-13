import { Database } from "bun:sqlite";
import { mkdirSync, openSync, closeSync, chmodSync, lstatSync } from "node:fs";
import { dirname } from "node:path";
import type { BlockPlan, PublicationReceipt } from "./types.ts";
import { planHash } from "./compose.ts";
export type { CreationAttempt } from "./types.ts";
import type { CreationAttempt } from "./types.ts";
import type { RemoteSaveEvent, RemoteSaveRecord } from "./remote-save.ts";
import type { SaveContext } from "./save-gateway.ts";

export type ExistingPlacement = {
  id: string; accountId: number; blockId: number; destinations: number[]; confirmed: number[]; attempted: number[];
  phase: "prepared" | "running" | "saved" | "partial" | "unknown" | "cancelled";
  active: boolean; cancelRequested: boolean; error?: string; createdAt: string; updatedAt: string;
};

/** Verified relocation of one immutable original provenance placement. */
export type RemoteConnectionMigration = {
  saveId: string;
  accountId: number;
  blockId: number;
  fromChannelId: number;
  fromConnectionId: number;
  toChannelId: number;
  toConnectionId: number;
  metadataSha256: string;
  migratedAt: string;
};

export class ArenaBlockStore {
  private readonly database: Database;

  constructor(private readonly path: string, options: { private?: boolean } = {}) {
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (options.private) {
      const info = lstatSync(directory);
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
        throw new Error("Remote provenance requires an owned private state directory (0700); existing directory permissions were not changed");
      }
    }
    // Create privately before SQLite opens sidecars, which inherit the database mode.
    try {
      const info = lstatSync(path);
      if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.()) throw new Error("State database must be an owned regular file");
      chmodSync(path, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try { const file = openSync(path, "wx", 0o600); closeSync(file); }
      catch (race) {
        if ((race as NodeJS.ErrnoException).code !== "EEXIST") throw race;
        const info = lstatSync(path);
        if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.()) throw new Error("State database must be an owned regular file");
        chmodSync(path, 0o600);
      }
    }
    for (const suffix of ["-wal", "-shm"]) {
      try {
        const info = lstatSync(`${path}${suffix}`);
        if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.()) throw new Error("State sidecar must be an owned regular file");
        chmodSync(`${path}${suffix}`, 0o600);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    this.database = new Database(path, { create: true });
    this.database.exec("PRAGMA busy_timeout = 5000");
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS plans (
        hash TEXT PRIMARY KEY,
        plan_json TEXT NOT NULL,
        arena_cover_url TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS publications (
        id TEXT PRIMARY KEY,
        plan_hash TEXT NOT NULL,
        block_id INTEGER NOT NULL,
        receipt_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS publications_plan_hash ON publications(plan_hash);
      CREATE TABLE IF NOT EXISTS creation_attempts (
        id TEXT PRIMARY KEY,
        plan_hash TEXT NOT NULL,
        attempt_json TEXT NOT NULL,
        status TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS active_creation_plan ON creation_attempts(plan_hash)
        WHERE status IN ('creating', 'creation_unknown');
      CREATE TABLE IF NOT EXISTS placement_requests (
        id TEXT PRIMARY KEY,
        receipt_id TEXT NOT NULL,
        destinations_json TEXT NOT NULL,
        pending_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS placement_requests_receipt ON placement_requests(receipt_id);
      CREATE TABLE IF NOT EXISTS publication_operations (
        id TEXT PRIMARY KEY,
        plan_hash TEXT NOT NULL,
        receipt_id TEXT,
        attempt_id TEXT
      );
      CREATE TABLE IF NOT EXISTS receipt_finalization (
        receipt_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        owner_pid INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS remote_saves (
        id TEXT PRIMARY KEY, plan_hash TEXT NOT NULL, intent_hash TEXT NOT NULL,
        record_json TEXT NOT NULL, receipt_id TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS remote_saves_receipt ON remote_saves(receipt_id);
      CREATE TABLE IF NOT EXISTS remote_save_events (
        id TEXT PRIMARY KEY, plan_hash TEXT NOT NULL, receipt_id TEXT NOT NULL,
        intent_hash TEXT NOT NULL, record_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS remote_save_events_receipt ON remote_save_events(receipt_id);
      CREATE TABLE IF NOT EXISTS remote_connection_migrations (
        save_id TEXT PRIMARY KEY, record_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS remote_save_leases (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, owner_pid INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS save_contexts (id TEXT PRIMARY KEY, context_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS save_cancellations (id TEXT PRIMARY KEY, requested_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS save_account_scope (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), profile TEXT NOT NULL, account_id INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS existing_block_placements (id TEXT PRIMARY KEY, record_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS block_connection_attempts (
        block_id INTEGER NOT NULL, channel_id INTEGER NOT NULL,
        owner_id TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(block_id, channel_id)
      );
    `);
    this.database.transaction(() => {
      const columns = this.database.query("PRAGMA table_info(publications)").all() as Array<{ name: string }>;
      if (!columns.some(column => column.name === "revision")) this.database.exec("ALTER TABLE publications ADD COLUMN revision INTEGER NOT NULL DEFAULT 0");
    }).immediate();
  }

  close(): void {
    this.database.close();
  }

  existingPlacement(id: string): ExistingPlacement | undefined {
    const row = this.database.query("SELECT record_json FROM existing_block_placements WHERE id = ?").get(id) as { record_json: string } | null;
    return row ? JSON.parse(row.record_json) as ExistingPlacement : undefined;
  }

  reserveExistingPlacement(input: { id: string; accountId: number; blockId: number; destinations: number[] }): ExistingPlacement {
    this.requirePrivateState();
    return this.database.transaction(() => {
      const old = this.existingPlacement(input.id);
      if (old) {
        if (old.accountId !== input.accountId || old.blockId !== input.blockId || JSON.stringify(old.destinations) !== JSON.stringify(input.destinations))
          throw new Error("This placement ID belongs to another block, account or destination set");
        return old;
      }
      const now = new Date().toISOString();
      const value: ExistingPlacement = { ...input, confirmed: [], attempted: [], phase: "prepared", active: false, cancelRequested: false, createdAt: now, updatedAt: now };
      this.database.query("INSERT INTO existing_block_placements (id, record_json) VALUES (?, ?)").run(value.id, JSON.stringify(value));
      return value;
    }).immediate();
  }

  updateExistingPlacement(id: string, change: (current: ExistingPlacement) => ExistingPlacement): ExistingPlacement {
    this.requirePrivateState();
    return this.database.transaction(() => {
      const current = this.existingPlacement(id);
      if (!current) throw new Error("Existing-block placement not found");
      const next = change(current);
      if (next.id !== current.id || next.accountId !== current.accountId || next.blockId !== current.blockId
        || JSON.stringify(next.destinations) !== JSON.stringify(current.destinations)) throw new Error("Placement identity cannot change");
      next.updatedAt = new Date().toISOString();
      this.database.query("UPDATE existing_block_placements SET record_json = ? WHERE id = ?").run(JSON.stringify(next), id);
      return next;
    }).immediate();
  }

  /** Only one instance may send this target, and every earlier target must be confirmed. */
  reserveExistingPlacementAttempt(id: string, destination: number): boolean {
    return this.database.transaction(() => {
      const current = this.existingPlacement(id);
      if (!current) throw new Error("Existing-block placement not found");
      const index = current.destinations.indexOf(destination);
      if (index < 0 || current.cancelRequested || current.confirmed.includes(destination)
        || current.attempted.includes(destination)
        || current.destinations.slice(0, index).some(target => !current.confirmed.includes(target))) return false;
      if (!this.reserveBlockConnectionAttempt(current.blockId, destination, `existing:${id}`)) {
        this.updateExistingPlacement(id, value => ({ ...value, attempted: [...value.attempted, destination] }));
        return false;
      }
      this.updateExistingPlacement(id, value => ({ ...value, attempted: [...value.attempted, destination] }));
      return true;
    }).immediate();
  }

  /** Retain observed/attempted physical targets without changing any original operation. */
  rememberBlockConnectionAttempts(blockId: number, channels: number[], ownerId: string): void {
    for (const channelId of new Set(channels)) {
      if (!Number.isSafeInteger(blockId) || blockId < 1 || !Number.isSafeInteger(channelId) || channelId < 1 || !ownerId)
        throw new Error("Invalid retained physical connection attempt");
      this.database.query("INSERT INTO block_connection_attempts (block_id, channel_id, owner_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(block_id, channel_id) DO NOTHING")
        .run(blockId, channelId, ownerId, new Date().toISOString());
    }
  }

  /** Import old journals only for the block being placed; opening the store adds zero rows. */
  private importBlockConnectionAttempts(blockId: number): boolean {
    let resolved = true;
    const publications = this.database.query("SELECT receipt_json FROM publications WHERE block_id = ?").all(blockId) as Array<{ receipt_json: string }>;
    for (const row of publications) {
      const receipt = JSON.parse(row.receipt_json) as PublicationReceipt;
      let targets = receipt.attemptedChannelIds;
      if (targets === undefined && receipt.remoteProvenance) {
        const original = this.remoteSaveForReceipt(receipt.id);
        if (original?.blockId === blockId) targets = original.attemptedChannels;
      }
      if (targets === undefined) {
        const old = [...new Set([...receipt.destinations, ...(receipt.pendingDestinations ?? [])])];
        // A legacy slug cannot be mapped synchronously. Resume that retained receipt
        // to resolve it before permitting another intent to write this block.
        if (old.some(target => !/^[0-9]+$/.test(target))) resolved = false;
        targets = old.filter(target => /^[0-9]+$/.test(target)).map(Number);
      }
      this.rememberBlockConnectionAttempts(blockId, targets, `receipt:${receipt.id}`);
    }
    const originals = this.database.query("SELECT record_json FROM remote_saves").all() as Array<{ record_json: string }>;
    for (const row of originals) {
      const record = JSON.parse(row.record_json) as RemoteSaveRecord;
      if (record.blockId === blockId) this.rememberBlockConnectionAttempts(blockId, record.attemptedChannels, `save:${record.saveId}`);
    }
    const migrations = this.database.query("SELECT record_json FROM remote_connection_migrations").all() as Array<{ record_json: string }>;
    for (const row of migrations) {
      const record = JSON.parse(row.record_json) as RemoteConnectionMigration;
      if (record.blockId === blockId) this.rememberBlockConnectionAttempts(blockId, [record.fromChannelId, record.toChannelId], `migration:${record.saveId}`);
    }
    const placements = this.database.query("SELECT record_json FROM existing_block_placements").all() as Array<{ record_json: string }>;
    for (const row of placements) {
      const record = JSON.parse(row.record_json) as ExistingPlacement;
      if (record.blockId === blockId) this.rememberBlockConnectionAttempts(blockId, [...record.attempted, ...record.confirmed], `existing:${record.id}`);
    }
    return resolved;
  }

  /** Across all local intents, one physical target may be sent once and thereafter only reconciled. */
  reserveBlockConnectionAttempt(blockId: number, channelId: number, ownerId: string): boolean {
    return this.database.transaction(() => {
      if (!this.importBlockConnectionAttempts(blockId)) return false;
      const result = this.database.query("INSERT INTO block_connection_attempts (block_id, channel_id, owner_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(block_id, channel_id) DO NOTHING")
        .run(blockId, channelId, ownerId, new Date().toISOString());
      return result.changes === 1;
    }).immediate();
  }

  bindSaveAccount(profile: string, accountId: number): void {
    this.requirePrivateState();
    this.database.transaction(() => {
      const prior = this.database.query("SELECT profile, account_id FROM save_account_scope WHERE singleton = 1").get() as { profile: string; account_id: number } | null;
      if (prior && (prior.profile !== profile || prior.account_id !== accountId)) throw new Error("This private journal belongs to another account/profile; select its original profile or separate account state");
      this.database.query("INSERT INTO save_account_scope(singleton, profile, account_id) VALUES (1, ?, ?) ON CONFLICT(singleton) DO NOTHING").run(profile, accountId);
    }).immediate();
  }

  saveAccountScope(): { profile: string; accountId: number } | undefined {
    const row = this.database.query("SELECT profile, account_id FROM save_account_scope WHERE singleton = 1").get() as { profile: string; account_id: number } | null;
    return row ? { profile: row.profile, accountId: row.account_id } : undefined;
  }

  requestSaveCancellation(id: string): void {
    this.requirePrivateState();
    this.database.query("INSERT INTO save_cancellations(id, requested_at) VALUES (?, ?) ON CONFLICT(id) DO NOTHING").run(id, new Date().toISOString());
  }
  isSaveCancelled(id: string): boolean { return Boolean(this.database.query("SELECT id FROM save_cancellations WHERE id = ?").get(id)); }
  clearSaveCancellation(id: string): void { this.database.query("DELETE FROM save_cancellations WHERE id = ?").run(id); }

  saveContext(id: string): SaveContext | undefined {
    const row = this.database.query("SELECT context_json FROM save_contexts WHERE id = ?").get(id) as { context_json: string } | null;
    return row ? JSON.parse(row.context_json) : undefined;
  }

  recordSaveContext(id: string, context: SaveContext): void {
    this.requirePrivateState();
    this.database.transaction(() => {
      const previous = this.saveContext(id);
      if (previous && (JSON.stringify(previous.submission) !== JSON.stringify(context.submission) || previous.accountId !== undefined && context.accountId !== undefined && previous.accountId !== context.accountId || previous.credentialProfile !== context.credentialProfile)) throw new Error("Save UUID belongs to another immutable intent or authenticated scope");
      this.database.query("INSERT INTO save_contexts(id, context_json) VALUES (?, ?) ON CONFLICT(id) DO NOTHING").run(id, JSON.stringify(context));
      this.beginOperation(id, context.submission.plan.hash);
    }).immediate();
  }

  updateSaveContext(id: string, context: SaveContext): void {
    this.database.transaction(() => {
      const previous = this.saveContext(id);
      if (previous?.accountId !== undefined && context.accountId !== previous.accountId) throw new Error("Authenticated save scope cannot be removed or changed");
      this.recordSaveContext(id, context);
      this.database.query("UPDATE save_contexts SET context_json = ? WHERE id = ?").run(JSON.stringify(context), id);
    }).immediate();
  }

  remoteSave(id: string): RemoteSaveRecord | undefined {
    const row = this.database.query("SELECT record_json FROM remote_saves WHERE id = ?").get(id) as { record_json: string } | null;
    return row ? JSON.parse(row.record_json) : undefined;
  }

  remoteSaveForReceipt(id: string): RemoteSaveRecord | undefined {
    const row = this.database.query("SELECT record_json FROM remote_saves WHERE receipt_id = ?").get(id) as { record_json: string } | null;
    return row ? JSON.parse(row.record_json) : undefined;
  }

  remoteSaveForAttempt(attemptId: string, planHash: string): RemoteSaveRecord | undefined {
    const rows = this.database.query("SELECT record_json FROM remote_saves WHERE plan_hash = ?").all(planHash) as Array<{ record_json: string }>;
    const matches = rows.map(row => JSON.parse(row.record_json) as RemoteSaveRecord).filter(row => row.attemptId === attemptId);
    if (matches.length > 1) throw new Error("Creation attempt has more than one original remote save");
    return matches[0];
  }

  remoteConnectionMigration(saveId: string): RemoteConnectionMigration | undefined {
    const row = this.database.query("SELECT record_json FROM remote_connection_migrations WHERE save_id = ?").get(saveId) as { record_json: string } | null;
    return row ? JSON.parse(row.record_json) as RemoteConnectionMigration : undefined;
  }

  /** A relocation is an additional observation, never a rewrite of the original intent. */
  recordRemoteConnectionMigration(record: RemoteConnectionMigration): void {
    this.requirePrivateState();
    if (!record.saveId || !Number.isSafeInteger(record.accountId) || !Number.isSafeInteger(record.blockId)
      || !Number.isSafeInteger(record.fromChannelId) || !Number.isSafeInteger(record.fromConnectionId)
      || !Number.isSafeInteger(record.toChannelId) || !Number.isSafeInteger(record.toConnectionId)
      || !/^[a-f0-9]{64}$/.test(record.metadataSha256) || !Number.isFinite(Date.parse(record.migratedAt)))
      throw new Error("Invalid remote connection migration observation");
    const original = this.remoteSave(record.saveId);
    if (!original || original.intent.accountId !== record.accountId || original.blockId !== record.blockId
      || original.intent.inboxChannelId !== record.fromChannelId || original.connectionId !== record.fromConnectionId)
      throw new Error("Migration does not match an immutable original remote save");
    this.database.transaction(() => {
      const prior = this.remoteConnectionMigration(record.saveId);
      if (prior && JSON.stringify(prior) !== JSON.stringify(record)) throw new Error("Remote connection migration is immutable");
      if (!prior) this.database.query("INSERT INTO remote_connection_migrations(save_id, record_json) VALUES (?, ?)").run(record.saveId, JSON.stringify(record));
    }).immediate();
  }

  requirePrivateState(): void {
    const directory = lstatSync(dirname(this.path));
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid?.() || (directory.mode & 0o077) !== 0) throw new Error("Remote provenance requires an owned private state directory (0700)");
    for (const file of [this.path, `${this.path}-wal`, `${this.path}-shm`]) {
      try {
        const info = lstatSync(file);
        if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Error("Remote provenance state files must be owned and private (0600)");
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }

  /** Intent and authenticated scope never change; outcomes are separate mutable observations. */
  saveRemoteSave(record: RemoteSaveRecord): void {
    this.requirePrivateState();
    this.database.transaction(() => {
      const previous = this.remoteSave(record.saveId);
      if (previous && (JSON.stringify(previous.intent) !== JSON.stringify(record.intent))) throw new Error("Remote save ID already belongs to another intent or authenticated scope");
      this.database.query(`INSERT INTO remote_saves(id, plan_hash, intent_hash, record_json, receipt_id)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET record_json = excluded.record_json, receipt_id = excluded.receipt_id`)
        .run(record.saveId, record.intent.planHash, record.intent.snapshotSha256, JSON.stringify(record), record.receiptId ?? null);
    }).immediate();
  }

  remoteSaveEvent(id: string): RemoteSaveEvent | undefined {
    const row = this.database.query("SELECT record_json FROM remote_save_events WHERE id = ?").get(id) as { record_json: string } | null;
    return row ? JSON.parse(row.record_json) as RemoteSaveEvent : undefined;
  }

  /** Later save intents are immutable; only their separately observed outcome can advance. */
  saveRemoteSaveEvent(record: RemoteSaveEvent): void {
    this.requirePrivateState();
    this.database.transaction(() => {
      const previous = this.remoteSaveEvent(record.saveId);
      if (previous && JSON.stringify(previous.intent) !== JSON.stringify(record.intent))
        throw new Error("Remote save event ID already belongs to another immutable intent");
      this.database.query(`INSERT INTO remote_save_events(id, plan_hash, receipt_id, intent_hash, record_json)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET record_json = excluded.record_json`)
        .run(record.saveId, record.intent.planHash, record.intent.receiptId, record.intent.snapshotSha256, JSON.stringify(record));
    }).immediate();
  }

  pendingRemoteSaveEvent(receiptId: string, exceptId: string): RemoteSaveEvent | undefined {
    const rows = this.database.query("SELECT record_json FROM remote_save_events WHERE receipt_id = ? AND id != ? ORDER BY rowid")
      .all(receiptId, exceptId) as Array<{ record_json: string }>;
    return rows.map(row => JSON.parse(row.record_json) as RemoteSaveEvent).find(event => event.state !== "verified");
  }

  reserveRemoteSaveLease(id: string, owner: string): boolean {
    return this.database.transaction(() => {
      const current = this.database.query("SELECT owner_id, owner_pid FROM remote_save_leases WHERE id = ?").get(id) as { owner_id: string; owner_pid: number } | null;
      if (current) {
        if (current.owner_id === owner) return true;
        try { process.kill(current.owner_pid, 0); return false; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
          this.database.query("DELETE FROM remote_save_leases WHERE id = ? AND owner_id = ?").run(id, current.owner_id);
        }
      }
      this.database.query("INSERT INTO remote_save_leases(id, owner_id, owner_pid) VALUES (?, ?, ?)").run(id, owner, process.pid);
      return true;
    }).immediate();
  }

  releaseRemoteSaveLease(id: string, owner: string): void {
    this.database.query("DELETE FROM remote_save_leases WHERE id = ? AND owner_id = ?").run(id, owner);
  }

  unresolvedCreation(hash: string): CreationAttempt | undefined {
    const row = this.database.query("SELECT attempt_json FROM creation_attempts WHERE plan_hash = ? AND status IN ('creating', 'creation_unknown') LIMIT 1").get(hash) as { attempt_json: string } | null;
    return row ? JSON.parse(row.attempt_json) : undefined;
  }

  creationAttempt(id: string): CreationAttempt | undefined {
    const row = this.database.query("SELECT attempt_json FROM creation_attempts WHERE id = ?").get(id) as { attempt_json: string } | null;
    return row ? JSON.parse(row.attempt_json) : undefined;
  }

  saveCreation(attempt: CreationAttempt): void {
    this.database.query(`INSERT INTO creation_attempts (id, plan_hash, attempt_json, status)
      VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET attempt_json = excluded.attempt_json, status = excluded.status`)
      .run(attempt.id, attempt.planHash, JSON.stringify(attempt), attempt.status);
  }

  beginOperation(id: string, hash: string): void {
    this.database.transaction(() => {
      const current = this.database.query("SELECT plan_hash FROM publication_operations WHERE id = ?").get(id) as { plan_hash: string } | null;
      if (current && current.plan_hash !== hash) throw new Error("Publication operation belongs to a different snapshot");
      this.database.query("INSERT INTO publication_operations(id, plan_hash) VALUES (?, ?) ON CONFLICT(id) DO NOTHING").run(id, hash);
    }).immediate();
  }

  operationState(id: string): import("./types.ts").PublicationState | undefined {
    const row = this.database.query("SELECT receipt_id, attempt_id FROM publication_operations WHERE id = ?").get(id) as { receipt_id: string | null; attempt_id: string | null } | null;
    if (!row) return undefined;
    const receipt = row.receipt_id ? this.receipt(row.receipt_id) : undefined;
    const attempt = row.attempt_id ? this.creationAttempt(row.attempt_id) : undefined;
    return { operationId: id, receipt, attempt: attempt?.status === "created" ? undefined : attempt };
  }

  bindOperationReceipt(id: string | undefined, receipt: PublicationReceipt): void {
    if (id) this.database.query("UPDATE publication_operations SET receipt_id = ? WHERE id = ?").run(receipt.id, id);
  }

  /** Recheck after preparation and reserve in the same SQLite write transaction. */
  reserveCreation(attempt: CreationAttempt, force: boolean, operationId?: string): { receipt?: PublicationReceipt; attempt?: CreationAttempt } {
    return this.database.transaction(() => {
      const operation = operationId ? this.operationState(operationId) : undefined;
      if (operation?.receipt) return { receipt: operation.receipt };
      if (operation?.attempt && operation.attempt.status !== "rejected") return { attempt: operation.attempt };
      if (!force) {
        const receipt = this.receiptForPlan(attempt.planHash) ?? this.latestReceiptForPlan(attempt.planHash);
        if (receipt) { this.bindOperationReceipt(operationId, receipt); return { receipt }; }
      }
      const pending = this.unresolvedCreation(attempt.planHash);
      if (pending) return { attempt: pending };
      this.saveCreation(attempt);
      if (operationId) this.database.query("UPDATE publication_operations SET attempt_id = ? WHERE id = ?").run(attempt.id, operationId);
      return {};
    }).immediate();
  }

  recordCreated(attempt: CreationAttempt, receipt: PublicationReceipt, operationId?: string): void {
    this.database.transaction(() => {
      this.saveReceipt(receipt);
      this.rememberBlockConnectionAttempts(receipt.blockId, receipt.attemptedChannelIds ?? [], `receipt:${receipt.id}`);
      this.saveCreation({ ...attempt, status: "created" });
      this.bindOperationReceipt(operationId, receipt);
    })();
  }

  savePlan(plan: BlockPlan): void {
    const { hash, ...snapshot } = plan;
    if (planHash(snapshot) !== hash) throw new Error("Plan hash does not match its snapshot; compose a new plan after editing");
    this.database.query(`
      INSERT INTO plans (hash, plan_json, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(hash) DO NOTHING
    `).run(plan.hash, JSON.stringify(plan), new Date().toISOString());
  }

  plan(hash: string): { plan: BlockPlan; arenaCoverUrl?: string } | undefined {
    const row = this.database.query("SELECT plan_json, arena_cover_url FROM plans WHERE hash = ?").get(hash) as { plan_json: string; arena_cover_url: string | null } | null;
    return row ? { plan: JSON.parse(row.plan_json) as BlockPlan, ...(row.arena_cover_url ? { arenaCoverUrl: row.arena_cover_url } : {}) } : undefined;
  }

  setArenaCover(hash: string, url: string): void {
    this.database.query("UPDATE plans SET arena_cover_url = ? WHERE hash = ?").run(url, hash);
  }

  receiptForPlan(hash: string): PublicationReceipt | undefined {
    const row = this.database.query("SELECT receipt_json FROM publications WHERE plan_hash = ? AND json_extract(receipt_json, '$.status') = 'verified' ORDER BY updated_at DESC LIMIT 1").get(hash) as { receipt_json: string } | null;
    return row ? JSON.parse(row.receipt_json) as PublicationReceipt : undefined;
  }

  latestReceiptForPlan(hash: string): PublicationReceipt | undefined {
    const row = this.database.query("SELECT receipt_json FROM publications WHERE plan_hash = ? ORDER BY updated_at DESC LIMIT 1").get(hash) as { receipt_json: string } | null;
    return row ? JSON.parse(row.receipt_json) as PublicationReceipt : undefined;
  }

  receipt(id: string): PublicationReceipt | undefined {
    const row = this.database.query("SELECT receipt_json FROM publications WHERE id = ?").get(id) as { receipt_json: string } | null;
    return row ? JSON.parse(row.receipt_json) as PublicationReceipt : undefined;
  }

  receiptSnapshot(id: string): { receipt: PublicationReceipt; revision: number } {
    const row = this.database.query("SELECT receipt_json, revision FROM publications WHERE id = ?").get(id) as { receipt_json: string; revision: number } | null;
    if (!row) throw new Error("Publication receipt not found");
    return { receipt: JSON.parse(row.receipt_json), revision: row.revision };
  }

  reserveFinalization(id: string, owner: string): "verified" | "busy" | "acquired" {
    return this.database.transaction(() => {
      if (this.receiptSnapshot(id).receipt.status === "verified") return "verified";
      const current = this.database.query("SELECT owner_id, owner_pid FROM receipt_finalization WHERE receipt_id = ?").get(id) as { owner_id: string; owner_pid: number } | null;
      if (current) {
        if (current.owner_id === owner) return "acquired";
        try { process.kill(current.owner_pid, 0); return "busy"; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") return "busy";
          // Only a terminated owner can be reclaimed; time alone never expires a live writer.
          this.database.query("DELETE FROM receipt_finalization WHERE receipt_id = ? AND owner_id = ?").run(id, current.owner_id);
        }
      }
      this.database.query("INSERT INTO receipt_finalization(receipt_id, owner_id, owner_pid) VALUES (?, ?, ?)").run(id, owner, process.pid);
      return "acquired";
    }).immediate();
  }

  releaseFinalization(id: string, owner: string): void {
    this.database.query("DELETE FROM receipt_finalization WHERE receipt_id = ? AND owner_id = ?").run(id, owner);
  }

  updateReceipt(id: string, change: (current: PublicationReceipt) => PublicationReceipt): PublicationReceipt {
    return this.database.transaction(() => {
      const next = change(this.receiptSnapshot(id).receipt);
      this.saveReceipt(next);
      return next;
    }).immediate();
  }

  private pendingPlacements(id: string): string[] {
    const rows = this.database.query("SELECT pending_json FROM placement_requests WHERE receipt_id = ? ORDER BY rowid").all(id) as Array<{ pending_json: string }>;
    return [...new Set(rows.flatMap(row => JSON.parse(row.pending_json) as string[]))];
  }

  beginPlacements(id: string, destinations: string[]): PublicationReceipt {
    return this.database.transaction(() => {
      const current = this.receiptSnapshot(id).receipt;
      // Import unfinished receipts produced before placement requests existed.
      const recorded = this.pendingPlacements(id);
      const inherited = (current.pendingDestinations ?? []).filter(target => !recorded.includes(target));
      for (const targets of [inherited, [...new Set(destinations)]]) {
        if (!targets.length) continue;
        this.database.query("INSERT INTO placement_requests (id, receipt_id, destinations_json, pending_json) VALUES (?, ?, ?, ?)")
          .run(crypto.randomUUID(), id, JSON.stringify(targets), JSON.stringify(targets));
      }
      const next = { ...current, pendingDestinations: this.pendingPlacements(id), updatedAt: new Date().toISOString() };
      this.saveReceipt(next);
      return next;
    }).immediate();
  }

  /** Reserve one write before POST; an unconfirmed reserved target must never be blindly repeated. */
  reservePlacementAttempt(id: string, channelId: number): boolean {
    return this.database.transaction(() => {
      const current = this.receiptSnapshot(id).receipt;
      if (current.attemptedChannelIds?.includes(channelId)) return false;
      if (!this.reserveBlockConnectionAttempt(current.blockId, channelId, `receipt:${id}`)) return false;
      this.saveReceipt({ ...current, attemptedChannelIds: [...(current.attemptedChannelIds ?? []), channelId] });
      return true;
    }).immediate();
  }

  /** A stale membership read cannot overwrite a newer receipt or its intent. */
  confirmPlacements(id: string, revision: number, destinations: string[], connectionIds: number[], confirmedByRelocation: string[] = []): PublicationReceipt | undefined {
    return this.database.transaction(() => {
      const current = this.receiptSnapshot(id);
      if (current.revision !== revision) return undefined;
      const rows = this.database.query("SELECT id, pending_json FROM placement_requests WHERE receipt_id = ?").all(id) as Array<{ id: string; pending_json: string }>;
      for (const row of rows) {
        // The verified migration journal explains why an original retired default request is settled at its new connection.
        // Keep destinations_json unchanged, and report only current actual destinations in the receipt.
        const pending = (JSON.parse(row.pending_json) as string[]).filter(target => !destinations.includes(target) && !confirmedByRelocation.includes(target));
        this.database.query("UPDATE placement_requests SET pending_json = ? WHERE id = ?").run(JSON.stringify(pending), row.id);
      }
      const pending = this.pendingPlacements(id);
      const next: PublicationReceipt = { ...current.receipt, destinations, connectionIds,
        pendingDestinations: pending.length ? pending : undefined, updatedAt: new Date().toISOString() };
      this.saveReceipt(next);
      return next;
    }).immediate();
  }

  saveReceipt(receipt: PublicationReceipt): void {
    this.database.query(`
      INSERT INTO publications (id, plan_hash, block_id, receipt_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET receipt_json = excluded.receipt_json, updated_at = excluded.updated_at, revision = publications.revision + 1
    `).run(
      receipt.id,
      receipt.planHash,
      receipt.blockId,
      JSON.stringify(receipt),
      receipt.createdAt,
      receipt.updatedAt,
    );
  }
}
