import { publicationFields, publicationPayload } from "../../packages/core/capture.ts";
import { verifyPublication } from "../../packages/core/verification.ts";
import type { BlockPlan, InitialFields } from "../../packages/core/types.ts";

export type BrowserSavePhase = "prepared" | "creating" | "unknown" | "created" | "partial" | "saved" | "rejected";
export type BrowserSaveIntent = {
  saveId: string;
  accountId: number;
  plan: BlockPlan;
  destinations: string[];
  channelIds: number[];
  phase: BrowserSavePhase;
  creatingAt?: number;
  blockId?: number;
  initialFields?: InitialFields;
};
export type BrowserSaveStore = {
  get(saveId: string): Promise<BrowserSaveIntent | undefined>;
  put(intent: BrowserSaveIntent): Promise<void>;
};
export type BrowserCredentialProvider = { token(): Promise<string> };
type Fetcher = typeof fetch;

function obj(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Unexpected Are.na response");
  return value as Record<string, any>;
}
function body(value: unknown): Record<string, any> {
  const top = obj(value);
  return top.data && !Array.isArray(top.data) ? obj(top.data) : top;
}
function positiveId(value: unknown): number {
  const id = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) throw new Error("Are.na returned no valid ID");
  return id;
}
function normalizeChannel(value: string): string {
  const channel = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(channel)) throw new Error("Choose a channel slug or numeric ID");
  return channel;
}

/** The same fallback/always rules used by the CLI, with a single browser-local default. */
export function routeBrowserDestinations(requested: string[], defaultChannel?: { channel: string; mode: "fallback" | "always" }): string[] {
  const explicit = [...new Set(requested.filter(Boolean).map(normalizeChannel))];
  const chosen = defaultChannel ? normalizeChannel(defaultChannel.channel) : undefined;
  const include = chosen && (defaultChannel?.mode === "always" || explicit.length === 0 || explicit.includes(chosen));
  const destinations = [...new Set([...(include ? [chosen] : []), ...explicit])];
  if (!destinations.length) throw new Error("Choose a channel before saving");
  if (destinations.length > 20) throw new Error("Choose at most 20 channels");
  return destinations;
}

export function browserCanPublish(plan: BlockPlan): boolean {
  return ["text", "url", "image"].includes(plan.block.kind);
}

export class BrowserSaver {
  private readonly initializing = new Map<string, Promise<void>>();
  constructor(private readonly credentials: BrowserCredentialProvider, private readonly store: BrowserSaveStore,
    private readonly fetcher: Fetcher = ((input, init) => globalThis.fetch(input, init)) as Fetcher,
    private readonly apiBase = "https://api.are.na/v3") {}

