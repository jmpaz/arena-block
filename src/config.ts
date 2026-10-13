import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { arenaDestination } from "./url.ts";

function channel(value: string): string {
  const trimmed = value.trim();
  if (/^https?:/i.test(trimmed)) {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash
      || !["are.na", "www.are.na"].includes(url.hostname) || url.pathname.split("/").filter(Boolean).length !== 2) {
      throw new Error("Expected an HTTPS Are.na channel URL without credentials, query or fragment");
    }
    const destination = arenaDestination(trimmed);
    if (!destination) throw new Error("Expected an Are.na channel URL");
    return destination;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(trimmed) || /^0+$/.test(trimmed)) throw new Error("Invalid Are.na channel ID or slug");
  if (/^\d+$/.test(trimmed)) {
    const id = BigInt(trimmed);
    if (id > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Numeric channel ID exceeds the safe integer range");
    return String(id);
  }
  return trimmed;
}

export function normalizeChannels(values: string[]): string[] {
  const normalized = [...new Set(values.map(channel))];
  if (normalized.length > 20) throw new Error("At most 20 destinations are supported, including the default channel");
  return normalized;
}

const channelSchema = z.union([z.string().min(1).max(2048), z.number().int().positive().safe()]).transform(value => channel(String(value)));
const defaultChannelSchema = z.object({ channel: channelSchema, mode: z.enum(["fallback", "always"]).default("fallback") }).strict();
const profileSchema = z.object({
  arenaTokenEnv: z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/),
  expectedAccountId: z.number().int().positive().safe().optional(),
}).strict();

export const userConfigSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  defaultChannel: defaultChannelSchema.optional(),
  // Input-only alias. Existing installations retain their chosen channel and placement policy.
  remoteInbox: defaultChannelSchema.optional(),
  defaultDestinations: z.array(channelSchema).max(20).default([]),
  provenance: z.object({
    local: z.boolean().default(false),
    remoteSnapshot: z.enum(["none", "summary", "full"]).default("none"),
  }).strict().default({ local: false, remoteSnapshot: "none" }),
  credentialProfiles: z.record(z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/), profileSchema)
    .default({ shared: { arenaTokenEnv: "ARENA_WRITE_ACCESS_TOKEN" } }),
  clients: z.object({
    cli: z.string().default("shared"),
    mcpLocal: z.string().default("shared"),
    mcpRemote: z.string().default("shared"),
  }).strict().default({ cli: "shared", mcpLocal: "shared", mcpRemote: "shared" }),
}).strict().superRefine((value, context) => {
  for (const [client, profile] of Object.entries(value.clients)) {
    if (!value.credentialProfiles[profile]) context.addIssue({ code: "custom", path: ["clients", client], message: "Unknown credential profile" });
  }
  if (value.defaultChannel && value.remoteInbox && (value.defaultChannel.channel !== value.remoteInbox.channel || value.defaultChannel.mode !== value.remoteInbox.mode)) {
    context.addIssue({ code: "custom", path: ["defaultChannel"], message: "defaultChannel and legacy remoteInbox disagree; configure one default channel" });
  }
  const chosen = value.defaultChannel ?? value.remoteInbox;
  if (value.defaultDestinations.length > 1 || chosen && value.defaultDestinations.some(destination => destination !== chosen.channel)) {
    context.addIssue({ code: "custom", path: ["defaultDestinations"], message: "Choose one defaultChannel before migrating legacy defaultDestinations" });
  }
  if (value.provenance.remoteSnapshot !== "none" && !chosen && !value.defaultDestinations.length) {
    context.addIssue({ code: "custom", path: ["provenance", "remoteSnapshot"], message: "Remote provenance requires a configured default channel" });
  }
}).transform(({ remoteInbox, defaultDestinations, ...value }) => ({ ...value,
  ...(value.defaultChannel ?? remoteInbox ?? (defaultDestinations[0] ? { channel: defaultDestinations[0], mode: "fallback" as const } : undefined)
    ? { defaultChannel: value.defaultChannel ?? remoteInbox ?? { channel: defaultDestinations[0]!, mode: "fallback" as const } } : {}),
}));
export type UserConfig = z.infer<typeof userConfigSchema>;
export type SaveOrigin = "cli" | "mcp-local" | "mcp-remote";

/** Config contains references to existing environment credentials, never token values. */
export async function loadUserConfig(explicitPath?: string, environment = process.env): Promise<UserConfig> {
  const path = explicitPath ?? environment.ARENA_BLOCK_CONFIG ?? join(environment.XDG_CONFIG_HOME ?? join(environment.HOME ?? homedir(), ".config"), "arena-block", "config.json");
  try {
    const file = await open(path, "r");
    let text: string;
    try {
      const buffer = Buffer.alloc(16_385); let read = 0;
      while (read < buffer.length) {
        const { bytesRead } = await file.read(buffer, read, buffer.length - read, null);
        if (!bytesRead) break;
        read += bytesRead;
      }
      if (read > 16_384) throw new Error("Arena Block config exceeds 16 KiB");
      text = buffer.subarray(0, read).toString("utf8");
    } finally { await file.close(); }
    return userConfigSchema.parse(JSON.parse(text));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !explicitPath && !environment.ARENA_BLOCK_CONFIG) return userConfigSchema.parse({});
    throw error;
  }
}

export function routeSave(config: UserConfig, requested: string[], legacyDefaults: string[] = []) {
  const explicit = normalizeChannels(requested);
  const chosen = config.defaultChannel;
  const activeDestinations = explicit.length ? explicit : chosen ? [] : normalizeChannels(legacyDefaults);
  const explicitDefault = Boolean(chosen && explicit.includes(chosen.channel));
  const included = Boolean(chosen && (explicitDefault || chosen.mode === "always" || !explicit.length));
  const destinations = normalizeChannels([...(included ? [chosen!.channel] : []), ...activeDestinations]);
  if (!destinations.length) throw new Error("A --to destination or configured default channel is required");
  return { requestedDestinations: explicit, activeDestinations, destinations,
    ...(chosen ? { defaultChannel: { ...chosen, included,
      reason: explicitDefault ? "explicit" as const : included ? explicit.length ? "always" as const : "fallback" as const : "not_included" as const } } : {}) };
}

export function credentialProfile(config: UserConfig, origin: SaveOrigin, selected?: string) {
  const client = origin === "cli" ? "cli" : origin === "mcp-local" ? "mcpLocal" : "mcpRemote";
  const name = selected ?? config.clients[client];
  if (!config.credentialProfiles[name]) throw new Error("Unknown credential profile; no fallback credential was selected");
  return { name, ...config.credentialProfiles[name]! };
}

export const daemonCredentialSchema = z.object({
  schemaVersion: z.literal(1),
  profile: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/),
  arenaTokenEnv: z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/),
  expectedAccountId: z.number().int().positive().safe(),
}).strict();
export type DaemonCredential = z.infer<typeof daemonCredentialSchema>;
