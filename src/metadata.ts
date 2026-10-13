import { z } from "zod";
import { parseArenaBlockUrl } from "../packages/core/url.ts";
import type { ArenaClient } from "./arena.ts";

const observedMetadataSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("present"), value: z.unknown() }),
  z.object({ state: z.literal("empty"), value: z.record(z.string(), z.unknown()) }),
  z.object({ state: z.literal("null"), value: z.null() }),
  z.object({ state: z.literal("missing") }),
]);

const personSchema = z.object({
  id: z.number().int().optional(),
  name: z.string().optional(),
  slug: z.string().optional(),
});

export const arenaBlockMetadataSchema = z.object({
  schemaVersion: z.literal(1),
  block: z.object({
    id: z.number().int(),
    url: z.string().url(),
    type: z.string().optional(),
    title: z.string().nullable().optional(),
    visibility: z.string().optional(),
    source: z.unknown().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
    createdBy: personSchema.optional(),
    metadata: observedMetadataSchema,
  }),
  placements: z.array(z.object({
    channel: z.object({
      id: z.number().int().optional(),
      title: z.string().optional(),
      slug: z.string().optional(),
    }),
    readState: z.enum([
      "complete",
      "connection_reference_missing",
      "connection_lookup_unavailable",
      "connection_detail_unavailable",
    ]),
    connectionId: z.number().int().optional(),
    connection: z.object({
      id: z.number().int().optional(),
      position: z.number().int().optional(),
      pinned: z.boolean().optional(),
      connectedAt: z.string().optional(),
      connectedBy: personSchema.optional(),
      metadata: observedMetadataSchema,
    }).optional(),
    error: z.object({
      kind: z.enum(["api", "network"]),
      status: z.number().int().optional(),
    }).optional(),
  })),
  completeness: z.enum(["complete", "partial"]),
});

export type ArenaBlockMetadata = z.infer<typeof arenaBlockMetadataSchema>;

type JsonRecord = Record<string, unknown>;

function object(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function integer(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }
  return undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function metadata(record: JsonRecord): ArenaBlockMetadata["block"]["metadata"] {
  if (!Object.prototype.hasOwnProperty.call(record, "metadata")) return { state: "missing" };
  const value = record.metadata;
  if (value === null) return { state: "null", value: null };
  if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) {
    return { state: "empty", value: value as JsonRecord };
  }
  return { state: "present", value };
}

function person(value: unknown) {
  const record = object(value);
  if (!record) return undefined;
  const id = integer(record.id);
  const name = text(record.name);
  const slug = text(record.slug);
  const result = {
    ...(id !== undefined ? { id } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(slug !== undefined ? { slug } : {}),
  };
  return Object.keys(result).length ? result : undefined;
}

function apiStatus(error: unknown): number | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const match = / returned (\d{3})(?::|$)/.exec(message);
  return match ? Number(match[1]) : undefined;
}

function safeLabel(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, (character) =>
    "\\u" + character.codePointAt(0)!.toString(16).padStart(4, "0"));
}

