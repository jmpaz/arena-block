import { verifyPublication, arenaImageUrl } from "../packages/core/verification.ts";
import type { BlockPlan, PublicationReceipt, PublishRequest } from "./types.ts";
import { publishRequestSchema } from "./types.ts";
import type { renderPlan, RenderedMedia } from "./render.ts";
import { ArenaBlockStore, type CreationAttempt } from "./store.ts";
import { publicationPayload } from "./capture.ts";
import { validateMetadata, mergedMetadata, type Metadata, type MetadataPatch } from "./connection-metadata.ts";
import { RemoteSaveManager, type RemoteProvenancePolicy, type RemoteSaveRecord } from "./remote-save.ts";
import { abortable, boundedJson, deadline } from "./bounded-io.ts";

type Json = Record<string, unknown>;
type Fetcher = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => ReturnType<typeof fetch>;

export class ArenaRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

function object(value: unknown): Json | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
}

function data(value: unknown): Json {
  const body = object(value);
  const nested = object(body?.data);
  return nested ?? body ?? {};
}

function number(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export class ArenaClient {
  constructor(
    private readonly token: string,
    private readonly apiBase = "https://api.are.na/v3",
    private readonly fetcher: Fetcher = fetch,
    private readonly requestTimeoutMs = 20_000,
  ) {}

  private async request(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    const bounded = deadline(this.requestTimeoutMs, signal);
    const response = await abortable(this.fetcher(`${this.apiBase}${path}`, {
      method,
      redirect: "error",
      signal: bounded,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        "user-agent": "arena-block/0.1",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), bounded);
    if (!response.ok) {
      // Provider error bodies can contain private request data; never echo them.
      void response.body?.cancel().catch(() => {});
      throw new ArenaRequestError(`Are.na ${method} ${path} returned ${response.status}`, response.status);
    }
    if (response.status === 204) return {};
    return boundedJson(response, 4 * 1024 * 1024, bounded);
  }

  async createBlock(payload: Json, signal?: AbortSignal): Promise<Json> {
    return data(await this.request("POST", "/blocks", payload, signal));
  }

  async me(signal?: AbortSignal): Promise<Json> {
    return data(await this.request("GET", "/me", undefined, signal));
  }

  async channel(id: string | number, signal?: AbortSignal): Promise<Json> {
    return data(await this.request("GET", `/channels/${encodeURIComponent(id)}`, undefined, signal));
  }

  /** Read a page of the authenticated owner's channels; never searches another account. */
  async ownedChannels(accountId: number, page: number, signal?: AbortSignal): Promise<Json> {
    if (!Number.isSafeInteger(accountId) || accountId < 1 || !Number.isInteger(page) || page < 1 || page > 100) {
      throw new Error("Invalid channel catalog page");
    }
    return object(await this.request("GET", `/users/${accountId}/contents?type=Channel&sort=updated_at_desc&per=30&page=${page}`, undefined, signal)) ?? {};
  }

  async searchChannels(query: string, scope: "following" | "all", page: number, signal?: AbortSignal): Promise<Json> {
    if (query.length > 256 || !Number.isInteger(page) || page < 1 || page > 100) throw new Error("Invalid channel search");
    return object(await this.request("GET", `/search?query=${encodeURIComponent(query || "*")}&type=Channel&scope=${scope}&per=30&page=${page}`, undefined, signal)) ?? {};
  }

  /** Bounded channel-scoped evidence; a truncated scan is never proof of absence. */
  async channelContents(id: number, signal?: AbortSignal, maxPages = 3): Promise<{ entries: Json[]; complete: boolean }> {
    if (!Number.isSafeInteger(id) || id <= 0 || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 5) throw new Error("Invalid bounded channel scan");
    const entries: Json[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const response = object(await this.request("GET", `/channels/${id}/contents?per=100&page=${page}&sort=position_desc`, undefined, signal));
      if (!Array.isArray(response?.data) || response.data.length > 100) throw new Error("Invalid channel contents response");
      entries.push(...response.data.map(object).filter((value): value is Json => Boolean(value)));
      const meta = object(response.meta);
      const total = number(meta?.total_pages);
      if (meta?.current_page !== page || total === undefined || total < page) throw new Error("Channel pagination cannot establish completeness");
      if (page >= total && meta?.has_more_pages !== true && (meta?.next_page === null || meta?.next_page === undefined)) return { entries, complete: true };
    }
    return { entries, complete: false };
  }

  /** Find a present block's connection ID, including older placements in large channels. */
  async channelPlacement(channelId: number, blockId: number, signal?: AbortSignal): Promise<Json | undefined> {
    if (!Number.isSafeInteger(channelId) || channelId <= 0 || !Number.isSafeInteger(blockId) || blockId <= 0)
      throw new Error("Invalid channel placement identity");
    for (let page = 1; page <= 20; page++) {
      const response = object(await this.request("GET", `/channels/${channelId}/contents?per=100&page=${page}&sort=position_desc`, undefined, signal));
      if (!Array.isArray(response?.data) || response.data.length > 100) throw new Error("Invalid channel contents response");
      const meta = object(response.meta), total = number(meta?.total_pages);
      if (meta?.current_page !== page || total === undefined || total < page) throw new Error("Channel pagination cannot establish completeness");
      const matches = response.data.map(object).filter((entry): entry is Json => Boolean(entry) && entry?.id === blockId && entry?.type !== "Channel");
      if (matches.length > 1) throw new Error("Multiple connections match this block in the channel; outcome remains unknown");
      if (matches.length === 1) return matches[0]!;
      if (page >= total && meta?.has_more_pages !== true && (meta?.next_page === null || meta?.next_page === undefined)) return undefined;
    }
    throw new Error("Channel reconciliation exceeded its 2000-entry bound; outcome remains unknown");
  }

  async block(id: number, signal?: AbortSignal): Promise<Json> {
    return data(await this.request("GET", `/blocks/${id}`, undefined, signal));
  }

  /** Complete, bounded channel list for read-only block placement inspection. */
  async connectionChannels(blockId: number, signal?: AbortSignal): Promise<Json[]> {
    if (!Number.isSafeInteger(blockId) || blockId < 1) throw new Error("Invalid block ID");
    const channels: Json[] = [];
    for (let page = 1; page <= 20; page++) {
      const response = object(await this.request("GET", `/blocks/${blockId}/connections?per=100&page=${page}`, undefined, signal));
      const values = response?.data, meta = object(response?.meta);
      if (!Array.isArray(values) || values.length > 100) throw new Error("Block connections cannot establish complete membership");
      channels.push(...values.map(object).filter((value): value is Json => Boolean(value)));
      const current = number(meta?.current_page), total = number(meta?.total_pages);
      if (current !== page || total === undefined || total < page) throw new Error("Block connections lack complete pagination evidence");
      if (page >= total && meta?.has_more_pages !== true && (meta?.next_page === null || meta?.next_page === undefined)) return channels;
    }
    throw new Error("Block has more than 2000 connections; metadata read cannot establish complete membership");
  }

  async updateBlock(id: number, payload: Json, signal?: AbortSignal): Promise<Json> {
    return data(await this.request("PUT", `/blocks/${id}`, payload, signal));
  }

  async channelIds(destinations: string[], signal?: AbortSignal): Promise<number[]> {
    if (destinations.some(destination => /^\d+$/.test(destination) && (!Number.isSafeInteger(Number(destination)) || Number(destination) <= 0))) throw new Error("Invalid numeric channel ID");
    return [...new Set(await Promise.all([...new Set(destinations)].map(async (destination) => {
      if (/^\d+$/.test(destination)) return Number(destination);
      const channel = data(await this.request("GET", `/channels/${encodeURIComponent(destination)}`, undefined, signal));
      const id = number(channel.id);
      if (!id) throw new Error(`Are.na channel has no ID: ${destination}`);
      return id;
    })))];
  }

  async connect(blockId: number, destinations: string[], signal?: AbortSignal): Promise<number[]> {
    const response = data(await this.request("POST", "/connections", {
      connectable_id: blockId,
      connectable_type: "Block",
      channel_ids: await this.channelIds(destinations, signal),
    }, signal));
    const values = Array.isArray(response) ? response : Array.isArray(response.data) ? response.data : [];
    return values.flatMap((value) => number(object(value)?.id) ?? []);
  }

  async connections(blockId: number, signal?: AbortSignal): Promise<Array<{ channelId: number; slug: string }>> {
    const response = object(await this.request("GET", `/blocks/${blockId}/connections`, undefined, signal));
    const values = Array.isArray(response?.data) ? response.data : [];
    return values.flatMap((value) => {
      const channel = object(value);
      const channelId = number(channel?.id);
      const slug = string(channel?.slug);
      return channelId && slug ? [{ channelId, slug }] : [];
    });
  }

  /** An incomplete scan is never evidence that a block is absent from a channel. */
  async completeBlockConnections(blockId: number, signal?: AbortSignal): Promise<Set<number>> {
    if (!Number.isSafeInteger(blockId) || blockId < 1) throw new Error("Invalid block ID");
    const ids = new Set<number>();
    for (let page = 1; page <= 20; page++) {
      const response = object(await this.request("GET", `/blocks/${blockId}/connections?per=100&page=${page}`, undefined, signal));
      const values = response?.data, meta = object(response?.meta);
      if (!Array.isArray(values) || values.length > 100) throw new Error("Block connections cannot establish complete membership");
      for (const value of values) {
        const id = number(object(value)?.id);
        if (id) ids.add(id);
      }
      const current = number(meta?.current_page), total = number(meta?.total_pages);
      if (current !== page || total === undefined || total < page) throw new Error("Block connections lack complete pagination evidence");
      if (page >= total && meta?.has_more_pages !== true && (meta?.next_page === null || meta?.next_page === undefined)) return ids;
    }
    throw new Error("Block has more than 2000 connections; placement cannot safely prove absence");
  }

  async connectionId(blockId: number, channel: string, signal?: AbortSignal): Promise<number | undefined> {
    let page = 1;
    while (true) {
      const response = object(await this.request("GET", `/channels/${encodeURIComponent(channel)}/contents?per=100&page=${page}`, undefined, signal));
      const values = Array.isArray(response?.data) ? response.data : [];
      for (const value of values) {
        const content = object(value);
        if (number(content?.id) !== blockId) continue;
        return number(object(content?.connection)?.id);
      }
      const totalPages = number(object(response?.meta)?.total_pages) ?? 1;
      if (page >= totalPages) return undefined;
      page += 1;
    }
  }

  /** Add per-placement metadata through v3 after the caller checks each destination. */
  async connectWithMetadata(blockId: number, channels: Array<{ id: number | string; metadata?: Metadata }>, signal?: AbortSignal): Promise<Json[]> {
    if (!Number.isSafeInteger(blockId) || blockId <= 0 || !channels.length || channels.length > 20) throw new Error("Invalid connection targets; at most 20 channels are supported");
    const identities = new Set<string>();
    for (const target of channels) {
      if (!(typeof target.id === "number" ? Number.isSafeInteger(target.id) && target.id > 0 : /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(target.id))) throw new Error("Invalid connection channel");
      const numeric = /^\d+$/.test(String(target.id));
      if (numeric && (!Number.isSafeInteger(Number(target.id)) || Number(target.id) <= 0)) throw new Error("Invalid numeric channel ID");
      const identity = numeric ? String(Number(target.id)) : String(target.id);
      if (identities.has(identity)) throw new Error("Duplicate connection channel");
      identities.add(identity);
      if (target.metadata !== undefined) validateMetadata(target.metadata);
    }
    const response = await this.request("POST", "/connections", { connectable_id: blockId, connectable_type: "Block", channels }, signal);
    const values = object(response)?.data;
    return Array.isArray(values) ? values.map(object).filter((value): value is Json => Boolean(value)) : [];
  }

  async connection(id: number, signal?: AbortSignal): Promise<Json> {
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Invalid connection ID");
    return data(await this.request("GET", `/connections/${id}`, undefined, signal));
  }

  /** Validate the resulting object too; an existing connection may already be near its limits. */
  async updateConnectionMetadata(id: number, patch: MetadataPatch, signal?: AbortSignal): Promise<Json> {
    validateMetadata(patch, true);
    const current = await this.connection(id, signal);
    mergedMetadata((current.metadata ?? {}) as Metadata, patch);
    return data(await this.request("PUT", `/connections/${id}`, { metadata: patch }, signal));
  }

  async removeConnection(id: number): Promise<void> {
    await this.request("DELETE", `/connections/${id}`);
  }
}

export type PublisherConfig = {
  publicBaseUrl: string;
  mediaDirectory: string;
  verifyTimeoutMs?: number;
  pollIntervalMs?: number;
  render?: typeof renderPlan;
  remoteProvenance?: RemoteProvenancePolicy;
};

function blockDescription(plan: BlockPlan): string | undefined {
  return plan.block.kind === "text" || plan.block.kind === "url" ? plan.block.description
    : [plan.block.markdown, plan.block.description].filter(Boolean).join("\n\n");
}

export class ArenaPublisher {
  private readonly locks = new Map<string, Promise<PublicationReceipt>>();
  private readonly remote: RemoteSaveManager;

  constructor(
    private readonly client: ArenaClient,
    private readonly store: ArenaBlockStore,
    private readonly config: PublisherConfig,
  ) { this.remote = new RemoteSaveManager(client, store, config.remoteProvenance); }

  publish(request: PublishRequest, signal?: AbortSignal): Promise<PublicationReceipt> {
    request = structuredClone(publishRequestSchema.parse(request));
    if (request.operationId) this.store.beginOperation(request.operationId, request.plan.hash);
    return this.serialize(request.plan.hash, () => this.remote.withLease(request.operationId, async () => {
      const run = async () => {
        const receipt = await this.publishUnlocked(request, signal);
        if (request.remoteSave) await this.remote.completeEvent(request.operationId, receipt, signal);
        return receipt;
      };
      return request.remoteSave ? this.remote.withLease(`plan:${request.plan.hash}`, run) : run();
    }));
  }

  resume(id: string, destinations: string[], signal?: AbortSignal): Promise<PublicationReceipt> {
    const receipt = this.store.receipt(id);
    if (!receipt) return Promise.reject(new Error("Publication receipt not found"));
    return this.serialize(receipt.planHash, () => this.remote.withLease(receipt.remoteProvenance?.saveId, () => this.remote.withLease(receipt.remoteProvenance ? `plan:${receipt.planHash}` : undefined, async () => {
      signal?.throwIfAborted();
      const current = this.store.receipt(id)!;
      await this.remote.authorizeReceipt(current, signal);
      const stored = this.store.plan(current.planHash);
      if (!stored) throw new Error("Publication snapshot not found");
      return current.status === "verified" ? this.extend(current, destinations, signal)
        : this.finish(current, stored.plan, destinations, signal);
    })));
  }

  private serialize(key: string, action: () => Promise<PublicationReceipt>): Promise<PublicationReceipt> {
    const running = this.locks.get(key);
    // Serialize requests, but keep each caller's destinations and cancellation.
    const operation = (running ? running.catch(() => undefined) : Promise.resolve())
      .then(action)
      .finally(() => { if (this.locks.get(key) === operation) this.locks.delete(key); });
    this.locks.set(key, operation);
    return operation;
  }

  private async publishUnlocked(request: PublishRequest, signal?: AbortSignal): Promise<PublicationReceipt> {
    signal?.throwIfAborted();
    this.store.savePlan(request.plan);
    const remote = await this.remote.prepare(request, signal);
    request.destinations = this.remote.replaySaveDestinations(request.operationId, request.destinations);
    const operation = request.operationId ? this.store.operationState(request.operationId) : undefined;
    if (operation?.receipt) { this.remote.validateReuse(remote, operation.receipt); return operation.receipt.status === "verified"
      ? this.extend(operation.receipt, request.destinations, signal)
      : this.finish(operation.receipt, request.plan, request.destinations, signal); }
    if (operation?.attempt && operation.attempt.status !== "rejected") {
      if (remote) return this.recoverCreation(request, operation.attempt, remote, signal);
      throw Object.assign(new Error("This operation already has an unresolved creation attempt."), { attempt: operation.attempt });
    }
    if (!request.force) {
      const existing = this.store.receiptForPlan(request.plan.hash);
      if (existing) { this.remote.validateReuse(remote, existing); this.store.bindOperationReceipt(request.operationId, existing); return this.extend(existing, request.destinations, signal); }
      const unfinished = this.store.latestReceiptForPlan(request.plan.hash);
      if (unfinished) {
        this.remote.validateReuse(remote, unfinished);
        this.store.bindOperationReceipt(request.operationId, unfinished);
        return this.finish(unfinished, request.plan, request.destinations, signal);
      }
    }
    const unresolved = this.store.unresolvedCreation(request.plan.hash);
    if (unresolved) {
      if (remote) return this.recoverCreation(request, unresolved, remote, signal);
      throw Object.assign(new Error("A block creation may already have reached Are.na. Inspect this attempt before creating another block."), { attempt: unresolved });
    }
    const media = request.plan.block.kind === "image" ? undefined
      : await (this.config.render ?? (await import("./render.ts")).renderPlan)(request.plan, this.config.mediaDirectory, { signal });
    signal?.throwIfAborted();
    const channelIds = await this.client.channelIds(request.destinations, signal);
    const firstChannelId = remote?.intent.inboxChannelId ?? channelIds[0]!;
    const payload = this.remote.creationPayload(this.payload(request.plan, media, [firstChannelId]), remote);
    signal?.throwIfAborted();
    const attempt: CreationAttempt = {
      id: crypto.randomUUID(), planHash: request.plan.hash,
      destinations: [...new Set(request.destinations)], status: "creating", createdAt: new Date().toISOString(),
      attemptedChannelIds: [firstChannelId],
      initialFields: { status: "pending", description: string(payload.description)!,
        ...(request.plan.block.kind === "text" ? { content: string(payload.value)! } : {}) },
      ...(media ? { mediaArtifact: { hash: media.hash, url: `${this.config.publicBaseUrl}/media/${media.hash}.${media.extension}`, mimeType: media.mimeType, size: media.size } } : {}),
    };
    const reservation = this.store.reserveCreation(attempt, request.force, request.operationId);
    if (reservation.receipt) { this.remote.validateReuse(remote, reservation.receipt); return reservation.receipt.status === "verified"
      ? this.extend(reservation.receipt, request.destinations, signal)
      : this.finish(reservation.receipt, request.plan, request.destinations, signal); }
    if (reservation.attempt) {
      if (remote) return this.recoverCreation(request, reservation.attempt, remote, signal);
      throw Object.assign(new Error("This plan already has an unresolved creation attempt."), { attempt: reservation.attempt });
    }
    if (remote) this.remote.beforeCreation(remote, attempt);
    let blockId: number;
    try {
      const created = await this.client.createBlock(payload, signal);
      const id = number(created.id);
      if (!id || id < 1) throw new Error("Are.na create response had no valid block ID");
      blockId = id;
    } catch (error) {
      // Authentication/authorization rejections prove the API did not create a
      // block. Keep the audit record, but release its creation reservation.
      if (error instanceof ArenaRequestError && [401, 403].includes(error.status)) {
        const rejected: CreationAttempt = { ...attempt, status: "rejected", error: error.message };
        this.store.saveCreation(rejected);
        throw Object.assign(error, { attempt: rejected });
      }
      const unknown: CreationAttempt = { ...attempt, status: "creation_unknown", error: error instanceof Error ? error.message : String(error) };
      this.store.saveCreation(unknown);
      if (remote) this.remote.creationUnknown(remote);
      throw Object.assign(new Error("Are.na creation outcome is unknown. Inspect the attempt before trying to create another block."), { attempt: unknown });
    }
    return this.created(request, attempt, blockId, remote, signal);
  }

  private async recoverCreation(request: PublishRequest, attempt: CreationAttempt, remote: RemoteSaveRecord, signal?: AbortSignal): Promise<PublicationReceipt> {
    const blockId = await this.remote.reconcileCreation(remote, attempt, signal);
    return this.created(request, attempt, blockId, remote, signal, true);
  }

  private created(request: PublishRequest, attempt: CreationAttempt, blockId: number, remote?: RemoteSaveRecord, signal?: AbortSignal, guardExistingContent = false): Promise<PublicationReceipt> {
    const now = new Date().toISOString();
    const receipt: PublicationReceipt = {
      id: crypto.randomUUID(),
      planHash: request.plan.hash,
      blockId,
      blockUrl: `https://www.are.na/block/${blockId}`,
      destinations: [...new Set(request.destinations)],
      connectionIds: [],
      ...(attempt.attemptedChannelIds ? { attemptedChannelIds: [...attempt.attemptedChannelIds] } : {}),
      status: "publishing",
      stage: "processing",
      ...(attempt.mediaArtifact ? { mediaArtifact: attempt.mediaArtifact } : {}),
      ...(attempt.initialFields ? { initialFields: structuredClone(attempt.initialFields) } : {}),
      createdAt: now,
      updatedAt: now,
      ...(remote ? { remoteProvenance: this.remote.receiptState(remote) } : {}),
    };
    if (remote) this.remote.recordCreated(remote, receipt);
    this.store.recordCreated(attempt, receipt, request.operationId);
    return this.finish(receipt, request.plan, request.destinations, signal, guardExistingContent);
  }

  private async finish(receipt: PublicationReceipt, plan: BlockPlan, destinations: string[], signal?: AbortSignal, guardExistingContent = true): Promise<PublicationReceipt> {
    await this.remote.authorizeReceipt(receipt, signal);
    const blockId = receipt.blockId;
    if (this.store.receipt(receipt.id)?.status === "verified") return this.extend(receipt, destinations, signal);
    await this.importLegacyPlacementAttempts(receipt, signal);
    receipt = this.store.beginPlacements(receipt.id, destinations);
    const stage = (value: NonNullable<PublicationReceipt["stage"]>) => {
      receipt = this.store.updateReceipt(receipt.id, current => current.status === "verified" ? current : ({ ...current,
        status: "publishing", stage: value, updatedAt: new Date().toISOString() }));
      signal?.throwIfAborted();
    };
    try {
      stage("processing");
      if (receipt.status === "verified") return this.place(receipt, destinations, signal);
      const available = await this.awaitAvailable(blockId, signal);
      const owner = crypto.randomUUID();
      const deadline = Date.now() + (this.config.verifyTimeoutMs ?? 120_000);
      while (true) {
        signal?.throwIfAborted();
        const reservation = this.store.reserveFinalization(receipt.id, owner);
        if (reservation === "verified") return this.place(this.store.receipt(receipt.id)!, destinations, signal);
        if (reservation === "acquired") break;
        if (Date.now() >= deadline) throw new Error("Another process is finalizing this block; retained intent can be resumed later");
        await wait(Math.min(50, this.config.pollIntervalMs ?? 50), signal);
      }
      try {
        stage(guardExistingContent ? "verifying" : "updating");
        // Only an unattempted update with unchanged initial fields can write
        // retained content. Older receipts require the final fields to match.
        const expectedBody = plan.block.kind === "text" ? plan.block.markdown : blockDescription(plan) ?? "";
        const actualBody = plan.block.kind === "text"
          ? string((available.content as Json | undefined)?.markdown) ?? string(available.content)
          : string((available.description as Json | undefined)?.markdown) ?? string(available.description);
        const actualDescription = string((available.description as Json | undefined)?.markdown) ?? string(available.description) ?? "";
        const initial = receipt.initialFields;
        const initialBody = plan.block.kind === "text" ? initial?.content : initial?.description;
        const unchangedInitialBody = initial?.status === "pending" && actualBody === initialBody;
        if (guardExistingContent && unchangedInitialBody && actualDescription !== initial.description)
          throw new Error("Retained block description changed or is missing; inspect the block before recovery to preserve user edits");
        const initializeFields = initial?.status === "pending" && unchangedInitialBody
          && actualDescription === initial.description && string(available.title) === plan.block.title;
        const checkFinalFields = guardExistingContent && !initializeFields;
        if (checkFinalFields && expectedBody && (actualBody === undefined || actualBody === ""))
          throw new Error("Retained block body is missing or empty; processing state or owner edit is uncertain, so recovery paused before overwriting it");
        if (checkFinalFields && (string(available.title) !== plan.block.title || actualBody !== undefined && actualBody !== expectedBody))
          throw new Error("Retained block content changed since creation; inspect the block before recovery to preserve user edits");
        if (checkFinalFields && plan.block.kind === "text" && plan.block.description !== undefined) {
          if ((actualDescription ?? "") !== plan.block.description) {
            throw new Error("Retained block description changed or is missing; inspect the block before recovery to preserve user edits");
          }
        }
        if (guardExistingContent && plan.block.kind === "link" && string(object(available.source)?.url) !== plan.block.canonicalSource)
          throw new Error("Retained Link source changed since creation; inspect the block before recovery to preserve user edits");
        // Persist the attempt before PUT; an uncertain update cannot be replayed
        // over an edit, even if that edit restores an initial placeholder.
        if (!guardExistingContent || initializeFields) {
          if (initial) receipt = this.store.updateReceipt(receipt.id, current => ({ ...current,
            initialFields: { ...current.initialFields!, status: "attempted" } }));
          await this.client.updateBlock(blockId, {
            title: plan.block.title,
            description: blockDescription(plan) ?? "",
            ...(plan.block.kind === "text" ? { content: plan.block.markdown } : {}),
          }, signal);
          if (initial) receipt = this.store.updateReceipt(receipt.id, current => ({ ...current,
            initialFields: { ...current.initialFields!, status: "applied" } }));
          stage("verifying");
        }
        const finalBlock = await this.client.block(blockId, signal);
        verifyPublication(plan, finalBlock, available);
        if (plan.block.kind === "link" && string(object(finalBlock.source)?.url) !== plan.block.canonicalSource)
          throw new Error("Are.na Link source does not match the block plan");
        const cover = arenaImageUrl(finalBlock);
        if (plan.block.kind === "link" && !cover) throw new Error("Are.na link block has no copied cover image");
        if (plan.block.kind === "image" && !cover) throw new Error("Are.na playlist Image block has no copied artwork");
        if (plan.block.kind === "audio" && plan.block.artworkUrl && !cover) throw new Error("Are.na audio block has no copied track artwork");
        if (plan.block.kind === "url" && plan.sources[0]?.provider === "soundcloud" && plan.block.artworkUrl && !cover) throw new Error("Are.na SoundCloud link has no copied track artwork");
        if (cover) this.store.setArenaCover(plan.hash, cover);
        // Content verification is permanent even if placement subsequently fails.
        receipt = this.store.updateReceipt(receipt.id, current => ({ ...current,
          status: "verified", stage: "connecting", updatedAt: new Date().toISOString() }));
      } finally { this.store.releaseFinalization(receipt.id, owner); }
      // Shared content-addressed media must remain available to concurrent captures
      // and delayed/repeated ingestion. Retention belongs to a separate policy.
      return this.place(receipt, destinations, signal);
    } catch (error) {
      const current = this.store.receipt(receipt.id)!;
      if (receipt.status !== "verified" && current.status === "verified" && !signal?.aborted) return this.place(current, destinations, signal);
      receipt = this.store.updateReceipt(receipt.id, current => ({
        ...current,
        status: current.status === "verified" ? "verified" : "needs_attention",
        updatedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      }));
      throw Object.assign(new Error(receipt.error), { receipt });
    }
  }

  private async extend(receipt: PublicationReceipt, destinations: string[], signal?: AbortSignal): Promise<PublicationReceipt> {
    await this.remote.authorizeReceipt(receipt, signal);
    await this.importLegacyPlacementAttempts(receipt, signal);
    receipt = this.store.beginPlacements(receipt.id, destinations);
    return this.place(receipt, destinations, signal);
  }

  private async importLegacyPlacementAttempts(receipt: PublicationReceipt, signal?: AbortSignal): Promise<void> {
    const current = this.store.receipt(receipt.id)!;
    if (current.remoteProvenance || current.attemptedChannelIds !== undefined) return;
    // Old create/connect POSTs could batch every retained pending target. Import
    // before registering this call's new destinations so completed legacy receipts
    // can still accept genuinely new placements without repeating uncertain ones.
    const attempted = await this.client.channelIds([...new Set([...current.destinations, ...(current.pendingDestinations ?? [])])], signal);
    this.store.updateReceipt(receipt.id, value => ({ ...value, attemptedChannelIds: value.attemptedChannelIds ?? attempted }));
  }

  private async place(receipt: PublicationReceipt, destinations: string[], signal?: AbortSignal): Promise<PublicationReceipt> {
    receipt = this.store.updateReceipt(receipt.id, current => ({ ...current, stage: "connecting", updatedAt: new Date().toISOString() }));
    try {
      await this.ensureConnections(receipt, destinations, signal);
      return this.store.updateReceipt(receipt.id, current => ({ ...current,
        stage: current.pendingDestinations?.length ? "connecting" : undefined,
        error: current.pendingDestinations?.length ? current.error : undefined,
        updatedAt: new Date().toISOString() }));
    } catch (error) {
      // A verified block stays verified; an uncertain connection write is checked
      // against live membership on the next request, never blindly repeated.
      receipt = this.store.updateReceipt(receipt.id, current => ({ ...current,
        error: error instanceof Error ? error.message : String(error), updatedAt: new Date().toISOString() }));
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { receipt });
    }
  }

  private async ensureConnections(receipt: PublicationReceipt, destinations: string[], signal?: AbortSignal): Promise<PublicationReceipt> {
    signal?.throwIfAborted();
    if (receipt.remoteProvenance) return this.remote.ensurePlacements(receipt, destinations, signal);
    const pending = this.store.receipt(receipt.id)!.pendingDestinations ?? [];
    const expected = [...new Set([...pending, ...destinations])];
    const has = (rows: Awaited<ReturnType<ArenaClient["connections"]>>, destination: string) => rows.some(row => row.slug === destination || String(row.channelId) === destination);
    await this.importLegacyPlacementAttempts(receipt, signal);
    const handled = new Set<number>();
    for (const destination of expected) {
      signal?.throwIfAborted();
      const channelId = (await this.client.channelIds([destination], signal))[0]!;
      if (handled.has(channelId)) continue;
      handled.add(channelId);
      const current = await this.client.connections(receipt.blockId, signal);
      if (!has(current, destination)) {
        const metadata = await this.remote.initialEventPlacement(receipt, channelId, signal);
        signal?.throwIfAborted();
        if (!this.store.reservePlacementAttempt(receipt.id, channelId))
          throw new Error("A previously attempted placement remains unconfirmed; no duplicate connect was attempted");
        signal?.throwIfAborted();
        if (metadata) await this.client.connectWithMetadata(receipt.blockId, [{ id: channelId, metadata }], signal);
        else await this.client.connect(receipt.blockId, [destination], signal);
        const after = await this.client.connections(receipt.blockId, signal);
        if (!has(after, destination)) throw new Error("Are.na did not retain the attempted channel connection; later placements were not sent");
      }
      this.store.rememberBlockConnectionAttempts(receipt.blockId, [channelId], `receipt:${receipt.id}`);
      await this.remote.verifyInitialEventPlacement(receipt, channelId, signal);
    }
    for (let retry = 0; retry < 20; retry++) {
      signal?.throwIfAborted();
      const snapshot = this.store.receiptSnapshot(receipt.id);
      const current = await this.client.connections(receipt.blockId, signal);
      const known = [...new Set([...snapshot.receipt.destinations, ...(snapshot.receipt.pendingDestinations ?? [])])];
      const confirmed = known.filter(destination => has(current, destination));
      const ids = await this.connectionIds(receipt.blockId, confirmed, signal);
      const next = this.store.confirmPlacements(receipt.id, snapshot.revision, confirmed, ids);
      if (!next) continue; // Another instance changed state: refresh reads, never repeat the POST.
      if (expected.some(destination => !has(current, destination))) throw new Error("Are.na did not retain every requested channel connection");
      return next;
    }
    throw new Error("Channel placements changed repeatedly; retained intent can be checked again with resume");
  }

  private payload(plan: BlockPlan, media: RenderedMedia | undefined, channelIds: number[]): Json {
    return publicationPayload(plan, this.config.publicBaseUrl, media, channelIds);
  }

  private async connectionIds(blockId: number, destinations: string[], signal?: AbortSignal): Promise<number[]> {
    const ids = await Promise.all(destinations.map((destination) => this.client.connectionId(blockId, destination, signal)));
    if (ids.some((id) => id === undefined)) throw new Error("Unable to resolve every Are.na connection ID");
    return ids as number[];
  }

  private async awaitAvailable(blockId: number, signal?: AbortSignal): Promise<Json> {
    const deadline = Date.now() + (this.config.verifyTimeoutMs ?? 120_000);
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      let block: Json;
      try { block = await this.client.block(blockId, signal); }
      catch (error) {
        if (!(error instanceof TypeError) && !(error instanceof DOMException && error.name === "TimeoutError")
          && !(error instanceof ArenaRequestError && (error.status === 429 || error.status >= 500))) throw error;
        await wait(this.config.pollIntervalMs ?? 1500, signal);
        continue;
      }
      const state = string(block.state);
      if (state === "available") return block;
      if (state === "failed") {
        const content = object(block.content);
        const renderedText = block.type === "Text" && typeof content?.markdown === "string"
          && typeof content?.html === "string" && content.html.length > 0;
        const detail = renderedText ? "Are.na returned Markdown and rendered HTML, but processing is not verified"
          : "content remains unverified";
        throw new Error(`Are.na block processing failed for retained block ${blockId}; ${detail}; check channel placements separately; no replacement block was created`);
      }
      await wait(this.config.pollIntervalMs ?? 1500, signal);
    }
    throw new Error("Timed out waiting for Are.na block processing");
  }


}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
