import { join } from "node:path";
import { z } from "zod";
import { openSync, readSync, closeSync } from "node:fs";
import { composePlan } from "./compose.ts";
import { ArenaClient, ArenaPublisher } from "./arena.ts";
import { SocialResolver } from "./providers/index.ts";
import { renderPlan } from "./render.ts";
import { ArenaBlockStore } from "./store.ts";
import { buildInfo } from "./version.ts";
import { readArenaBlockMetadata } from "./metadata.ts";
import { mediaResponse } from "./media-response.ts";
import { captureInputSchema, captureSource, publicationFields, publicationPayload, webPlan, webPlanInputSchema } from "./capture.ts";
import { remoteProvenancePolicySchema, type RemoteProvenancePolicy } from "./remote-save.ts";
import { daemonCredentialSchema, type DaemonCredential } from "./config.ts";
import { SaveGateway, saveSubmissionSchema, saveStatusSchema } from "./save-gateway.ts";
import { ChannelIndex, channelRecordSchema, type ChannelRecord } from "./channel-index.ts";
import { ExistingBlockPlacer } from "./existing-placement.ts";
import { boundedJson, deadline } from "./bounded-io.ts";
import {
  blockPlanSchema,
  planInputSchema,
  publicationReceiptSchema,
  publishRequestSchema,
  resumePublicationSchema,
} from "./types.ts";

export type ServiceConfig = {
  host: string;
  port: number;
  publicBaseUrl: string;
  stateDirectory: string;
  mediaDirectory: string;
  accessToken: string;
  arenaToken: string;
  arenaApiBase?: string;
  remoteProvenance?: RemoteProvenancePolicy;
  credential?: DaemonCredential;
  mcpPublishingEnabled?: boolean;
};

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function pickerChannels(entries: unknown): ChannelRecord[] {
  if (!Array.isArray(entries) || entries.length > 30) throw new Error("Are.na returned an invalid channel page");
  return entries.flatMap((entry: any) => {
    const id = entry?.id, owner = entry?.owner, counts = entry?.counts, can = entry?.can;
    const value = { id, title: entry?.title, slug: entry?.slug,
      visibility: entry?.visibility === "private" ? "private" : entry?.visibility === "closed" ? "closed" : "public",
      owner: { name: owner?.name, slug: owner?.slug },
      ...(Number.isSafeInteger(counts?.contents) && counts.contents >= 0 ? { count: counts.contents } : {}),
      ...(typeof can?.add_to === "boolean" ? { canAdd: can.add_to } : {}) };
    const parsed = channelRecordSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
}

function nextChannelPage(meta: unknown, page: number): number | null {
  const value = meta && typeof meta === "object" && !Array.isArray(meta) ? meta as Record<string, unknown> : {};
  if (Number.isSafeInteger(value.next_page) && (value.next_page as number) > page && (value.next_page as number) <= 100) return value.next_page as number;
  return value.has_more_pages === true && page < 100 ? page + 1 : null;
}

class AccountMismatchError extends Error {}

const existingPlacementInput = z.object({ id: z.uuid(), blockId: z.number().int().positive().safe(),
  destinations: z.array(z.number().int().positive().safe()).min(1).max(20) }).strict()
  .refine(value => new Set(value.destinations).size === value.destinations.length, "Duplicate destination");

function errorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  const receipt = error && typeof error === "object" && "receipt" in error
    ? publicationReceiptSchema.safeParse((error as { receipt: unknown }).receipt).data
    : undefined;
  const attempt = error && typeof error === "object" && "attempt" in error ? error.attempt : undefined;
  const saveStatus = error && typeof error === "object" && "saveStatus" in error ? saveStatusSchema.safeParse(error.saveStatus).data : undefined;
  return json({ error: message, ...(receipt ? { receipt } : {}), ...(attempt ? { attempt } : {}), ...(saveStatus ? { saveStatus } : {}) }, 422);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}

function readPrivateConfig(path: string): unknown {
  const file = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(16_385); let length = 0;
    while (length < buffer.length) { const count = readSync(file, buffer, length, buffer.length - length, null); if (!count) break; length += count; }
    if (length > 16_384) throw new Error("Daemon configuration exceeds 16 KiB");
    return JSON.parse(buffer.subarray(0, length).toString("utf8"));
  } finally { closeSync(file); }
}

