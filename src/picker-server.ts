import { randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { ArenaBlockClient } from "./client.ts";
import { blockPlanSchema, type BlockPlan } from "./types.ts";
import { captureSource } from "./capture.ts";
import { prepareSaveIntent, type SaveIntent } from "./save-intent.ts";
import { normalizeChannels, type UserConfig } from "./config.ts";
import { pickerHtml, pickerJs, pickerCss } from "./picker-ui.ts";

const planInput = z.object({ url: z.string().min(1).max(8192), media: z.enum(["auto", "all", "none"]),
  title: z.string().trim().min(1).max(512).optional(), description: z.string().max(20_000).optional() }).strict();
const saveInput = z.object({ plan: blockPlanSchema, destinations: z.array(z.string()).min(1).max(20), saveId: z.uuid() }).strict();
const placementInput = z.object({ blockId: z.number().int().positive().safe(), destinations: z.array(z.number().int().positive().safe()).min(1).max(20), placementId: z.uuid() }).strict();

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" } });
}

function sameSecret(input: string | null, secret: string): boolean {
  const left = Buffer.from(input ?? "");
  const right = Buffer.from(secret);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Local presentation adapter. The daemon retains all publication and recovery state. */
export function createPickerApp(config: UserConfig, daemon: ArenaBlockClient, secret = randomBytes(32).toString("hex")) {
  const intents = new Map<string, { hash: string; destinations: string[]; intent: SaveIntent }>();
  const uiConfig: UserConfig = { ...config, defaultChannel: undefined,
    provenance: { ...config.provenance, remoteSnapshot: "none" } };
  const headers = { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" };

  async function handler(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname !== "127.0.0.1" || request.headers.get("host") !== url.host) return response({ error: "Local host required" }, 403);
    const origin = request.headers.get("origin");
    if (origin && origin !== url.origin) return response({ error: "Local origin required" }, 403);
    if (request.method === "GET" && url.pathname === "/") return new Response(pickerHtml, { headers: { ...headers, "content-type": "text/html; charset=utf-8" } });
    if (request.method === "GET" && url.pathname === "/picker.js") return new Response(pickerJs, { headers: { ...headers, "content-type": "text/javascript; charset=utf-8" } });
    if (request.method === "GET" && url.pathname === "/picker.css") return new Response(pickerCss, { headers: { ...headers, "content-type": "text/css; charset=utf-8" } });
    if (!url.pathname.startsWith("/api/") || !sameSecret(request.headers.get("x-arena-block-picker"), secret)) return response({ error: "Not found" }, 404);
    if (request.method !== "GET" && (!origin || origin !== url.origin)) return response({ error: "Local origin required" }, 403);
    try {
      if (request.method === "GET" && url.pathname === "/api/channels") {
        const page = url.searchParams.get("page") ?? "1";
        if (!/^[1-9][0-9]{0,2}$/.test(page) || Number(page) > 100) return response({ error: "Invalid page" }, 400);
        return response(await daemon.channels(Number(page), request.signal));
      }
      if (request.method === "GET" && url.pathname === "/api/channel-index") return response(await daemon.channelIndex(request.signal));
      if (request.method === "GET" && url.pathname === "/api/channel-search") {
        const scope = url.searchParams.get("scope"), query = url.searchParams.get("query") ?? "", page = url.searchParams.get("page") ?? "1";
        if ((scope !== "following" && scope !== "all") || query.length > 256 || !/^[1-9][0-9]{0,2}$/.test(page) || Number(page) > 100) return response({ error: "Invalid channel search" }, 400);
        return response(await daemon.channelSearch(query, scope, Number(page), request.signal));
      }
      if (request.method === "GET" && url.pathname === "/api/existing-block") {
        const source = url.searchParams.get("url") ?? "";
        const match = source.match(/^https:\/\/(?:www\.)?are\.na\/block\/([1-9][0-9]{0,15})(?:[/?#].*)?$/i);
        if (!match) return response({ error: "Enter an Are.na block URL" }, 400);
        return response(await daemon.existingBlock(Number(match[1]), request.signal));
      }
      if (request.method === "POST" && url.pathname === "/api/place") {
        const input = placementInput.parse(await request.json());
        await daemon.assertSaveProfile(config, "cli");
        return response(await daemon.existingPlacement({ id: input.placementId, blockId: input.blockId, destinations: input.destinations }));
      }
      const placementMatch = url.pathname.match(/^\/api\/placements\/([a-f0-9-]{36})(?:\/(retry|cancel))?$/);
      if (placementMatch) {
        const id = z.uuid().parse(placementMatch[1]);
        if (request.method === "GET" && !placementMatch[2]) return response(await daemon.existingPlacementStatus(id));
        if (request.method === "POST" && placementMatch[2] === "retry") return response(await daemon.retryExistingPlacement(id));
        if (request.method === "POST" && placementMatch[2] === "cancel") return response(await daemon.cancelExistingPlacement(id));
      }
      if (request.method === "POST" && url.pathname === "/api/plan") {
        const input = planInput.parse(await request.json());
        const source = captureSource(input.url);
        if (source.kind === "social" && (input.title || input.description)) throw new Error("Source title and description come from the resolved post");
        const plan = source.kind === "social" ? await daemon.plan([source.url], { media: input.media }, request.signal)
          : await daemon.webPlan(source.url, input.title, input.description, request.signal);
        return response({ plan });
      }
      if (request.method === "POST" && url.pathname === "/api/save") {
        const input = saveInput.parse(await request.json());
        const destinations = normalizeChannels(input.destinations);
        await daemon.assertSaveProfile(config, "cli");
        const old = intents.get(input.saveId);
        if (old && (old.hash !== input.plan.hash || JSON.stringify(old.destinations) !== JSON.stringify(destinations))) {
          return response({ error: "This save ID already belongs to a different plan or selection" }, 409);
        }
        const intent = old?.intent ?? prepareSaveIntent(input.plan, uiConfig, {
          origin: "cli", initiator: { kind: "human", label: "desktop picker" },
          operation: "publish", destinations, inputSourceRefs: input.plan.sources.map(source => source.canonicalUrl),
          inputDestinationArgs: destinations, saveId: input.saveId,
        });
        if (!old) intents.set(input.saveId, { hash: input.plan.hash, destinations, intent });
        // A lost HTTP response must not generate a second intent or a new block.
        try { return response(await daemon.saveStatus(input.saveId)); }
        catch (error) {
          if (!(error instanceof Error) || !/Save not found in this journal/.test(error.message)) throw error;
          return response(await daemon.beginCliSave({ plan: input.plan, snapshot: intent.snapshot, snapshotSha256: intent.snapshotSha256 }));
        }
      }
      const match = url.pathname.match(/^\/api\/saves\/([a-f0-9-]{36})(?:\/(retry|cancel))?$/);
      if (match) {
        const id = z.uuid().parse(match[1]);
        if (request.method === "GET" && !match[2]) return response(await daemon.saveStatus(id));
        if (request.method === "POST" && match[2] === "cancel") return response(await daemon.cancelSave(id));
        if (request.method === "POST" && match[2] === "retry") {
          return response(await daemon.beginCliRetry(id));
        }
      }
      return response({ error: "Not found" }, 404);
    } catch (error) {
      const value = error as Error & { saveStatus?: unknown };
      return response({ error: value.message ?? "Request failed", ...(value.saveStatus ? { saveStatus: value.saveStatus } : {}) }, 422);
    }
  }
  return { handler, secret };
}
