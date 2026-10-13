import { snapshotDefaultChannel } from "./provenance-schema.ts";
import { z } from "zod";
import { blockPlanSchema } from "./types.ts";
import { loadUserConfig, credentialProfile, type UserConfig, type SaveOrigin } from "./config.ts";
import { initiatorSchema, prepareSaveIntent, saveSnapshotSchema } from "./save-intent.ts";
import { saveStatusSchema, type SaveBackend } from "./save-gateway.ts";
import { abortable, deadline } from "./bounded-io.ts";
import { redactProvenance } from "./provenance-redaction.ts";
import { formatArenaBlockMetadata } from "./metadata.ts";
import type { ArenaBlockClient } from "./client.ts";

const previewInput = z.object({
  plan: blockPlanSchema,
  destinations: z.array(z.string().min(1).max(2048)).max(20).default([]),
  agent: initiatorSchema.pick({ label: true, workflowId: true }).optional(),
  saveId: z.uuid().optional(), force: z.boolean().default(false),
}).strict();
const saveInput = z.object({ intent: z.object({ snapshot: saveSnapshotSchema, snapshotSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict() }).strict();
const idInput = z.object({ saveId: z.uuid() }).strict();
const metadataInput = z.object({ block_url: z.url() }).strict();
const emptyInput = z.object({}).strict();
const protocolId = z.union([z.string().min(1).max(120), z.number().int().safe()]);
export type McpOptions = { backend?: SaveBackend; metadataReader?: Pick<ArenaBlockClient, "blockMetadata">; credentialProfile?: string; callTimeoutMs?: number };

/** Transport is fixed by the adapter; client and initiator are separate declared assertions. */
export function createMcpSession(config: UserConfig, origin: Exclude<SaveOrigin, "cli"> = "mcp-local", options: McpOptions = {}) {
  const profile = credentialProfile(config, origin, options.credentialProfile);
  let initialized = false, ready = false;
  let client: { name: string; version: string; identityBasis: "declared" } | undefined;
  const active = new Map<string | number, { controller: AbortController; saveId?: string; cancelled: boolean }>();
  const tools = [
    { name: "arena_block_preview_save", description: "Prepare the exact immutable save capsule and route. No source fetch, rendering, credential access or Are.na writes. Preserve snapshot and checksum for save/replay.",
      inputSchema: z.toJSONSchema(previewInput), annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
    { name: "arena_block_policy", description: "Inspect explicit routing and credential-profile selection without credential values.",
      inputSchema: z.toJSONSchema(emptyInput), annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
    ...(options.metadataReader ? [
      { name: "read_arena_block_metadata", description: "Read an Are.na block and its visible channel placements, keeping block metadata distinct from each connection's metadata. No Are.na writes.",
        inputSchema: z.toJSONSchema(metadataInput), annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } },
    ] : []),
    ...(options.backend ? [
      { name: "arena_block_save", description: "Publish a prepared capsule through the existing owner daemon and durable journal. Reuse its original UUID and checksum for recovery; uncertain outcomes never trigger a blind second create.", inputSchema: z.toJSONSchema(saveInput), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } },
      { name: "arena_block_save_status", description: "Read journaled status by save UUID, retaining successful receipts and unknown/partial outcomes. No Are.na writes.", inputSchema: z.toJSONSchema(idInput), annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
      { name: "arena_block_cancel_save", description: "Request cancellation by save UUID. This stops active work and retains committed blocks, connections and receipts; inspect status before replay.", inputSchema: z.toJSONSchema(idInput), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
    ] : []),
  ];
  return async function dispatch(input: unknown): Promise<Record<string, unknown> | undefined> {
    const request = z.object({ jsonrpc: z.literal("2.0"), id: protocolId.optional(), method: z.string().max(120), params: z.unknown().optional() }).strict().safeParse(input);
    if (!request.success) return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } };
    const { id, method, params } = request.data;
    if (id === undefined) {
      if (method === "notifications/initialized" && initialized) ready = true;
      if (method === "notifications/cancelled") {
        const cancellation = z.object({ requestId: protocolId, reason: z.string().max(512).optional() }).strict().safeParse(params);
        const entry = cancellation.success && active.get(cancellation.data.requestId);
        if (entry) {
          entry.cancelled = true;
          // An HTTP disconnect does not cancel daemon work; send the explicit request separately.
          if (entry.saveId && options.backend) void abortable(options.backend.cancel(entry.saveId, deadline(10_000)), deadline(10_000)).catch(() => {});
          entry.controller.abort(new Error("MCP request cancelled; inspect the save UUID for its committed state"));
        }
      }
      return;
    }
    const result = (value: unknown) => ({ jsonrpc: "2.0", id, result: value });
    const error = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
    if (method === "ping") return result({});
    if (method === "initialize") {
      if (initialized) return error(-32600, "Session is already initialized");
      const init = z.object({ protocolVersion: z.string().max(100), capabilities: z.object({}).passthrough(), clientInfo: z.object({ name: z.string().min(1).max(120), version: z.string().min(1).max(100) }).passthrough() }).safeParse(params);
      if (!init.success) return error(-32602, "Invalid initialization parameters");
      initialized = true;
      client = { name: init.data.clientInfo.name, version: init.data.clientInfo.version, identityBasis: "declared" };
      return result({ protocolVersion: "2025-11-25", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "arena-block-private", version: "0.1.0" },
        instructions: options.backend ? "Private owner publishing is enabled. Preview and preserve the capsule, then save. Cancellation retains committed work. Status and replay use the original save UUID." : "Preparation only. Publishing requires explicit client and daemon opt-in." });
    }
    if (!ready) return error(-32000, "Initialize the session before calling tools");
    if (method === "tools/list") return result({ tools });
    if (method !== "tools/call") return error(-32601, "Method not found");
    const call = z.object({ name: z.string(), arguments: z.unknown().optional(), _meta: z.record(z.string(), z.unknown()).optional() }).strict().safeParse(params);
    if (!call.success) return error(-32602, "Invalid tool call parameters");
    if (!tools.some(tool => tool.name === call.data.name)) return error(-32602, "Unknown tool");
    if (active.has(id)) return error(-32600, "Request ID is already active");
    if (active.size >= 16 || active.size >= 8 && !["arena_block_cancel_save", "arena_block_save_status", "arena_block_policy", "read_arena_block_metadata"].includes(call.data.name)) return error(-32000, "Session has reached its active request limit; wait or cancel one");
    const entry = { controller: new AbortController(), saveId: undefined as string | undefined, cancelled: false };
    active.set(id, entry);
    try {
      let value: unknown;
      let humanText: string | undefined;
      const args = call.data.arguments ?? {};
      if (call.data.name === "arena_block_policy") {
        emptyInput.parse(args);
        value = { schemaVersion: 1, defaultChannel: config.defaultChannel ?? null,
          provenance: config.provenance, clients: config.clients, credentialProfile: profile.name, origin, publishingExposed: Boolean(options.backend), authenticatedAccountVerified: false };
      } else if (call.data.name === "arena_block_preview_save") {
        const preview = previewInput.parse(args);
        value = prepareSaveIntent(preview.plan, config, { origin, initiator: { kind: "agent", ...preview.agent },
          destinations: preview.destinations, saveId: preview.saveId, force: preview.force, operation: "publish", client, credentialProfile: profile.name });
      } else if (call.data.name === "read_arena_block_metadata") {
        const { block_url } = metadataInput.parse(args);
        const bounded = deadline(35_000, entry.controller.signal);
        value = await abortable(options.metadataReader!.blockMetadata(block_url, bounded), bounded);
        humanText = formatArenaBlockMetadata(value as Awaited<ReturnType<ArenaBlockClient["blockMetadata"]>>);
      } else {
        const bounded = deadline(options.callTimeoutMs ?? 160_000, entry.controller.signal);
        if (call.data.name === "arena_block_save") {
          const { intent } = saveInput.parse(args);
          entry.saveId = intent.snapshot.saveId;
          if (intent.snapshot.origin !== origin || intent.snapshot.authentication.credentialProfile !== profile.name) throw new Error("Save capsule transport/profile does not match this adapter");
          if (!intent.snapshot.fidelity.originalPlanPreserved) throw new Error("Review and prepare a credential-free source plan before saving through MCP");
          const mode = config.provenance.remoteSnapshot !== "none" && snapshotDefaultChannel(intent.snapshot)?.included ? config.provenance.remoteSnapshot : undefined;
          value = await abortable(options.backend!.save({ plan: intent.snapshot.plan, snapshot: intent.snapshot, snapshotSha256: intent.snapshotSha256, ...(mode ? { remoteMode: mode } : {}) }, bounded), bounded);
        } else {
          const { saveId } = idInput.parse(args);
          value = await abortable(call.data.name === "arena_block_save_status" ? options.backend!.status(saveId, deadline(10_000, bounded)) : options.backend!.cancel(saveId, deadline(10_000, bounded)), deadline(10_000, bounded));
        }
      }
      if (entry.cancelled) return;
      return result({ content: [{ type: "text", text: humanText ?? JSON.stringify(value) }], structuredContent: value, isError: false });
    } catch (failure) {
      if (entry.cancelled) return;
      const status = failure && typeof failure === "object" && "saveStatus" in failure ? saveStatusSchema.safeParse(failure.saveStatus).data : undefined;
      const message = failure instanceof z.ZodError ? "Invalid tool arguments or configuration" : entry.saveId ? "Save interrupted or rejected. Inspect its UUID; preserve the original capsule for recovery." : "Tool could not complete; inspect configuration and arguments.";
      const value = { error: message, ...(entry.saveId ? { saveId: entry.saveId } : {}), ...(status ? { status: redactProvenance(status).value } : {}) };
      return result({ content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value, isError: true });
    } finally { active.delete(id); }
  };
}

/** Concurrent newline stdio permits cancellation while a save is in flight. */
export async function runMcpStdio(config?: UserConfig, options: McpOptions = {}): Promise<void> {
  const dispatch = createMcpSession(config ?? await loadUserConfig(), "mcp-local", options);
  let pending = Buffer.alloc(0);
  const limit = 4 * 1024 * 1024;
  const running = new Set<Promise<void>>();
  const output = (response: Record<string, unknown> | undefined) => {
    if (!response) return;
    const serialized = JSON.stringify(response);
    if (Buffer.byteLength(serialized) > 4 * 1024 * 1024) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: response.id, error: { code: -32000, message: "Response exceeds 4 MiB" } }) + "\n"); return; }
    process.stdout.write(serialized + "\n");
  };
  for await (const chunk of process.stdin) {
    pending = Buffer.concat([pending, Buffer.from(chunk)]);
    let newline: number;
    while ((newline = pending.indexOf(10)) !== -1) {
      const line = pending.subarray(0, newline); pending = pending.subarray(newline + 1);
      if (line.length > limit) throw new Error("MCP request exceeds 4 MiB");
      if (!line.toString("utf8").trim()) continue;
      try {
        const request = JSON.parse(line.toString("utf8"));
        if (request?.id === undefined) { void dispatch(request).then(output); continue; }
        // Bound queued work without delaying notifications behind a save.
        if (running.size >= 16 && request?.id !== undefined) { output({ jsonrpc: "2.0", id: protocolId.safeParse(request.id).data ?? null, error: { code: -32000, message: "Too many queued requests" } }); continue; }
        const task = dispatch(request).then(output).finally(() => running.delete(task));
        running.add(task);
      } catch { output({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
    }
    if (pending.length > limit) throw new Error("MCP request exceeds 4 MiB");
  }
  if (pending.length) output({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Unterminated JSON-RPC message" } });
  await Promise.all(running);
}