export function loadServiceConfig(environment = process.env): ServiceConfig {
  const stateDirectory = environment.ARENA_BLOCK_STATE_DIR ?? `${environment.HOME}/.local/share/arena-block`;
  const accessToken = environment.ARENA_BLOCK_ACCESS_TOKEN;
  const credential = environment.ARENA_BLOCK_CREDENTIAL_CONFIG ? daemonCredentialSchema.parse(readPrivateConfig(environment.ARENA_BLOCK_CREDENTIAL_CONFIG)) : undefined;
  const arenaToken = environment[credential?.arenaTokenEnv ?? "ARENA_WRITE_ACCESS_TOKEN"];
  if (!accessToken) throw new Error("ARENA_BLOCK_ACCESS_TOKEN is required");
  if (!arenaToken) throw new Error("The explicitly selected Are.na credential environment reference is unavailable; no fallback credential was selected");
  let remoteProvenance: RemoteProvenancePolicy | undefined;
  if (environment.ARENA_BLOCK_PROVENANCE_POLICY) {
    remoteProvenance = remoteProvenancePolicySchema.parse(readPrivateConfig(environment.ARENA_BLOCK_PROVENANCE_POLICY));
  }
  if (remoteProvenance && (remoteProvenance.credentialProfile !== (credential?.profile ?? "shared") || credential && credential.expectedAccountId !== remoteProvenance.expectedAccountId)) throw new Error("Provenance policy and selected daemon account/profile disagree");
  if (environment.ARENA_BLOCK_MCP_PUBLISHING && !["0", "1"].includes(environment.ARENA_BLOCK_MCP_PUBLISHING)) throw new Error("ARENA_BLOCK_MCP_PUBLISHING must be 0 or 1");
  return {
    host: environment.ARENA_BLOCK_HOST ?? "127.0.0.1",
    port: Number(environment.ARENA_BLOCK_PORT ?? 8790),
    publicBaseUrl: (environment.ARENA_BLOCK_PUBLIC_BASE_URL ?? "http://127.0.0.1:8790").replace(/\/$/, ""),
    stateDirectory,
    mediaDirectory: environment.ARENA_BLOCK_MEDIA_DIR ?? join(stateDirectory, "media"),
    accessToken,
    arenaToken,
    ...(credential ? { credential } : {}),
    mcpPublishingEnabled: environment.ARENA_BLOCK_MCP_PUBLISHING === "1",
    ...(remoteProvenance ? { remoteProvenance } : {}),
    ...(environment.ARENA_BLOCK_ARENA_API_BASE ? { arenaApiBase: environment.ARENA_BLOCK_ARENA_API_BASE } : {}),
  };
}

