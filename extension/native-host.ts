import { requiredCompositionCapabilities, requireRetainedCompositionPolicy } from "../packages/core/composition-capabilities.ts";
import { requireRetainedSubstackCaptures } from "../packages/core/substack-record.ts";
import { requiredSubstackResolutionCapabilities, requireSubstackPublicResult } from "../packages/core/substack-input-capabilities.ts";
import { requireRetainedRedditCaptures } from "../packages/core/reddit-record.ts";
/** Optional native messaging transport. The bearer token stays in this process. */
import { readSync, writeSync } from "node:fs";
import { z } from "zod";
import { blockPlanSchema, planInputSchema } from "../packages/core/types.ts";
import { loadUserConfig } from "../src/config.ts";
import { requiredPlanCapabilities } from "../src/plan-capabilities.ts";
import { requireAddressableQuoteMedia } from "../packages/core/media-tree.ts";
import { prepareSaveIntent } from "../src/save-intent.ts";
import { buildInfoSchema } from "../src/version.ts";

const hostRequestSchema = z.discriminatedUnion("action", [
  z.object({ id: z.string().max(100), action: z.literal("ping") }).strict(),
  z.object({ id: z.string().max(100), action: z.literal("resolve"), input: planInputSchema }).strict(),
  z.object({ id: z.string().max(100), action: z.literal("channels"), page: z.number().int().min(1).max(100) }).strict(),
  z.object({ id: z.string().max(100), action: z.literal("channelSearch"), query: z.string().max(256), scope: z.enum(["following", "all"]), page: z.number().int().min(1).max(100) }).strict(),
  z.object({ id: z.string().max(100), action: z.literal("save"), saveId: z.uuid(), plan: blockPlanSchema,
    destinations: z.array(z.string().min(1).max(2048)).min(1).max(20) }).strict(),
  z.object({ id: z.string().max(100), action: z.literal("status"), saveId: z.uuid() }).strict(),
  z.object({ id: z.string().max(100), action: z.literal("retry"), saveId: z.uuid() }).strict(),
  z.object({ id: z.string().max(100), action: z.literal("cancel"), saveId: z.uuid() }).strict(),
]);
type HostRequest = z.infer<typeof hostRequestSchema>;

function readBytes(length: number): Buffer | undefined {
  const output = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const count = readSync(0, output, offset, length - offset, null);
    if (count === 0) return offset === 0 ? undefined : (() => { throw new Error("Truncated native message"); })();
    offset += count;
  }
  return output;
}

export const NATIVE_REPLY_MAX_BYTES = 1024 * 1024;
export function nativeReplyBody(value: { id?: unknown; [key: string]: unknown }): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length <= NATIVE_REPLY_MAX_BYTES) return body;
  return Buffer.from(JSON.stringify({ id: typeof value.id === "string" ? value.id.slice(0, 100) : undefined,
    ok: false, error: "The local helper response exceeds the browser's 1 MiB limit. Keep this draft and use browser preview/export, or open the record in the CLI or native Capture." }), "utf8");
}
function reply(value: { id?: unknown; [key: string]: unknown }): void {
  const body = nativeReplyBody(value);
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  writeSync(1, header);
  writeSync(1, body);
}