  private async request(method: string, path: string, token: string, payload?: unknown): Promise<Record<string, any>> {
    const response = await this.fetcher(`${this.apiBase}${path}`, {
      method, redirect: "error", credentials: "omit", headers: {
        accept: "application/json", authorization: `Bearer ${token}`, "content-type": "application/json",
      }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw Object.assign(new Error(`Are.na ${method} ${path} returned ${response.status}`), { status: response.status });
    }
    return body(await response.json());
  }

  private async account(token: string): Promise<number> {
    return positiveId((await this.request("GET", "/me", token)).id);
  }

  /** Authenticate and resolve channels before reserving a durable intent. No write occurs here. */
  async prepare(saveId: string, plan: BlockPlan, requested: string[], defaultChannel?: { channel: string; mode: "fallback" | "always" }): Promise<BrowserSaveIntent> {
    const existing = await this.store.get(saveId);
    if (existing) {
      if (existing.plan.hash !== plan.hash || JSON.stringify(existing.destinations) !== JSON.stringify(routeBrowserDestinations(requested, defaultChannel))) {
        throw new Error("This save ID belongs to a different block or channel.");
      }
      return existing;
    }
    if (!browserCanPublish(plan)) throw new Error("This block needs the local helper to prepare its media.");
    const destinations = routeBrowserDestinations(requested, defaultChannel);
    const token = await this.credentials.token();
    const accountId = await this.account(token);
    const channelIds: number[] = [];
    for (const destination of destinations) {
      const channel = await this.request("GET", `/channels/${encodeURIComponent(destination)}`, token);
      channelIds.push(positiveId(channel.id));
    }
    const intent: BrowserSaveIntent = { saveId, accountId, plan: structuredClone(plan), destinations,
      channelIds: [...new Set(channelIds)], phase: "prepared" };
    await this.store.put(intent);
    return intent;
  }

  /** An interrupted POST is unknown; never replay it without reconciliation. */
  async create(saveId: string): Promise<BrowserSaveIntent> {
    const intent = await this.store.get(saveId);
    if (!intent) throw new Error("Save intent is missing");
    if (intent.phase !== "prepared" && intent.phase !== "rejected") return intent;
    const payload = publicationPayload(intent.plan, "", undefined, intent.channelIds);
    const token = await this.credentials.token();
    if (await this.account(token) !== intent.accountId) throw new Error("The signed-in Are.na account changed");
    const creating: BrowserSaveIntent = { ...intent, phase: "creating", creatingAt: Date.now(),
      initialFields: { status: "pending", description: String(payload.description),
        ...(intent.plan.block.kind === "text" ? { content: String(payload.value) } : {}) } };
    await this.store.put(creating);
    let created: BrowserSaveIntent;
    try {
      const blockId = positiveId((await this.request("POST", "/blocks", token, payload)).id);
      created = { ...creating, phase: "created" as const, blockId };
      await this.store.put(created);
    } catch (error) {
      const status = (error as { status?: number }).status;
      const phase = status === 401 || status === 403 ? "rejected" as const : "unknown" as const;
      const outcome = { ...creating, phase };
      await this.store.put(outcome);
      return outcome;
    }
    try { return await this.check(saveId); }
    catch { return await this.store.get(saveId) ?? created; }
  }

  private async initializeFields(intent: BrowserSaveIntent, block: Record<string, any>, token: string): Promise<void> {
    const running = this.initializing.get(intent.saveId);
    if (running) return running;
    const operation = (async () => {
      const latest = await this.store.get(intent.saveId);
      if (!latest || latest.blockId !== intent.blockId) throw new Error("Save identity changed during initialization");
      const initial = latest.initialFields;
      if (initial?.status !== "pending") return;
      try { verifyPublication(latest.plan, block, block); return; } catch {}
      const staged: BlockPlan = { ...latest.plan, block: { ...latest.plan.block,
        markdown: latest.plan.block.kind === "text" ? initial.content! : latest.plan.block.kind === "image" ? initial.description : "",
        description: latest.plan.block.kind === "image" ? undefined : initial.description } };
      verifyPublication(staged, block, block);
      await this.store.put({ ...latest, initialFields: { ...initial, status: "attempted" } });
      await this.request("PUT", `/blocks/${intent.blockId}`, token, publicationFields(latest.plan));
      await this.store.put({ ...latest, initialFields: { ...initial, status: "applied" } });
    })().finally(() => { if (this.initializing.get(intent.saveId) === operation) this.initializing.delete(intent.saveId); });
    this.initializing.set(intent.saveId, operation);
    return operation;
  }

  /** Complete unchanged initial fields for a known block; unknown creation remains unknown. */
  async check(saveId: string): Promise<BrowserSaveIntent> {
    let intent = await this.store.get(saveId);
    if (!intent) throw new Error("Save intent is missing");
    if (intent.phase === "creating" && !intent.blockId) {
      if (intent.creatingAt && Date.now() - intent.creatingAt < 30_000) return intent;
      const unknown = { ...intent, phase: "unknown" as const };
      const latest = await this.store.get(saveId);
      if (latest && latest.phase !== intent.phase) return latest;
      await this.store.put(unknown);
      return unknown;
    }
    if (!intent.blockId || intent.phase === "saved") return intent;
    const token = await this.credentials.token();
    if (await this.account(token) !== intent.accountId) throw new Error("The signed-in Are.na account changed");
    let block = await this.request("GET", `/blocks/${intent.blockId}`, token);
    if (positiveId(block.id) !== intent.blockId) throw new Error("Are.na returned a different block ID");
    if (block.state !== "available") return intent;
    if (intent.initialFields?.status === "pending") {
      await this.initializeFields(intent, block, token);
      intent = await this.store.get(saveId);
      if (!intent?.blockId) throw new Error("Save identity changed during initialization");
      block = await this.request("GET", `/blocks/${intent.blockId}`, token);
      if (positiveId(block.id) !== intent.blockId) throw new Error("Are.na returned a different block ID");
      if (block.state !== "available") return intent;
    }
    verifyPublication(intent.plan, block, block);
    const response = await this.fetcher(`${this.apiBase}/blocks/${intent.blockId}/connections?per=100&page=1`, {
      method: "GET", redirect: "error", credentials: "omit",
      headers: { accept: "application/json", authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`Could not verify channel placement (${response.status})`);
    const page = obj(await response.json());
    const meta = obj(page.meta);
    const rows = page.data;
    if (!Array.isArray(rows) || Number(meta.current_page) !== 1 || Number(meta.total_pages) !== 1 || meta.has_more_pages === true) {
      throw new Error("Channel placement needs a complete verification page");
    }
    const present = new Set<number>(rows.map((row: unknown) => positiveId(obj(row).id)));
    const verified = intent.channelIds.every(id => present.has(id));
    const latest = await this.store.get(saveId);
    if (!latest || latest.blockId !== intent.blockId) throw new Error("Save identity changed during verification");
    if (latest.phase === "saved" || latest.phase !== intent.phase && !verified) return latest;
    const result = { ...intent, phase: verified ? "saved" as const : "partial" as const };
    await this.store.put(result);
    return result;
  }
}