export function createService(config: ServiceConfig, dependencies: { client?: ArenaClient; render?: typeof renderPlan } = {}) {
  if (config.remoteProvenance && (config.remoteProvenance.credentialProfile !== (config.credential?.profile ?? "shared") || config.credential && config.credential.expectedAccountId !== config.remoteProvenance.expectedAccountId)) throw new Error("Provenance policy and selected daemon account/profile disagree");
  const version = buildInfo();
  const store = new ArenaBlockStore(join(config.stateDirectory, "arena-block.sqlite"), { private: Boolean(config.remoteProvenance) });
  const resolver = new SocialResolver();
  const client = dependencies.client ?? new ArenaClient(config.arenaToken, config.arenaApiBase);
  const publisher = new ArenaPublisher(client, store, {
    publicBaseUrl: config.publicBaseUrl,
    mediaDirectory: config.mediaDirectory,
    remoteProvenance: config.remoteProvenance,
    ...(dependencies.render ? { render: dependencies.render } : {}),
  });
  const saves = new SaveGateway(client, publisher, store, { profile: config.credential?.profile ?? "shared", expectedAccountId: config.credential?.expectedAccountId ?? config.remoteProvenance?.expectedAccountId }, config.remoteProvenance);
  const channelIndex = new ChannelIndex(config.stateDirectory);
  const existingPlacer = new ExistingBlockPlacer(client, store);
  let accountCache: { id: number; expiresAt: number } | undefined;
  const pickerAccount = async (signal: AbortSignal): Promise<number> => {
    if (accountCache && Date.now() < accountCache.expiresAt) return accountCache.id;
    const account = await client.me(signal);
    const id = account.id;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1
      || config.credential?.expectedAccountId && id !== config.credential.expectedAccountId) throw new AccountMismatchError("Authenticated Are.na account does not match this service");
    accountCache = { id, expiresAt: Date.now() + 60_000 };
    return id;
  };
  const authorizeLegacy = async (receiptId: string | undefined, planHash: string | undefined, operationId: string | undefined, force: boolean, signal: AbortSignal) => {
    if (config.credential) throw new Error("Explicit credential profiles require the journaled save endpoint");
    const scope = store.saveAccountScope();
    if (!scope) return; // Existing unbound defaults keep their established behavior.
    const me = await client.me(signal);
    if (scope.profile !== "shared" || me.id !== scope.accountId) throw new Error("Authenticated account does not match this journal's original shared account");
    const receipt = receiptId ? store.receipt(receiptId) : operationId && store.operationState(operationId)?.receipt || (!force && planHash ? store.latestReceiptForPlan(planHash) : undefined);
    if (receipt && ((await client.block(receipt.blockId, signal)).user as { id?: unknown } | undefined)?.id !== scope.accountId) throw new Error("Legacy receipt ownership does not match this journal's authenticated account");
  };

  const handler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") return json({ status: "ok" });
    if (request.method === "GET" && url.pathname === "/readyz") return json({ status: "ready" });
    if (request.method === "GET" && url.pathname.startsWith("/ingest-native/")) {
      try {
        const encoded = url.pathname.slice("/ingest-native/".length);
        if (!/^[A-Za-z0-9_-]{1,16384}$/.test(encoded)) return new Response("Invalid capture link", { status: 400 });
        const input = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
        if (!input || typeof input !== "object" || typeof input.source !== "string" || typeof input.cover !== "string" || (input.title !== undefined && typeof input.title !== "string")) return new Response("Invalid capture link", { status: 400 });
        const source = input.source;
        const cover = input.cover;
        const title = input.title ?? "";
        const target = new URL(source);
        const image = new URL(cover);
        if (source.length > 8192 || cover.length > 2048 || title.length > 512
          || target.protocol !== "https:" || target.username || target.password
          || image.protocol !== "https:" || image.hostname !== "s3.amazonaws.com" || image.port
          || image.pathname === "/arena_images-temp/"
          || !image.pathname.startsWith("/arena_images-temp/") || image.username || image.password) {
          return new Response("Invalid capture link", { status: 400 });
        }
        const redirect = JSON.stringify(source).replace(/</g, "\\u003c");
        const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><meta property="og:title" content="${escapeHtml(title)}"><meta property="og:image" content="${escapeHtml(cover)}"><link rel="canonical" href="${escapeHtml(source)}"></head><body><p><a href="${escapeHtml(source)}">${escapeHtml(title || "Open original source")}</a></p><script>location.replace(${redirect})</script></body></html>`;
        return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" } });
      } catch { return new Response("Invalid capture link", { status: 400 }); }
    }
    const mediaMatch = url.pathname.match(/^\/media\/([a-f0-9]{64})\.(jpg|mp4|mp3|m4a|wav|flac|ogg|opus|aac)$/);
    if (["GET", "HEAD"].includes(request.method) && mediaMatch) {
      const file = Bun.file(join(config.mediaDirectory, mediaMatch[1]!.slice(0, 2), `${mediaMatch[1]}.${mediaMatch[2]}`));
      if (!await file.exists()) return new Response("Not found", { status: 404 });
      const mimeType: Record<string, string> = { jpg: "image/jpeg", mp4: "video/mp4", mp3: "audio/mpeg", m4a: "audio/mp4",
        wav: "audio/wav", flac: "audio/flac", ogg: "audio/ogg", opus: "audio/ogg", aac: "audio/aac" };
      return mediaResponse(request, file, mimeType[mediaMatch[2]!]!);
    }
    const ingestMatch = url.pathname.match(/^\/ingest\/([a-f0-9]{64})$/);
    if (request.method === "GET" && ingestMatch) {
      const stored = store.plan(ingestMatch[1]!);
      if (!stored) return new Response("Not found", { status: 404 });
      const plan = stored.plan;
      const title = escapeHtml(plan.block.title);
      const description = escapeHtml(plan.block.markdown);
      const source = escapeHtml(plan.block.canonicalSource);
      const cover = stored.arenaCoverUrl ? escapeHtml(stored.arenaCoverUrl) : "";
      const html = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><meta property="og:title" content="${title}"><meta property="og:description" content="${description}">${cover ? `<meta property="og:image" content="${cover}">` : ""}<link rel="canonical" href="${source}"></head><body><p><a href="${source}">${title}</a></p><script>location.replace(${JSON.stringify(plan.block.canonicalSource)})</script></body></html>`;
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" } });
    }
    if (!url.pathname.startsWith("/v1/")) return new Response("Not found", { status: 404 });
    if (request.headers.get("authorization") !== `Bearer ${config.accessToken}`) return json({ error: "Unauthorized" }, 401);
    try {
      const blockMetadataMatch = url.pathname.match(/^\/v1\/blocks\/(\d+)\/metadata$/);
      if (request.method === "GET" && blockMetadataMatch) {
        const blockId = Number(blockMetadataMatch[1]);
        if (!Number.isSafeInteger(blockId) || blockId < 1) return json({ error: "Invalid Are.na block ID" }, 400);
        return json(await readArenaBlockMetadata(client, `https://www.are.na/block/${blockId}`, deadline(30_000, request.signal)));
      }
      if (request.method === "GET" && url.pathname === "/v1/version") return json(version);
      if (request.method === "GET" && url.pathname === "/v1/save-policy") return json({
        credential: { profile: config.credential?.profile ?? "shared", arenaTokenEnv: config.credential?.arenaTokenEnv ?? "ARENA_WRITE_ACCESS_TOKEN", ...(config.credential?.expectedAccountId ?? config.remoteProvenance?.expectedAccountId ? { expectedAccountId: config.credential?.expectedAccountId ?? config.remoteProvenance?.expectedAccountId } : {}) },
        mcpPublishingEnabled: Boolean(config.mcpPublishingEnabled),
      });
      if (request.method === "GET" && url.pathname === "/v1/channel-index") {
        return json(channelIndex.read(await pickerAccount(request.signal)));
      }
      if (request.method === "GET" && url.pathname === "/v1/channel-labels") {
        const refs = url.searchParams.getAll("ref");
        if (!refs.length || refs.length > 20 || refs.some(ref => !/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(ref)))
          return json({ error: "Invalid channel label refs" }, 400);
        await pickerAccount(request.signal);
        const labels = await Promise.all([...new Set(refs)].map(async ref => {
          const channel = await client.channel(ref, request.signal);
          if (!Number.isSafeInteger(channel.id) || (channel.id as number) < 1 || typeof channel.title !== "string" || typeof channel.slug !== "string")
            throw new Error("Are.na returned invalid channel labels");
          return { ref, id: channel.id, title: channel.title, slug: channel.slug };
        }));
        return json(labels);
      }
      const existingBlockMatch = url.pathname.match(/^\/v1\/existing-blocks\/([1-9][0-9]{0,15})$/);
      if (request.method === "GET" && existingBlockMatch) {
        await pickerAccount(request.signal);
        return json(await existingPlacer.preview(Number(existingBlockMatch[1]), request.signal));
      }
      if (request.method === "POST" && url.pathname === "/v1/existing-placements") {
        const input = existingPlacementInput.parse(await boundedJson(request, 4096, deadline(10_000, request.signal)));
        const accountId = await pickerAccount(request.signal);
        store.bindSaveAccount(config.credential?.profile ?? "shared", accountId);
        const block = await existingPlacer.preview(input.blockId, request.signal);
        if (block.state !== "available") return json({ error: "Existing block is not available for placement" }, 422);
        return json(await existingPlacer.place({ ...input, accountId }));
      }
      const existingPlacementMatch = url.pathname.match(/^\/v1\/existing-placements\/([a-f0-9-]{36})(?:\/(retry|cancel))?$/);
      if (existingPlacementMatch) {
        const id = z.uuid().parse(existingPlacementMatch[1]);
        const accountId = await pickerAccount(request.signal);
        if (request.method === "GET" && !existingPlacementMatch[2]) return json(existingPlacer.status(id, accountId));
        if (request.method === "POST" && existingPlacementMatch[2] === "cancel") return json(existingPlacer.cancel(id, accountId));
        if (request.method === "POST" && existingPlacementMatch[2] === "retry") {
          return json(await existingPlacer.retry(id, accountId));
        }
      }
      if (request.method === "GET" && url.pathname === "/v1/channel-search") {
        const scope = url.searchParams.get("scope"), query = url.searchParams.get("query") ?? "";
        const rawPage = url.searchParams.get("page") ?? "1";
        if ((scope !== "following" && scope !== "all") || query.length > 256 || !/^[1-9][0-9]{0,2}$/.test(rawPage) || Number(rawPage) > 100) return json({ error: "Invalid channel search" }, 400);
        const accountId = await pickerAccount(request.signal);
        const page = Number(rawPage);
        const response = await client.searchChannels(query, scope, page, request.signal);
        return json({ accountId, channels: pickerChannels(response.data), nextPage: nextChannelPage(response.meta, page) });
      }
      if (request.method === "GET" && url.pathname === "/v1/channels") {
        const rawPage = url.searchParams.get("page") ?? "1";
        if (!/^[1-9][0-9]{0,2}$/.test(rawPage) || Number(rawPage) > 100) return json({ error: "Invalid channel page" }, 400);
        const accountId = await pickerAccount(request.signal);
        const page = Number(rawPage);
        const response = await client.ownedChannels(accountId, page, request.signal);
        const channels = pickerChannels(response.data);
        const nextPage = nextChannelPage(response.meta, page);
        channelIndex.recordPage(accountId, page, channels, nextPage);
        return json({ accountId, channels, nextPage });
      }
      const saveRoot = url.pathname.startsWith("/v1/mcp-saves") ? "/v1/mcp-saves" : "/v1/saves";
      if (url.pathname === saveRoot || url.pathname.startsWith(`${saveRoot}/`)) {
        if (saveRoot === "/v1/mcp-saves" && !config.mcpPublishingEnabled) return json({ error: "MCP publishing is disabled on this daemon" }, 403);
        if (request.method === "POST" && url.pathname === saveRoot) {
          const input = saveSubmissionSchema.parse(await boundedJson(request, 4 * 1024 * 1024, deadline(10_000, request.signal)));
          // Cancel retained saves through the explicit cancel endpoint.
          if (url.searchParams.get("async") === "1" && saveRoot === "/v1/saves") {
            const pending = saves.save(input, "cli");
            let rejected = false, failure: unknown;
            void pending.catch(error => { rejected = true; failure = error; });
            // Check synchronous save validation before reading this UUID's status.
            await Promise.resolve();
            if (rejected) throw failure;
            return json(saves.status(input.snapshot.saveId), 202);
          }
          return json(await saves.save(input, saveRoot === "/v1/saves" ? "cli" : "mcp-local"));
        }
        const suffix = url.pathname.slice(saveRoot.length + 1), parts = suffix.split("/");
        if (parts.length === 1 && request.method === "GET") return json(saves.status(parts[0]!));
        if (parts.length === 2 && parts[1] === "intent" && request.method === "GET") return json(saves.intent(parts[0]!));
        if (parts.length === 2 && parts[1] === "retry" && request.method === "POST") {
          z.object({}).strict().parse(await boundedJson(request, 1024, deadline(10_000, request.signal)));
          const origin = saves.intent(parts[0]!).snapshot.origin;
          if (origin === "mcp-remote" || origin === "mcp-local" && !config.mcpPublishingEnabled) return json({ error: "The original save's MCP publishing adapter is disabled" }, 403);
          if (saveRoot === "/v1/mcp-saves" && origin !== "mcp-local") return json({ error: "MCP recovery cannot impersonate another original transport" }, 422);
          if (url.searchParams.get("async") === "1" && saveRoot === "/v1/saves") {
            const pending = saves.replay(parts[0]!);
            let rejected = false, failure: unknown;
            void pending.catch(error => { rejected = true; failure = error; });
            await Promise.resolve();
            if (rejected) throw failure;
            return json(saves.status(parts[0]!), 202);
          }
          return json(await saves.replay(parts[0]!));
        }
        if (parts.length === 2 && parts[1] === "cancel" && request.method === "POST") {
          z.object({}).strict().parse(await boundedJson(request, 1024, deadline(10_000, request.signal)));
          return json(saves.cancel(parts[0]!));
        }
      }
      if (request.method === "POST" && url.pathname === "/v1/capture/preview") {
        const input = captureInputSchema.parse(await request.json());
        const refs = input.refs ?? [input.url!];
        const source = captureSource(refs[0]!);
        if (source.kind === "url") {
          if (input.extraRefs.length || refs.length > 1) throw new Error("Additional posts require supported social sources");
          return json({ kind: "url", url: source.url });
        }
        const resolved = await resolver.resolveComposition(refs, input.extraRefs, input.policy ?? { media: input.media, ...(input.threadExpansion ? { threadExpansion: input.threadExpansion } : {}) }, request.signal);
        const plan = composePlan(resolved.posts, resolved.policy);
        store.savePlan(plan);
        return json({ kind: "social", url: source.url, plan });
      }
      if (request.method === "POST" && url.pathname === "/v1/capture/prepare") {
        const plan = blockPlanSchema.parse(await request.json());
        store.savePlan(plan);
        const media = await renderPlan(plan, config.mediaDirectory);
        const { channel_ids: _, ...payload } = publicationPayload(plan, config.publicBaseUrl, media, []);
        return json({ payload, update: publicationFields(plan) });
      }
      if (request.method === "POST" && url.pathname === "/v1/resolve") {
        const input = planInputSchema.parse(await request.json());
        if (input.refresh) resolver.clearSourceCache();
        const resolved = await resolver.resolveComposition(input.refs, input.extraRefs, input.policy, request.signal);
        return json({ schemaVersion: 1, posts: resolved.posts, policy: resolved.policy });
      }
      if (request.method === "POST" && url.pathname === "/v1/plans") {
        const input = planInputSchema.parse(await request.json());
        if (input.refresh) resolver.clearSourceCache();
        const resolved = await resolver.resolveComposition(input.refs, input.extraRefs, input.policy, request.signal);
        const plan = composePlan(resolved.posts, resolved.policy);
        store.savePlan(plan);
        return json(plan);
      }
      if (request.method === "POST" && url.pathname === "/v1/web-plans") {
        const plan = webPlan(webPlanInputSchema.parse(await boundedJson(request, 32 * 1024, deadline(10_000, request.signal))));
        store.savePlan(plan);
        return json(plan);
      }
      if (request.method === "POST" && url.pathname === "/v1/render") {
        const plan = blockPlanSchema.parse(await request.json());
        store.savePlan(plan);
        const media = await renderPlan(plan, config.mediaDirectory);
        return json({ plan, media: media ? { ...media, url: `${config.publicBaseUrl}/media/${media.hash}.${media.extension}` } : null });
      }
      if (request.method === "POST" && url.pathname === "/v1/publications") {
        const input = publishRequestSchema.parse(await boundedJson(request, 4 * 1024 * 1024, deadline(10_000, request.signal)));
        if (input.remoteSave && input.remoteSave.snapshot.origin !== "cli") throw new Error("MCP saves require the explicitly enabled MCP save adapter");
        const bounded = deadline(150_000, request.signal);
        await authorizeLegacy(undefined, input.plan.hash, input.operationId, input.force, bounded);
        return json(await publisher.publish(input, bounded));
      }
      if (request.method === "GET" && url.pathname === "/v1/publications") {
        const hash = url.searchParams.get("plan");
        if (!hash || !/^[a-f0-9]{64}$/.test(hash)) return json({ error: "A valid plan hash is required" }, 400);
        return json({ receipt: store.latestReceiptForPlan(hash), attempt: store.unresolvedCreation(hash) });
      }
      const planMatch = url.pathname.match(/^\/v1\/plans\/([a-f0-9]{64})$/);
      const operationMatch = url.pathname.match(/^\/v1\/publication-operations\/([^/]+)$/);
      if (request.method === "GET" && operationMatch) {
        const state = store.operationState(operationMatch[1]!);
        return state ? json(state) : json({ error: "Not found" }, 404);
      }
      if (request.method === "GET" && planMatch) {
        const stored = store.plan(planMatch[1]!);
        return stored ? json(stored.plan) : json({ error: "Not found" }, 404);
      }
      const attemptMatch = url.pathname.match(/^\/v1\/publication-attempts\/([^/]+)$/);
      if (request.method === "GET" && attemptMatch) {
        const attempt = store.creationAttempt(attemptMatch[1]!);
        return attempt ? json(attempt) : json({ error: "Not found" }, 404);
      }
      const publicationMatch = url.pathname.match(/^\/v1\/publications\/([^/]+)$/);
      const resumeMatch = url.pathname.match(/^\/v1\/publications\/([^/]+)\/resume$/);
      if (request.method === "POST" && resumeMatch) {
        if (!store.receipt(resumeMatch[1]!)) return json({ error: "Not found" }, 404);
        const input = resumePublicationSchema.parse(await boundedJson(request, 4 * 1024 * 1024, deadline(10_000, request.signal)));
        const bounded = deadline(150_000, request.signal);
        await authorizeLegacy(resumeMatch[1]!, undefined, undefined, false, bounded);
        return json(await publisher.resume(resumeMatch[1]!, input.destinations, bounded));
      }
      if (request.method === "GET" && publicationMatch) {
        const receipt = store.receipt(publicationMatch[1]!);
        return receipt ? json(receipt) : json({ error: "Not found" }, 404);
      }
      return json({ error: "Not found" }, 404);
    } catch (error) {
      if (error instanceof AccountMismatchError) return json({ error: error.message }, 403);
      return errorResponse(error);
    }
  };

  return { handler, close: async () => { if (await saves.close()) store.close(); } };
}

export function serve(config = loadServiceConfig()) {
  const service = createService(config);
  const server = Bun.serve({ hostname: config.host, port: config.port, idleTimeout: 180, maxRequestBodySize: 4 * 1024 * 1024, fetch: service.handler });
  console.error(`arena-block listening on ${server.url}`);
  return { server, close: async () => { server.stop(); await service.close(); } };
}