export async function readArenaBlockMetadata(client: ArenaClient, blockUrl: string, signal?: AbortSignal): Promise<ArenaBlockMetadata> {
  const blockId = parseArenaBlockUrl(blockUrl);
  const rawBlock = object(await client.block(blockId, signal));
  if (!rawBlock) throw new Error("Are.na returned an invalid block record");

  if (integer(rawBlock.id) !== blockId) throw new Error("Are.na returned a different block ID");
  const channels = await client.connectionChannels(blockId, signal);
  const placements: ArenaBlockMetadata["placements"] = [];
  for (let offset = 0; offset < channels.length; offset += 4) {
    placements.push(...await Promise.all(channels.slice(offset, offset + 4).map(async (rawChannel) => {
    const channel = object(rawChannel) ?? {};
    const channelId = integer(channel.id);
    const title = text(channel.title);
    const slug = text(channel.slug);
    const placementChannel = {
      ...(channelId !== undefined ? { id: channelId } : {}),
      ...(title !== undefined ? { title } : {}),
      ...(slug !== undefined ? { slug } : {}),
    };
    if (channelId === undefined) {
      return { channel: placementChannel, readState: "connection_reference_missing" as const };
    }

    let connectionId: number | undefined;
    try {
      // Channel IDs, rather than titles, keep same-named Inbox channels distinct.
      const placement = await client.channelPlacement(channelId, blockId, signal);
      connectionId = integer(object(placement?.connection)?.id);
    } catch (error) {
      const status = apiStatus(error);
      return {
        channel: placementChannel,
        readState: "connection_lookup_unavailable" as const,
        error: status ? { kind: "api" as const, status } : { kind: "network" as const },
      };
    }
    if (connectionId === undefined) {
      return { channel: placementChannel, readState: "connection_reference_missing" as const };
    }

    let rawConnection: JsonRecord;
    try {
      rawConnection = object(await client.connection(connectionId, signal)) ?? {};
    } catch (error) {
      const status = apiStatus(error);
      return {
        channel: placementChannel,
        connectionId,
        readState: "connection_detail_unavailable" as const,
        error: status ? { kind: "api" as const, status } : { kind: "network" as const },
      };
    }

    const connectedBy = person(rawConnection.connected_by);
    const id = integer(rawConnection.id);
    if (id !== connectionId) {
      return { channel: placementChannel, connectionId, readState: "connection_detail_unavailable" as const };
    }
    const position = integer(rawConnection.position);
    const connectedAt = text(rawConnection.connected_at);
    return {
      channel: placementChannel,
      connectionId,
      readState: "complete" as const,
      connection: {
        id,
        ...(position !== undefined ? { position } : {}),
        ...(typeof rawConnection.pinned === "boolean" ? { pinned: rawConnection.pinned } : {}),
        ...(connectedAt !== undefined ? { connectedAt } : {}),
        ...(connectedBy ? { connectedBy } : {}),
        metadata: metadata(rawConnection),
      },
    };
    })));
  }

  const blockUser = person(rawBlock.user);
  const title = rawBlock.title;
  const createdAt = text(rawBlock.created_at);
  const updatedAt = text(rawBlock.updated_at);
  const visibility = text(rawBlock.visibility);
  const type = text(rawBlock.type);
  const result = {
    schemaVersion: 1 as const,
    block: {
      id: blockId,
      url: "https://www.are.na/block/" + blockId,
      ...(type !== undefined ? { type } : {}),
      ...(title === null || typeof title === "string" ? { title } : {}),
      ...(visibility !== undefined ? { visibility } : {}),
      ...(Object.prototype.hasOwnProperty.call(rawBlock, "source") ? { source: rawBlock.source } : {}),
      ...(createdAt !== undefined ? { createdAt } : {}),
      ...(updatedAt !== undefined ? { updatedAt } : {}),
      ...(blockUser ? { createdBy: blockUser } : {}),
      metadata: metadata(rawBlock),
    },
    placements,
    completeness: placements.every((placement) => placement.readState === "complete") ? "complete" as const : "partial" as const,
  };
  return arenaBlockMetadataSchema.parse(result);
}

function inlineCode(value: string, max = 180): string {
  const encoded = safeLabel(value).replaceAll("`", "\\u0060");
  const inner = encoded.length <= max - 2 ? encoded : encoded.slice(0, max - 3) + "…";
  return "`" + inner + "`";
}

function shortValue(value: unknown, max = 180): string {
  const serialized = JSON.stringify(value);
  return inlineCode(serialized === undefined ? String(value) : serialized, max);
}

function describeMetadata(value: ArenaBlockMetadata["block"]["metadata"], label: string): string[] {
  if (value.state === "missing") return [label + ": not returned"];
  if (value.state === "null") return [label + ": null"];
  if (value.state === "empty") return [label + ": empty"];
  const record = object(value.value);
  if (!record) return [label + ": " + shortValue(value.value)];
  const keys = Object.keys(record).sort();
  if (!keys.length) return [label + ": empty"];
  const lines = [label + " (" + keys.length + " fields):"];
  for (const key of keys.slice(0, 20)) lines.push("  " + shortValue(key) + " = " + shortValue(record[key]));
  if (keys.length > 20) lines.push("  … " + (keys.length - 20) + " more; use --json for the full values");
  return lines;
}

export function formatArenaBlockMetadata(value: ArenaBlockMetadata): string {
  const block = value.block;
  const lines = [block.title ? shortValue(block.title) : "Are.na block"];
  lines.push("URL: " + block.url);
  if (block.type) lines.push("Type: " + block.type);
  if (block.source !== undefined) lines.push("Source: " + shortValue(block.source));
  if (block.createdBy?.name) lines.push("Added by: " + shortValue(block.createdBy.name));
  lines.push(...describeMetadata(block.metadata, "Block metadata"));
  lines.push("Placements (" + value.placements.length + ")" + (value.completeness === "partial" ? " · partial read" : "") + ":");
  for (const placement of value.placements) {
    const name = placement.channel.title === undefined ? "Untitled channel" : shortValue(placement.channel.title);
    const channelId = placement.channel.id === undefined ? "channel ID unavailable" : "channel " + placement.channel.id;
    const connectionId = placement.connectionId === undefined ? "" : " · connection #" + placement.connectionId;
    lines.push("- " + name + " (" + channelId + ")" + connectionId);
    if (placement.readState !== "complete") {
      const status = placement.error?.status ? ", HTTP " + placement.error.status : "";
      lines.push("  Connection details unavailable (" + placement.readState.replaceAll("_", " ") + status + ")");
    } else if (placement.connection) {
      if (placement.connection.connectedAt) lines.push("  Connected: " + placement.connection.connectedAt);
      if (placement.connection.connectedBy?.name) lines.push("  Connected by: " + shortValue(placement.connection.connectedBy.name));
      lines.push(...describeMetadata(placement.connection.metadata, "  Connection metadata"));
    }
  }
  return lines.join("\n");
}
