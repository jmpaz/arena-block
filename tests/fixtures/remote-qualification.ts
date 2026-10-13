import { mkdir, readFile, writeFile, rename, open, unlink, lstat } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { ArenaClient, ArenaPublisher } from "../../src/arena.ts";
import { ArenaBlockStore } from "../../src/store.ts";
import { publicationPayload } from "../../src/capture.ts";
import { provenanceMetadata, readProvenanceMetadata, mergedMetadata, type Metadata } from "../../src/connection-metadata.ts";
import { saveSnapshotSchema } from "../../src/provenance-schema.ts";
import { redactProvenance } from "../../src/provenance-redaction.ts";
import { QUALIFICATION_APPROVAL, QUALIFICATION_SAVE_IDS, qualificationPlan, qualificationRequests, qualificationChannelPayload, qualificationBoundaryPatch, qualificationMergePatch } from "./qualification-fixtures.ts";

const limits = { channelCreates: 1, blockCreates: 2, connectionCreates: 0, blockUpdates: 2, connectionMetadataUpdates: 4, reads: 120 };
const checkpointSchema = z.object({
  schemaVersion: z.literal(1), runId: z.uuid(), expectedAccountId: z.literal(700),
  channelId: z.number().int().positive().safe().refine(value => value !== 90001).optional(),
  blockIds: z.array(z.number().int().positive().safe()).max(2), connectionIds: z.array(z.number().int().positive().safe()).max(2),
  discardedCreateResponse: z.boolean(),
  used: z.object({ channelCreates: z.number().int().min(0).max(1), blockCreates: z.number().int().min(0).max(2), connectionCreates: z.literal(0),
    blockUpdates: z.number().int().min(0).max(2), connectionMetadataUpdates: z.number().int().min(0).max(4), reads: z.number().int().min(0).max(120) }).strict(),
  boundaryApplied: z.boolean(), mergeApplied: z.boolean(), completed: z.boolean(), error: z.string().optional(),
}).strict();
type Checkpoint = z.infer<typeof checkpointSchema>;
const record = (value: any) => value?.data ?? value;
function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }

