import { requiredPlanCapabilities } from "./plan-capabilities.ts";
import type { BlockPlan, CompositionPolicy, PublicationReceipt, CreationAttempt, PublicationState, PublishRequest } from "./types.ts";
import { blockPlanSchema, publicationReceiptSchema, creationAttemptSchema, publicationStateSchema } from "./types.ts";
import { buildInfoSchema } from "./version.ts";
import { arenaBlockMetadataSchema } from "./metadata.ts";
import { parseArenaBlockUrl } from "../packages/core/url.ts";
import { z } from "zod";
import { abortable, deadline } from "./bounded-io.ts";
import { saveStatusSchema, retainedIntentSchema, type SaveSubmission, type SaveStatus, type SaveBackend } from "./save-gateway.ts";
import type { SaveIntent } from "./save-intent.ts";
import type { UserConfig, SaveOrigin } from "./config.ts";
import { credentialProfile } from "./config.ts";

type Fetcher = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => ReturnType<typeof fetch>;

export class PublicationError extends Error {
  constructor(message: string, readonly receipt?: PublicationReceipt, readonly attempt?: CreationAttempt, readonly saveStatus?: SaveStatus,
    readonly userInterrupted = false) { super(message); }
}

export class OwnerHttpError extends Error {
  constructor(readonly status: number | undefined, readonly contentType: string, readonly bodyClass: "html" | "json" | "text" | "binary" | "empty",
    readonly retryAfterMs?: number) {
    super(`Owner service returned ${status === undefined ? "an unreadable response" : `HTTP ${status}`} (${contentType || "unknown content type"}, ${bodyClass})`);
  }
  get transient(): boolean { return this.status === 429 || this.status !== undefined && (this.status >= 500 && this.status <= 599); }
}

function retryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value.trim()) * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(30_000, Math.ceil(seconds)) : undefined;
}

function bodyClass(value: string): OwnerHttpError["bodyClass"] {
  const trimmed = value.trimStart();
  if (!trimmed) return "empty";
  if (trimmed.startsWith("<")) return "html";
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return "json";
  return /[\x00-\x08\x0E-\x1F]/.test(trimmed.slice(0, 128)) ? "binary" : "text";
}

async function responseText(response: Response, limit: number, signal: AbortSignal, prefixOnly = false): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const part = await abortable(reader.read(), signal);
      if (part.done) break;
      if (prefixOnly && size + part.value.byteLength > limit) {
        chunks.push(part.value.subarray(0, limit - size)); break;
      }
      size += part.value.byteLength;
      if (size > limit) throw new Error(`Owner response exceeds ${limit} bytes`);
      chunks.push(part.value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { void reader.cancel().catch(() => {}); try { reader.releaseLock(); } catch {} }
}

