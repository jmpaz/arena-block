import { z } from "zod";
import { blockPlanSchema } from "./types.ts";

export const initiatorSchema = z.object({
  kind: z.enum(["human", "agent", "automation", "unknown"]),
  label: z.string().min(1).max(120).optional(),
  workflowId: z.string().regex(/^[A-Za-z0-9_.:-]{1,120}$/).optional(),
  identityBasis: z.enum(["declared", "unknown"]).default("declared"),
}).strict();
const channel = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/);
const channelList = z.array(channel).max(20);

/** Identity assertions are declared; only a future authenticated read may establish an actual actor. */
export const saveSnapshotSchema = z.object({
  schemaVersion: z.literal(1), schema: z.literal("arena-block.save.v1"),
  saveId: z.uuid(), createdAt: z.iso.datetime(), origin: z.enum(["cli", "mcp-local", "mcp-remote"]),
  initiator: initiatorSchema,
  client: z.object({ name: z.string().min(1).max(120), version: z.string().min(1).max(100), identityBasis: z.literal("declared") }).strict().optional(),
  authentication: z.object({
    credentialProfile: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/),
    expectedAccountId: z.number().int().positive().safe().optional(), authenticatedAccountVerified: z.literal(false),
  }).strict(),
  invocation: z.object({ operation: z.enum(["publish", "save-intent", "mcp.preview_save"]), arguments: z.literal("structured_only"), force: z.boolean(),
    inputs: z.object({ sourceRefs: z.array(z.string().max(8192)).max(20), destinationArgs: z.array(z.string().max(2048)).max(20), basis: z.enum(["declared_arguments", "canonical_from_plan"]) }).strict(),
  }).strict(),
  application: z.object({ name: z.literal("arena-block"), version: z.string().min(1).max(100), sourceRevision: z.string().regex(/^[a-f0-9]{40}$/).optional(), sourceId: z.string().min(1).max(150).optional() }).strict(),
  routing: z.object({ requestedDestinations: channelList, activeDestinations: channelList, destinations: channelList.min(1),
    defaultChannel: z.object({ channel, mode: z.enum(["fallback", "always"]), included: z.boolean(), reason: z.enum(["explicit", "always", "fallback", "not_included"]) }).strict().optional(),
    // Keep old immutable snapshots byte-for-byte compatible when read or replayed.
    remoteInbox: z.object({ channel, mode: z.enum(["fallback", "always"]), included: z.boolean(), reason: z.enum(["explicit", "always_log", "fallback", "not_included"]) }).strict().optional(),
  }).strict().refine(value => !(value.defaultChannel && value.remoteInbox), "Snapshot must identify one default channel"),
  plan: blockPlanSchema,
  redaction: z.object({ policy: z.literal("known_credentials_v1"), paths: z.array(z.string().min(1)), originalPlanHashOmitted: z.boolean() }).strict(),
  fidelity: z.object({ originalPlanPreserved: z.boolean(), rawCommandCaptured: z.literal(false), imageBytesIncluded: z.literal(false), renderedArtifactCreated: z.literal(false), renderedIngredientsComplete: z.literal(false) }).strict(),
}).strict();
export type SaveSnapshot = z.infer<typeof saveSnapshotSchema>;
export type Initiator = z.infer<typeof initiatorSchema>;
export function snapshotDefaultChannel(snapshot: SaveSnapshot) { return snapshot.routing.defaultChannel ?? snapshot.routing.remoteInbox; }