function endpoint(): URL {
  const url = new URL(process.env.ARENA_BLOCK_ENDPOINT ?? "http://127.0.0.1:8790");
  if (!(url.protocol === "https:" || url.protocol === "http:"
      && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Native host requires HTTPS or a loopback arena-block endpoint");
  }
  return url;
}

async function daemon(path: string, method = "GET", body?: unknown, fetcher: typeof fetch = fetch): Promise<unknown> {
  const token = process.env.ARENA_BLOCK_ACCESS_TOKEN;
  if (!token) throw new Error("Arena Block daemon credential is unavailable");
  const response = await fetcher(new URL(path, endpoint()), { method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new Error(`Arena Block daemon returned HTTP ${response.status}`);
  }
  const data = await response.json();
  return data;
}

export async function handle(request: HostRequest, fetcher: typeof fetch = fetch): Promise<unknown> {
  switch (request.action) {
    case "ping": return daemon("/v1/version", "GET", undefined, fetcher);
    case "resolve": {
      const required = [...requiredCompositionCapabilities(request.input), ...requiredSubstackResolutionCapabilities(request.input)];
      if (request.input.redditCaptures?.length || required.length) {
        const serving = buildInfoSchema.parse(await daemon("/v1/version", "GET", undefined, fetcher));
        const missing=required.filter(capability=>!serving.planCapabilities?.includes(capability));
        if(missing.length)throw new Error("Update the local helper and receiver to read this source.", { cause: { missingCapabilities: missing } });
        if (request.input.redditCaptures?.some(c => c.schema === "arena-block/reddit-public-page-capture") && !serving.planCapabilities?.includes("reddit-public-page-records-v1")) throw new Error("The daemon cannot retain Reddit public page records. No source read was submitted.");
        if (request.input.redditCaptures?.length && !serving.planCapabilities?.includes("reddit-browser-records-v1")) throw new Error("The daemon cannot receive Reddit browser records. Install a matching receiver; no source read was submitted.");
      }
      const plan = blockPlanSchema.parse(await daemon("/v1/plans", "POST", request.input, fetcher));
      requireRetainedCompositionPolicy(request.input, plan);
      requireSubstackPublicResult(request.input, plan);
      requireAddressableQuoteMedia(plan);
      requireRetainedRedditCaptures(plan, request.input.redditCaptures ?? []);
      requireRetainedSubstackCaptures(plan, request.input.substackCaptures ?? []);
      return plan;
    }
    case "channels": return daemon(`/v1/channels?page=${request.page}`, "GET", undefined, fetcher);
    case "channelSearch": return daemon(`/v1/channel-search?scope=${request.scope}&query=${encodeURIComponent(request.query)}&page=${request.page}`, "GET", undefined, fetcher);
    case "status": return daemon(`/v1/saves/${request.saveId}`, "GET", undefined, fetcher);
    case "retry": return daemon(`/v1/saves/${request.saveId}/retry?async=1`, "POST", {}, fetcher);
    case "cancel": return daemon(`/v1/saves/${request.saveId}/cancel`, "POST", {}, fetcher);
    case "save": {
      const required = requiredPlanCapabilities(request.plan);
      if (required.length) {
        const serving = buildInfoSchema.parse(await daemon("/v1/version", "GET", undefined, fetcher));
        const missing = required.filter(capability => !serving.planCapabilities?.includes(capability));
        if (missing.length) throw new Error("Update the local helper and receiver to save this capture.", { cause: { missingCapabilities: missing } });
      }
      const config = await loadUserConfig();
      const intent = prepareSaveIntent(request.plan, config, { origin: "cli", operation: "publish",
        initiator: { kind: "human", label: "Arena Block browser extension" }, saveId: request.saveId,
        destinations: request.destinations, inputDestinationArgs: request.destinations,
        client: { name: "arena-block-extension", version: "0.1.0", identityBasis: "declared" } });
      return daemon("/v1/saves?async=1", "POST", { plan: request.plan, snapshot: intent.snapshot,
        snapshotSha256: intent.snapshotSha256,
        ...(intent.remoteMetadata ? { remoteMode: intent.remoteMetadata.ab_snapshot_complete === true ? "full" : "summary" } : {}) }, fetcher);
    }
  }
}

if (import.meta.main) {
  while (true) {
    const header = readBytes(4);
    if (!header) break;
    const length = header.readUInt32LE(0);
    if (length > 4 * 1024 * 1024) throw new Error("Native message exceeds 4 MiB");
    const body = readBytes(length);
    if (!body) throw new Error("Truncated native message");
    let id: unknown;
    try {
      const request = hostRequestSchema.parse(JSON.parse(body.toString("utf8")));
      id = request.id;
      reply({ id, ok: true, value: await handle(request) });
    } catch (error) {
      reply({ id, ok: false, error: error instanceof Error ? error.message : "Native host error" });
    }
  }
}