/** Prepared private runner. Invocation is an execution control, never evidence of user approval. */
export async function runApprovedQualification(options: {
  approval: typeof QUALIFICATION_APPROVAL; stateDirectory: string; token: string;
  fetcher?: typeof fetch;
}) {
  check(options.approval === QUALIFICATION_APPROVAL, "Explicit fixture approval is required before execution");
  check(options.token.length > 0, "Use only the existing ARENA_WRITE_ACCESS_TOKEN; do not create a credential");
  await mkdir(options.stateDirectory, { recursive: true, mode: 0o700 });
  const directory = await lstat(options.stateDirectory);
  check(directory.isDirectory() && !directory.isSymbolicLink() && directory.uid === process.getuid?.() && (directory.mode & 0o077) === 0,
    "Qualification requires an owned private state directory (0700) before any request");
  async function privateFile(file: string, required = false) {
    try {
      const info = await lstat(file);
      check(info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid?.() && (info.mode & 0o077) === 0, "Qualification state must be owned private regular files (0600)");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" || required) throw error; }
  }
  await privateFile(join(options.stateDirectory, "checkpoint.json")); await privateFile(join(options.stateDirectory, "runner.lock"));
  const lock = await open(join(options.stateDirectory, "runner.lock"), "wx", 0o600);
  let state!: Checkpoint;
  const path = join(options.stateDirectory, "checkpoint.json");
  let writes = Promise.resolve();
  const checkpoint = async () => {
    const bytes = JSON.stringify(checkpointSchema.parse(state), null, 2) + "\n";
    writes = writes.then(async () => {
      const staging = join(options.stateDirectory, `.checkpoint-${crypto.randomUUID()}`);
      await writeFile(staging, bytes, { mode: 0o600, flag: "wx" }); await rename(staging, path);
    });
    await writes;
  };
  let store: ArenaBlockStore | undefined;
  try {
    try { state = checkpointSchema.parse(JSON.parse(await readFile(path, "utf8"))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      state = { schemaVersion: 1, runId: crypto.randomUUID(), expectedAccountId: 700, blockIds: [], connectionIds: [], discardedCreateResponse: false,
        used: { channelCreates: 0, blockCreates: 0, connectionCreates: 0, blockUpdates: 0, connectionMetadataUpdates: 0, reads: 0 }, boundaryApplied: false, mergeApplied: false, completed: false };
      await checkpoint();
    }
    if (state.completed) return { state, retained: true, execution: "already_completed_no_requests" };
    const database = join(options.stateDirectory, "qualification.sqlite");
    if (state.used.blockCreates > 0) {
      await privateFile(database, true);
      store = new ArenaBlockStore(database, { private: true });
      for (const saveId of QUALIFICATION_SAVE_IDS.slice(0, state.used.blockCreates)) {
        const saved = store.remoteSave(saveId), operation = store.operationState(saveId);
        check(saved && operation && saved.intent.inboxChannelId === state.channelId && saved.intent.accountId === state.expectedAccountId,
          "Attempted fixture is missing its durable publication journal; reconcile manually without a new POST");
      }
    }
    const channelPayload = { ...qualificationChannelPayload, metadata: { ab_test_run_id: state.runId } };
    const transport = options.fetcher ?? fetch;
    const guardedFetch = (async (input, init) => {
      const url = new URL(String(input)); const method = init?.method ?? "GET", body = init?.body ? JSON.parse(String(init.body)) : undefined;
      check(url.origin === "https://api.are.na" && url.pathname.startsWith("/v3/"), "Qualification traffic is restricted to the official Are.na API");
      check(init?.redirect === "error", "Qualification requests must reject redirects");
      const endpoint = url.pathname.slice(3);
      let bucket: keyof typeof limits;
      if (method === "GET") {
        check(endpoint === "/me" || endpoint === `/channels/${state.channelId}` || endpoint === `/channels/${state.channelId}/contents`
          || state.blockIds.some(blockId => endpoint === `/blocks/${blockId}` || endpoint === `/blocks/${blockId}/connections`)
          || state.connectionIds.some(connectionId => endpoint === `/connections/${connectionId}`), "Read outside the new fixture scope was blocked");
        bucket = "reads";
      } else if (method === "POST" && endpoint === "/channels") {
        check(!state.channelId && isDeepStrictEqual(body, channelPayload), "Only the single approved private channel payload is allowed"); bucket = "channelCreates";
      } else if (method === "POST" && endpoint === "/blocks") {
        check(state.channelId, "Fixture channel must be retained before creating a block");
        const fixtures = qualificationRequests(state.channelId, 700);
        const expected = fixtures.map(input => {
          const { channel_ids: _, ...block } = publicationPayload(input.plan, "https://fixture.invalid", undefined, [state.channelId!]);
          return { ...block, channels: [{ id: state.channelId, metadata: { ...provenanceMetadata(saveSnapshotSchema.parse(input.remoteSave!.snapshot), "full"), ab_actor_id: 700, ab_actor_verified: true } }] };
        });
        check(expected.some(payload => isDeepStrictEqual(payload, body)), "Only the two exact fictional block payloads are allowed"); bucket = "blockCreates";
      } else if (method === "PUT" && state.blockIds.some(blockId => endpoint === `/blocks/${blockId}`)) {
        const fixtures = qualificationRequests(state.channelId!, 700);
        check(fixtures.some(input => isDeepStrictEqual(body, { title: input.plan.block.title, description: input.plan.block.description, content: input.plan.block.markdown })), "Fixture block update does not match its planned text"); bucket = "blockUpdates";
      } else if (method === "PUT" && state.connectionIds.some(connectionId => endpoint === `/connections/${connectionId}`)) {
        const keys = Object.keys(body?.metadata ?? {});
        check(keys.length > 0 && keys.every(key => key.startsWith("ab_test_") || key === "k".repeat(40) || ["ab_result_status", "ab_block_id", "ab_receipt_id"].includes(key)), "Only outcome and qualification metadata keys may be updated"); bucket = "connectionMetadataUpdates";
      } else throw new Error("Write outside the two-block qualification was blocked; connection creation and deletion are prohibited");
      check(state.used[bucket] < limits[bucket], `Qualification ${bucket} request budget exhausted; reconcile before any new run`);
      state.used[bucket]++; await checkpoint(); // Persist the consumed allowance BEFORE transmission.
      const response = await transport(input, init);
      if (response.ok) {
        const value = await response.clone().json(); const data = record(value);
        if (bucket === "channelCreates") {
          check(Number.isSafeInteger(data.id) && data.id > 0 && data.id !== 90001 && data.visibility === "private"
            && data.owner?.id === 700 && data.owner?.type === "User", "Returned channel identity, visibility or ownership is unconfirmed; stop without retry");
          state.channelId = data.id;
        } else if (bucket === "blockCreates") {
          check(Number.isSafeInteger(data.id) && data.id > 0 && !state.blockIds.includes(data.id), "Block response identity is unconfirmed"); state.blockIds.push(data.id);
        } else if (bucket === "reads" && endpoint.endsWith("/contents")) {
          check(Array.isArray(value.data), "Invalid fixture contents response");
          for (const entry of value.data) {
            // A genuinely lost HTTP response may leave no block ID in this checkpoint.
            // Accept bounded read evidence only for an exact owned capsule, then scope later reads to that ID.
            const input = qualificationRequests(state.channelId!, 700).find(input => input.operationId === entry.connection?.metadata?.ab_save_id);
            if (input && Number.isSafeInteger(entry.id) && entry.id > 0 && entry.connection?.connected_by?.id === 700
              && isDeepStrictEqual(readProvenanceMetadata(entry.connection.metadata), saveSnapshotSchema.parse(input.remoteSave!.snapshot))) {
              if (!state.blockIds.includes(entry.id)) state.blockIds.push(entry.id);
            }
            if (state.blockIds.includes(entry.id) && Number.isSafeInteger(entry.connection?.id) && entry.connection.id > 0
              && !state.connectionIds.includes(entry.connection.id)) state.connectionIds.push(entry.connection.id);
          }
        }
        await checkpoint();
        if (bucket === "blockCreates" && body.channels[0].metadata.ab_save_id === QUALIFICATION_SAVE_IDS[1] && !state.discardedCreateResponse) {
          state.discardedCreateResponse = true; await checkpoint();
          throw new Error("Controlled local loss of the second accepted fixture create response");
        }
      }
      return response;
    }) as typeof fetch;
    const client = new ArenaClient(options.token, "https://api.are.na/v3", guardedFetch, 20_000);
    const account = await client.me(); check(account.id === 700, "Existing authenticated account differs from the approved account");
    if (!state.channelId) {
      check(state.used.channelCreates === 0, "Channel creation was already attempted with an unknown response; inspect it before any additional write");
      const response = await guardedFetch("https://api.are.na/v3/channels", { method: "POST", redirect: "error", signal: AbortSignal.timeout(20_000),
        headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" }, body: JSON.stringify(channelPayload) });
      check(response.ok && state.channelId, "Channel creation failed or remains unknown; no automatic retry");
    }
    const channel = await client.channel(state.channelId);
    check(channel.visibility === "private" && channel.title === "arena-block test" && (channel.owner as any)?.id === 700
      && (channel.can as any)?.add_to === true && (channel.metadata as any)?.ab_test_run_id === state.runId, "Fixture channel must match this run, remain private, owned by the approved account and writable");
    store ??= new ArenaBlockStore(database, { private: true });
    const publisher = new ArenaPublisher(client, store, { publicBaseUrl: "https://fixture.invalid", mediaDirectory: join(options.stateDirectory, "unused-media"),
      render: async () => undefined, verifyTimeoutMs: 30_000, pollIntervalMs: 500,
      remoteProvenance: { inboxChannel: String(state.channelId), mode: "full", credentialProfile: "shared", expectedAccountId: 700 } });
    const fixtures = qualificationRequests(state.channelId, 700);
    const first = await publisher.publish(fixtures[0]!);
    const connectionId = first.remoteProvenance?.connectionId; check(connectionId, "First fixture has no channel-verified connection");
    const initial = await client.connection(connectionId), initialMetadata = (initial.metadata ?? {}) as Metadata;
    const originalSnapshot = readProvenanceMetadata(initialMetadata);
    if (!state.boundaryApplied) {
      const merged = mergedMetadata(initialMetadata, qualificationBoundaryPatch);
      await client.updateConnectionMetadata(connectionId, qualificationBoundaryPatch);
      const observed = (await client.connection(connectionId)).metadata;
      check(isDeepStrictEqual(observed, merged), "String/key boundaries were not retained exactly"); state.boundaryApplied = true; await checkpoint();
    }
    if (!state.mergeApplied) {
      const before = (await client.connection(connectionId)).metadata as Metadata;
      const merged = mergedMetadata(before, qualificationMergePatch);
      await client.updateConnectionMetadata(connectionId, qualificationMergePatch);
      const observed = (await client.connection(connectionId)).metadata as Metadata;
      check(isDeepStrictEqual(observed, merged) && !Object.hasOwn(observed, "ab_test_remove"), "Merge/null deletion or omitted-key retention did not match the contract");
      check(isDeepStrictEqual(readProvenanceMetadata(observed), originalSnapshot), "Qualification updates changed the original snapshot"); state.mergeApplied = true; await checkpoint();
    }
    try { await publisher.publish(fixtures[1]!); }
    catch (error) { if (!(error instanceof Error) || !error.message.includes("outcome is unknown")) throw error; }
    const second = await publisher.publish(fixtures[1]!);
    const replayFirst = await publisher.publish(fixtures[0]!), replaySecond = await publisher.publish(fixtures[1]!);
    check(replayFirst.id === first.id && replaySecond.id === second.id, "Replay did not retain the original receipts");
    const finalChannel = await client.channel(state.channelId), final = await client.channelContents(state.channelId);
    check(finalChannel.visibility === "private" && final.complete && final.entries.length === 2, "Final fixture visibility or two-block cardinality is unconfirmed");
    for (const input of fixtures) {
      const matches = final.entries.filter(entry => (entry.connection as any)?.metadata?.ab_save_id === input.operationId);
      check(matches.length === 1 && state.blockIds.includes(matches[0]!.id as number), "Save-to-block-to-channel mapping is ambiguous");
      check(isDeepStrictEqual(readProvenanceMetadata((matches[0]!.connection as any).metadata), saveSnapshotSchema.parse(input.remoteSave!.snapshot)), "Full fixture capsule failed readback");
    }
    check(state.used.channelCreates === 1 && state.used.blockCreates === 2 && state.used.connectionCreates === 0, "Unexpected creation cardinality");
    state.completed = true; delete state.error; await checkpoint();
    return { state, retained: true, qualification: "one-account_fixture_only", limitations: qualificationPlan().limits };
  } catch (error) {
    if (state!) { state.error = redactProvenance(error instanceof Error ? error.message : String(error)).value; await checkpoint(); }
    throw error;
  } finally { store?.close(); await lock.close(); await unlink(join(options.stateDirectory, "runner.lock")); }
}

/** Independent final readback: nine scoped GETs, zero writes or source fetches. */
export async function verifyCompletedQualification(options: { stateDirectory: string; token: string; fetcher?: typeof fetch }) {
  const info = await lstat(options.stateDirectory), file = await lstat(join(options.stateDirectory, "checkpoint.json"));
  check(info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid?.() && (info.mode & 0o077) === 0
    && file.isFile() && !file.isSymbolicLink() && file.uid === process.getuid?.() && (file.mode & 0o077) === 0, "Verification requires the owned private checkpoint");
  const state = checkpointSchema.parse(JSON.parse(await readFile(join(options.stateDirectory, "checkpoint.json"), "utf8")));
  check(state.completed && state.channelId && state.blockIds.length === 2 && state.connectionIds.length === 2, "Only a completed two-block fixture may be verified");
  let reads = 0;
  const get = async (path: string) => {
    check(path === "/me" || path === `/channels/${state.channelId}` || path === `/channels/${state.channelId}/contents?per=100&page=1&sort=position_desc`
      || state.blockIds.some(blockId => path === `/blocks/${blockId}` || path === `/blocks/${blockId}/connections`)
      || state.connectionIds.some(connectionId => path === `/connections/${connectionId}`), "Verification read escaped the fixture scope");
    check(++reads <= 9, "Verification read budget exhausted");
    const response = await (options.fetcher ?? fetch)(`https://api.are.na/v3${path}`, { method: "GET", redirect: "error", signal: AbortSignal.timeout(20_000),
      headers: { authorization: `Bearer ${options.token}`, accept: "application/json" } });
    check(response.ok, `Qualification readback returned HTTP ${response.status}`); return response.json();
  };
  const account = record(await get("/me")), channel = record(await get(`/channels/${state.channelId}`));
  check(account.id === state.expectedAccountId && channel.id === state.channelId && channel.visibility === "private" && channel.owner?.id === state.expectedAccountId
    && channel.metadata?.ab_test_run_id === state.runId, "Fixture identity, ownership, privacy or run identity changed");
  const contents = await get(`/channels/${state.channelId}/contents?per=100&page=1&sort=position_desc`);
  check(Array.isArray(contents.data) && contents.data.length === 2 && contents.meta?.total_pages <= 1 && contents.meta?.has_more_pages !== true, "Final fixture cardinality is unconfirmed");
  const fixtures = [];
  for (const input of qualificationRequests(state.channelId, state.expectedAccountId)) {
    const matching = contents.data.filter((entry: any) => entry.connection?.metadata?.ab_save_id === input.operationId);
    check(matching.length === 1 && state.blockIds.includes(matching[0].id) && state.connectionIds.includes(matching[0].connection?.id), "Fixture placement mapping differs from the retained receipt");
    const entry = matching[0], block = record(await get(`/blocks/${entry.id}`)), connection = record(await get(`/connections/${entry.connection.id}`));
    const placements = await get(`/blocks/${entry.id}/connections`);
    check(Array.isArray(placements.data) && placements.data.length === 1 && placements.data[0]?.id === state.channelId, "Fixture has an unexpected additional channel placement");
    check(connection.id === entry.connection.id && connection.connected_by?.id === state.expectedAccountId && block.user?.id === state.expectedAccountId && block.visibility === "private",
      "Fixture block ownership or connection actor differs from the approved account");
    const snapshot = readProvenanceMetadata(connection.metadata);
    check(isDeepStrictEqual(snapshot, saveSnapshotSchema.parse(input.remoteSave!.snapshot)) && connection.metadata.ab_actor_id === state.expectedAccountId
      && connection.metadata.ab_actor_verified === true && connection.metadata.ab_result_status === "verified", "Original capsule or verified outcome differs on final readback");
    const markdown = block.content?.markdown ?? block.content;
    check(markdown === input.plan.block.markdown && block.title === input.plan.block.title && block.description?.markdown === input.plan.block.description, "Final fictional text, title or description differs");
    if (input.operationId === QUALIFICATION_SAVE_IDS[0]) check(connection.metadata.ab_test_keep === "kept_changed" && !Object.hasOwn(connection.metadata, "ab_test_remove")
      && connection.metadata.ab_test_ascii === qualificationBoundaryPatch.ab_test_ascii && connection.metadata.ab_test_unicode === qualificationBoundaryPatch.ab_test_unicode
      && connection.metadata.ab_test_number === 42 && connection.metadata.ab_test_bool === false && connection.metadata["k".repeat(40)] === 1, "Merge/null/boundary readback differs");
    fixtures.push({ saveId: input.operationId, blockId: block.id, blockUrl: `https://www.are.na/block/${block.id}`, blockUserId: block.user.id,
      type: block.type, state: block.state, visibility: block.visibility, title: block.title, description: block.description.markdown, markdown,
      connectionId: connection.id, connectedById: connection.connected_by.id, connectedAt: connection.connected_at,
      metadata: connection.metadata, sourceTextVerified: true, snapshotVerified: true, soleChannelId: state.channelId });
  }
  return { observedAt: new Date().toISOString(), reads, writes: 0, existingAccountId: account.id, channel: { id: channel.id, title: channel.title, slug: channel.slug,
    url: `https://www.are.na/${channel.owner.slug}/${channel.slug}`, visibility: channel.visibility, ownerId: channel.owner.id,
    collaboratorCount: channel.counts?.collaborators, blockCount: channel.counts?.blocks, runId: state.runId }, fixtures };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (!args.length || args.length === 1 && args[0] === "--plan") console.log(JSON.stringify(qualificationPlan(), null, 2));
  else {
    if (args.length !== 3 || !["--execute-approved", "--verify-only"].includes(args[0]!) || args[1] !== "--state-dir" || !args[2]) throw new Error("Use --plan. After explicit user approval only: --execute-approved --state-dir <owned-new-directory>");
    try { console.log(JSON.stringify(await (args[0] === "--verify-only"
      ? verifyCompletedQualification({ stateDirectory: args[2], token: process.env.ARENA_WRITE_ACCESS_TOKEN ?? "" })
      : runApprovedQualification({ approval: QUALIFICATION_APPROVAL, stateDirectory: args[2], token: process.env.ARENA_WRITE_ACCESS_TOKEN ?? "" })), null, 2)); }
    catch (error) { console.error(JSON.stringify({ error: redactProvenance(error instanceof Error ? error.message : String(error)).value, stateDirectory: args[2] })); process.exitCode = 1; }
  }
}