async function pause(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export class ArenaBlockClient {
  constructor(private readonly endpoint: string, private readonly token: string, private readonly fetcher: Fetcher = fetch) {}

  private async request(path: string, body?: unknown, signal?: AbortSignal, timeoutMs = body === undefined ? 10_000 : 160_000): Promise<unknown> {
    if (body && typeof body === "object" && "plan" in body) {
      const required = requiredPlanCapabilities((body as { plan: BlockPlan }).plan);
      if (required.length) {
        const serving = buildInfoSchema.parse(await this.request("/v1/version", undefined, signal));
        const missing = required.filter(capability => !serving.planCapabilities?.includes(capability));
        if (missing.length) throw new PublicationError(`Daemon does not support this plan (${missing.join(", ")}). Local resolve, plan and render are available; install a matching daemon before publishing. No save was submitted.`);
      }
    }
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    if (serialized && Buffer.byteLength(serialized) > 4 * 1024 * 1024) throw new Error("Request exceeds 4 MiB");
    for (let attempt = 0; ; attempt++) {
      const bounded = deadline(timeoutMs, signal);
      try {
        const response = await abortable(this.fetcher(`${this.endpoint.replace(/\/$/, "")}${path}`, {
          method: body === undefined ? "GET" : "POST",
          signal: bounded, redirect: "error",
          headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
          ...(serialized === undefined ? {} : { body: serialized }),
        }), bounded);
        const type = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase().slice(0, 80);
        const after = retryAfter(response.headers.get("retry-after"));
        if (type !== "application/json" && !type.endsWith("+json")) {
          const prefix = await responseText(response, 1024, bounded, true);
          throw new OwnerHttpError(response.status, type, bodyClass(prefix), after);
        }
        const raw = await responseText(response, 4 * 1024 * 1024, bounded);
        let value: any;
        try { value = JSON.parse(raw); }
        catch { throw new OwnerHttpError(response.status, type, bodyClass(raw), after); }
        if (!response.ok) {
          if (response.status === 429 || response.status >= 500) throw new OwnerHttpError(response.status, type, "json", after);
          throw new PublicationError(typeof value?.error === "string" ? value.error : `arena-block returned ${response.status}`,
            publicationReceiptSchema.safeParse(value?.receipt ?? value?.saveStatus?.receipt).data, creationAttemptSchema.safeParse(value?.attempt ?? value?.saveStatus?.attempt).data, saveStatusSchema.safeParse(value?.saveStatus).data);
        }
        return value;
      } catch (error) {
        // GET is read-only. A POST may already have reached the journal or Are.na.
        if (body !== undefined || attempt >= 2 || signal?.aborted || !(error instanceof OwnerHttpError && (error.transient || error.status === 200)
          || error instanceof TypeError || error instanceof DOMException && error.name === "TimeoutError")) throw error;
        await pause(error instanceof OwnerHttpError ? error.retryAfterMs ?? 400 * (attempt + 1) : 400 * (attempt + 1), signal);
      }
    }
  }

  async plan(refs: string[], policy?: Partial<CompositionPolicy>, signal?: AbortSignal): Promise<BlockPlan> {
    return blockPlanSchema.parse(await this.request("/v1/plans", { refs, policy }, signal));
  }

  async webPlan(url: string, title?: string, description?: string, signal?: AbortSignal): Promise<BlockPlan> {
    return blockPlanSchema.parse(await this.request("/v1/web-plans", { url, ...(title ? { title } : {}), ...(description ? { description } : {}) }, signal, 15_000));
  }

  async channels(page = 1, signal?: AbortSignal): Promise<{ accountId: number; channels: Array<{ id: number; title: string; slug: string; visibility: string; owner: { name: string; slug: string }; count?: number; canAdd?: boolean }>; nextPage: number | null }> {
    return z.object({ accountId: z.number().int().positive(), channels: z.array(z.object({
      id: z.number().int().positive(), title: z.string(), slug: z.string(), visibility: z.string(),
      owner: z.object({ name: z.string(), slug: z.string() }), count: z.number().int().nonnegative().optional(), canAdd: z.boolean().optional(),
    })), nextPage: z.number().int().positive().nullable() }).parse(await this.request(`/v1/channels?page=${page}`, undefined, signal, 20_000));
  }

  async channelIndex(signal?: AbortSignal) {
    return z.object({ accountId: z.number().int().positive(), channels: z.array(z.object({
      id: z.number().int().positive(), title: z.string(), slug: z.string(), visibility: z.string(),
      owner: z.object({ name: z.string(), slug: z.string() }), count: z.number().int().nonnegative().optional(), canAdd: z.boolean().optional(),
    })), updatedAt: z.string(), completeAt: z.string().nullable() }).parse(await this.request("/v1/channel-index", undefined, signal, 20_000));
  }

  async channelLabels(refs: string[], signal?: AbortSignal): Promise<Array<{ ref: string; id: number; title: string; slug: string }>> {
    if (!refs.length || refs.length > 20 || refs.some(ref => !/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(ref)))
      throw new Error("Invalid channel label refs");
    const query = [...new Set(refs)].map(ref => `ref=${encodeURIComponent(ref)}`).join("&");
    return z.array(z.object({ ref: z.string(), id: z.number().int().positive().safe(), title: z.string(), slug: z.string() }).strict()).max(20)
      .parse(await this.request(`/v1/channel-labels?${query}`, undefined, signal, 3_000));
  }

  async channelSearch(query: string, scope: "following" | "all", page = 1, signal?: AbortSignal) {
    return z.object({ accountId: z.number().int().positive(), channels: z.array(z.object({
      id: z.number().int().positive(), title: z.string(), slug: z.string(), visibility: z.string(),
      owner: z.object({ name: z.string(), slug: z.string() }), count: z.number().int().nonnegative().optional(), canAdd: z.boolean().optional(),
    })), nextPage: z.number().int().positive().nullable() }).parse(await this.request(`/v1/channel-search?scope=${scope}&query=${encodeURIComponent(query)}&page=${page}`, undefined, signal, 20_000));
  }

  async existingBlock(blockId: number, signal?: AbortSignal) {
    return z.object({ blockId: z.number().int().positive(), blockUrl: z.url(), title: z.string(), type: z.string(), state: z.string() })
      .parse(await this.request(`/v1/existing-blocks/${blockId}`, undefined, signal));
  }

  async blockMetadata(blockUrl: string, signal?: AbortSignal) {
    const blockId = parseArenaBlockUrl(blockUrl);
    return arenaBlockMetadataSchema.parse(await this.request(`/v1/blocks/${blockId}/metadata`, undefined, signal, 35_000));
  }

  async existingPlacement(input: { id: string; blockId: number; destinations: number[] }) {
    return this.request("/v1/existing-placements", input);
  }

  async existingPlacementStatus(id: string) {
    z.uuid().parse(id);
    return this.request(`/v1/existing-placements/${id}`);
  }

  async retryExistingPlacement(id: string) {
    z.uuid().parse(id);
    return this.request(`/v1/existing-placements/${id}/retry`, {});
  }

  async cancelExistingPlacement(id: string) {
    z.uuid().parse(id);
    return this.request(`/v1/existing-placements/${id}/cancel`, {});
  }

  async publish(plan: BlockPlan, destinations: string[], force = false, signal?: AbortSignal, operationId?: string, remoteSave?: PublishRequest["remoteSave"]): Promise<PublicationReceipt> {
    return publicationReceiptSchema.parse(await this.request("/v1/publications", { plan, destinations, force, ...(operationId ? { operationId } : {}), ...(remoteSave ? { remoteSave } : {}) }, signal));
  }

  async receipt(id: string, signal?: AbortSignal): Promise<PublicationReceipt> {
    return publicationReceiptSchema.parse(await this.request(`/v1/publications/${encodeURIComponent(id)}`, undefined, signal));
  }

  async version() {
    return buildInfoSchema.parse(await this.request("/v1/version"));
  }

  async storedPlan(hash: string): Promise<BlockPlan> {
    return blockPlanSchema.parse(await this.request(`/v1/plans/${encodeURIComponent(hash)}`));
  }

  async attempt(id: string): Promise<CreationAttempt> {
    return creationAttemptSchema.parse(await this.request(`/v1/publication-attempts/${encodeURIComponent(id)}`));
  }

  async publicationState(hash: string, signal?: AbortSignal): Promise<PublicationState> {
    return publicationStateSchema.parse(await this.request(`/v1/publications?plan=${encodeURIComponent(hash)}`, undefined, signal));
  }

  async operation(id: string, signal?: AbortSignal): Promise<PublicationState> {
    const state = publicationStateSchema.parse(await this.request(`/v1/publication-operations/${encodeURIComponent(id)}`, undefined, signal));
    if (state.operationId !== id) throw new Error("Publication operation response does not match the request");
    return state;
  }

  async resume(id: string, destinations: string[], signal?: AbortSignal): Promise<PublicationReceipt> {
    return publicationReceiptSchema.parse(await this.request(`/v1/publications/${encodeURIComponent(id)}/resume`, { destinations }, signal));
  }

  async assertSaveProfile(config: UserConfig, origin: SaveOrigin, selected?: string): Promise<void> {
    const profile = credentialProfile(config, origin, selected);
    const policy = z.object({ credential: z.object({ profile: z.string(), arenaTokenEnv: z.string(), expectedAccountId: z.number().int().positive().safe().optional() }), mcpPublishingEnabled: z.boolean() }).parse(await this.request("/v1/save-policy"));
    if (profile.name !== policy.credential.profile || profile.arenaTokenEnv !== policy.credential.arenaTokenEnv
      || profile.expectedAccountId !== undefined && policy.credential.expectedAccountId !== undefined && profile.expectedAccountId !== policy.credential.expectedAccountId) throw new Error("Selected client credential profile/account does not match the daemon; no fallback or save was attempted");
    if (origin !== "cli" && !policy.mcpPublishingEnabled) throw new Error("MCP publishing is disabled on this daemon");
  }

  async save(input: SaveSubmission, origin: "cli" | "mcp-local" = "cli", signal?: AbortSignal): Promise<SaveStatus> {
    const status = saveStatusSchema.parse(await this.request(origin === "cli" ? "/v1/saves" : "/v1/mcp-saves", input, signal));
    if (status.saveId !== input.snapshot.saveId) throw new Error("Save response does not match the operation UUID");
    return status;
  }

  /** Start a CLI save without holding one Cloudflare request open through media rendering. */
  async beginCliSave(input: SaveSubmission, signal?: AbortSignal): Promise<SaveStatus> {
    const id = input.snapshot.saveId;
    try {
      const status = saveStatusSchema.parse(await this.request("/v1/saves?async=1", input, signal, 15_000));
      if (status.saveId !== id) throw new Error("Save response does not match the operation UUID");
      return status;
    } catch (error) {
      if (!this.transientOwnerFailure(error)) throw error;
      // The first POST may have reached the daemon. Read the journal first.
      for (let check = 0; check < 2; check++) {
        await pause(check ? 1200 : 300, signal);
        try { return await this.saveStatus(id, "cli", signal); }
        catch (statusError) {
          if (statusError instanceof PublicationError && /not found in this journal/i.test(statusError.message)) continue;
          throw statusError;
        }
      }
      // The immutable save UUID is the idempotency key even if the first POST arrives late.
      await pause(error instanceof OwnerHttpError ? error.retryAfterMs ?? 1200 : 1200, signal);
      try {
        const status = saveStatusSchema.parse(await this.request("/v1/saves?async=1", input, signal, 15_000));
        if (status.saveId !== id) throw new Error("Save response does not match the operation UUID");
        return status;
      } catch (retryError) {
        if (!this.transientOwnerFailure(retryError)) throw retryError;
        return this.saveStatus(id, "cli", signal);
      }
    }
  }

  private transientOwnerFailure(error: unknown): boolean {
    return error instanceof OwnerHttpError && (error.transient || error.status === 200)
      || error instanceof TypeError || error instanceof DOMException && error.name === "TimeoutError";
  }

  private async awaitCliSave(id: string, initial: SaveStatus, signal?: AbortSignal, precreateRetries = 1): Promise<PublicationReceipt> {
    let status = initial, failedReads = 0;
    const stopAt = Date.now() + 660_000;
    while (Date.now() < stopAt) {
      signal?.throwIfAborted();
      if (!status.active && !status.failure && status.phase === "saved" && status.receipt) return status.receipt;
      if (!status.active && status.phase === "unknown" && !status.failure && !status.receipt && !status.attempt && !status.cancelRequested && precreateRetries > 0) {
        precreateRetries--;
        await pause(1600, signal);
        status = await this.saveStatus(id, "cli", signal);
        if (status.active || status.receipt || status.attempt || status.cancelRequested || status.phase !== "unknown") continue;
        // The journal proves no Are.na creation reservation was made. Replay the exact retained intent.
        status = saveStatusSchema.parse(await this.request(`/v1/saves/${id}/retry?async=1`, {}, signal, 15_000));
        if (status.saveId !== id) throw new Error("Save recovery response does not match its UUID");
        continue;
      }
      if (!status.active) break;
      await pause(1500, signal);
      try { status = await this.saveStatus(id, "cli", signal); failedReads = 0; }
      catch (error) {
        if (!this.transientOwnerFailure(error) || ++failedReads > 5) throw error;
        await pause(Math.min(10_000, 600 * 2 ** failedReads), signal);
      }
    }
    throw new PublicationError(status.failure?.message ?? (status.phase === "unknown" ? "Save outcome remains uncertain; inspect retained status before recovery"
      : status.phase === "partial" ? "Save has a retained block or pending placement; inspect before recovery"
      : "Save did not complete; inspect retained status before recovery"), status.receipt, status.attempt, status);
  }

  async saveStatus(id: string, origin: "cli" | "mcp-local" = "cli", signal?: AbortSignal): Promise<SaveStatus> {
    z.uuid().parse(id);
    // The status endpoint reads a local journal. Bound the whole read, including
    // transport retries, so an inspection command does not wait repeatedly.
    const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(8_000)]) : AbortSignal.timeout(8_000);
    const status = saveStatusSchema.parse(await this.request(`${origin === "cli" ? "/v1/saves" : "/v1/mcp-saves"}/${id}`, undefined, bounded, 8_000));
    if (status.saveId !== id) throw new Error("Save status does not match the operation UUID");
    return status;
  }

  async cancelSave(id: string, origin: "cli" | "mcp-local" = "cli", signal?: AbortSignal): Promise<SaveStatus> {
    z.uuid().parse(id);
    const status = saveStatusSchema.parse(await this.request(`${origin === "cli" ? "/v1/saves" : "/v1/mcp-saves"}/${id}/cancel`, {}, signal, 10_000));
    if (status.saveId !== id) throw new Error("Cancellation response does not match the operation UUID");
    return status;
  }

  async retainedIntent(id: string) {
    z.uuid().parse(id);
    const intent = retainedIntentSchema.parse(await this.request(`/v1/saves/${id}/intent`));
    if (intent.snapshot.saveId !== id) throw new Error("Retained intent does not match its save UUID");
    return intent;
  }

  async beginCliRetry(id: string, signal?: AbortSignal): Promise<SaveStatus> {
    z.uuid().parse(id);
    const status = saveStatusSchema.parse(await this.request(`/v1/saves/${id}/retry?async=1`, {}, signal, 15_000));
    if (status.saveId !== id) throw new Error("Recovery response does not match its save UUID");
    return status;
  }

  async retrySave(id: string, signal?: AbortSignal): Promise<PublicationReceipt> {
    return this.awaitCliSave(id, await this.beginCliRetry(id, signal), signal, 0);
  }

  mcpBackend(): SaveBackend {
    return { save: (input, signal) => this.save(input, "mcp-local", signal), status: (id, signal) => this.saveStatus(id, "mcp-local", signal), cancel: (id, signal) => this.cancelSave(id, "mcp-local", signal) };
  }

  async publishIntent(plan: BlockPlan, intent: SaveIntent, remoteMode?: "summary" | "full", signal?: AbortSignal): Promise<PublicationReceipt> {
    const status = await this.beginCliSave({ plan, snapshot: intent.snapshot, snapshotSha256: intent.snapshotSha256, ...(remoteMode ? { remoteMode } : {}) }, signal);
    return this.awaitCliSave(intent.snapshot.saveId, status, signal);
  }
}
