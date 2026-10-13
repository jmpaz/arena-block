import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { userConfigSchema, routeSave, credentialProfile, loadUserConfig, normalizeChannels } from "../src/config.ts";
import { composePlan } from "../src/compose.ts";
import { prepareSaveIntent, writeSaveIntent, writeSaveResult, snapshotHash } from "../src/save-intent.ts";
import { initialProvenancePatch, mergedMetadata, provenanceMetadata, readProvenanceMetadata, validateMetadata } from "../src/connection-metadata.ts";
import { ArenaClient } from "../src/arena.ts";
import { redactProvenance } from "../src/provenance-redaction.ts";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function directory() { const path = await mkdtemp(join(tmpdir(), "arena-inbox-test-")); directories.push(path); return path; }
const plan = (text = "Original writing\n\n*Kept emphasis*") => composePlan([{ provider: "x", id: "1", canonicalUrl: "https://x.com/example/status/1", author: { handle: "example" }, text, media: [] }]);
const config = (mode: "fallback" | "always" = "fallback", remoteSnapshot: "none" | "summary" | "full" = "none") => userConfigSchema.parse({ remoteInbox: { channel: "90001", mode }, provenance: { local: true, remoteSnapshot } });
const intent = (source = plan(), configuration = config()) => prepareSaveIntent(source, configuration, { origin: "cli", initiator: { kind: "human" }, saveId: "916e4d14-9b71-45c6-ab09-d67b1f199f3b", createdAt: "2026-10-05T19:20:00Z" });

describe("opt-in Remote Inbox routing and profiles", () => {
  test("default disabled policy retains explicit and legacy destinations", () => {
    const disabled = userConfigSchema.parse({});
    expect(disabled.defaultChannel).toBeUndefined();
    expect(routeSave(disabled, ["chosen"], ["legacy"]).destinations).toEqual(["chosen"]);
    expect(routeSave(disabled, [], ["legacy"]).destinations).toEqual(["legacy"]);
    expect(() => routeSave(disabled, [])).toThrow("required");
  });
  test("fallback sends destination-free input to Remote Inbox, preserving explicit choices", () => {
    expect(routeSave(config(), [], ["legacy"])).toMatchObject({ activeDestinations: [], destinations: ["90001"], defaultChannel: { included: true, mode: "fallback" } });
    expect(routeSave(config(), ["chosen"]).destinations).toEqual(["chosen"]);
    expect(routeSave(config(), ["90001"]).destinations).toEqual(["90001"]);
  });
  test("always mode adds one inbox and enforces the combined twenty-channel cap", () => {
    expect(routeSave(config("always"), ["chosen", "90001", "090001"]).destinations).toEqual(["90001", "chosen"]);
    expect(() => routeSave(config("always"), Array.from({ length: 20 }, (_, i) => `channel-${i}`))).toThrow("20 destinations");
    expect(routeSave(config("always"), [], ["legacy"]).destinations).toEqual(["90001"]);
    expect(routeSave(config(), ["90001"]).defaultChannel?.reason).toBe("explicit");
  });
  test("URL normalization rejects private credential arguments and unsupported destinations", () => {
    expect(normalizeChannels(["https://www.are.na/example-user/remote-inbox", "remote-inbox"])).toEqual(["remote-inbox"]);
    for (const invalid of ["https://secret@www.are.na/josh/remote-inbox", "https://www.are.na/josh/remote-inbox?token=secret", "https://www.are.na/block/123", "https://elsewhere.invalid/josh/remote-inbox", "0", "9007199254740993"]) expect(() => normalizeChannels([invalid])).toThrow();
  });
  test("config only accepts named credential references and keeps origins separate", () => {
    const separate = userConfigSchema.parse({ credentialProfiles: { human: { arenaTokenEnv: "ARENA_HUMAN_TOKEN", expectedAccountId: 700 }, bot: { arenaTokenEnv: "ARENA_BOT_TOKEN" } }, clients: { cli: "human", mcpLocal: "bot", mcpRemote: "bot" } });
    expect(credentialProfile(separate, "cli")).toMatchObject({ name: "human", expectedAccountId: 700 });
    expect(credentialProfile(separate, "mcp-local").name).toBe("bot");
    expect(() => userConfigSchema.parse({ credentialProfiles: { shared: { arenaTokenEnv: "ARENA_WRITE_ACCESS_TOKEN", token: "never-store-this" } } })).toThrow();
    expect(() => userConfigSchema.parse({ clients: { cli: "missing" } })).toThrow();
    expect(() => userConfigSchema.parse({ provenance: { remoteSnapshot: "full" } })).toThrow();
  });
  test("explicit missing/oversize config errors and absent default config stays disabled", async () => {
    const root = await directory();
    expect((await loadUserConfig(undefined, { HOME: root })).defaultChannel).toBeUndefined();
    await expect(loadUserConfig(join(root, "missing.json"))).rejects.toThrow();
    const file = join(root, "config.json"); await writeFile(file, " ".repeat(16_385));
    await expect(loadUserConfig(file)).rejects.toThrow("16 KiB");
  });
});

describe("source-preserving private snapshots", () => {
  test("retains exact nonsecret plan, recipe and source strings without claiming authenticated identity or rendered bytes", () => {
    const source = plan(); const saved = intent(source);
    expect(saved.snapshot.plan).toEqual(source);
    expect(saved.snapshot.authentication).toEqual({ credentialProfile: "shared", authenticatedAccountVerified: false });
    expect(saved.snapshot.initiator).toEqual({ kind: "human", identityBasis: "declared" });
    expect(saved.snapshot.fidelity).toMatchObject({ originalPlanPreserved: true, rawCommandCaptured: false, imageBytesIncluded: false, renderedIngredientsComplete: false });
    expect(saved.snapshotSha256).toBe(snapshotHash(saved.snapshot));
    expect(saved.remoteWriteImplemented).toBe(true); expect(saved.remoteQualification).toBe("existing_account_full_snapshot_fixtures");
    expect(saved.remoteMetadata).toBeUndefined();
  });
  test("declared input arguments are distinct from canonical plan references and are redacted before hashing", () => {
    const saved = prepareSaveIntent(plan(), config(), { origin: "cli", initiator: { kind: "unknown", identityBasis: "unknown" },
      inputSourceRefs: ["https://x.com/example/status/1?access_token=fixture-original-token"], inputDestinationArgs: ["https://www.are.na/example-user/remote-inbox"], force: true });
    expect(saved.snapshot.invocation.inputs.basis).toBe("declared_arguments");
    expect(saved.snapshot.invocation.force).toBe(true);
    expect(saved.snapshot.invocation.inputs.destinationArgs).toEqual(["https://www.are.na/example-user/remote-inbox"]);
    expect(JSON.stringify(saved)).not.toContain("fixture-original-token");
    expect(saved.snapshot.plan.sources[0]!.canonicalUrl).toBe("https://x.com/example/status/1");
    expect(saved.snapshot.redaction.paths).toContain("invocation.inputs.sourceRefs[0]");
  });
  test("changing caller objects or live-block text cannot change a written original snapshot", async () => {
    const source = plan(); const saved = intent(source); const root = await directory();
    const output = await writeSaveIntent(saved, root); const original = await readFile(join(output, "snapshot.json"), "utf8");
    source.block.markdown = "Changed live block";
    await writeSaveResult(output, { error: "Placement still pending" });
    expect(await readFile(join(output, "snapshot.json"), "utf8")).toBe(original);
    expect(JSON.parse(original).plan.block.markdown).not.toContain("Changed live block");
    await expect(writeSaveResult(output, { error: "overwrite" })).rejects.toThrow();
    if (process.platform !== "win32") {
      expect((await stat(output)).mode & 0o777).toBe(0o700);
      expect((await stat(join(output, "snapshot.json"))).mode & 0o777).toBe(0o600);
    }
  });
  test("a caller cannot race asynchronous file creation to change validated snapshot bytes", async () => {
    const root = await directory(), saved = intent(plan(), config("fallback", "full"));
    const writing = writeSaveIntent(saved, root);
    saved.snapshot.initiator = { kind: "automation", identityBasis: "declared" };
    saved.remoteMetadata!.ab_initiator_kind = "automation";
    const output = await writing;
    const original = JSON.parse(await readFile(join(output, "snapshot.json"), "utf8"));
    const envelope = JSON.parse(await readFile(join(output, "intent.json"), "utf8"));
    expect(original.initiator.kind).toBe("human");
    expect(envelope.remoteMetadata.ab_initiator_kind).toBe("human");
    expect(snapshotHash(original)).toBe(envelope.snapshotSha256);
  });
  test("tampered full chunks or summary identities reject before creating any bundle", async () => {
    const root = await directory();
    const full = intent(plan(), config("fallback", "full")); full.remoteMetadata!.ab_snapshot_00 = "tampered";
    await expect(writeSaveIntent(full, root)).rejects.toThrow("envelope does not match");
    const summary = intent(plan(), config("fallback", "summary")); summary.remoteMetadata!.ab_origin = "mcp-remote";
    await expect(writeSaveIntent(summary, root)).rejects.toThrow("envelope does not match");
    expect(await readdir(root)).toEqual([]);
  });
  test("cancelled bundles leave user files intact; a repeated save identity creates a separate owned snapshot", async () => {
    const root = await directory(); await writeFile(join(root, "mine.txt"), "kept");
    const abort = new AbortController(); abort.abort(new Error("cancelled"));
    await expect(writeSaveIntent(intent(), root, abort.signal)).rejects.toThrow("cancelled");
    expect(await readdir(root)).toEqual(["mine.txt"]);
    const first = await writeSaveIntent(intent(), root), second = await writeSaveIntent(intent(), root);
    expect(first).not.toBe(second);
    expect(await readFile(join(root, "mine.txt"), "utf8")).toBe("kept");
    expect((await readdir(root)).some(name => name.startsWith(".staging"))).toBe(false);
  });
  test("credential forms are redacted before hashing and redaction is disclosed", () => {
    const source = composePlan([{ provider: "x", id: "1", canonicalUrl: "https://x.com/example/status/1", author: { handle: "example" },
      text: "Bearer fixture-private-token\nLink https://private-user:private-pass@cdn.invalid/image?token=private-query",
      media: [{ ref: "1.1", kind: "image", url: "https://cdn.invalid/image?X-Amz-Signature=private-signature", width: 400, height: 300, alt: "source alt" }] }], { media: "all" });
    const saved = intent(source); const text = JSON.stringify(saved);
    for (const secret of ["fixture-private-token", "private-user", "private-pass", "private-query", "private-signature"]) expect(text).not.toContain(secret);
    expect(saved.snapshot.fidelity.originalPlanPreserved).toBe(false);
    expect(saved.snapshot.redaction.paths.length).toBeGreaterThan(0);
    expect(saved.snapshot.plan.hash).not.toBe(source.hash);
    expect(text).toContain("REDACTED");
    expect(source.sources[0]!.text).toContain("private-pass");
  });
  test("uppercase URLs, OAuth fragments, secret assignments and private credential paths are redacted", () => {
    const redacted = redactProvenance({ text: 'HTTPS://fixture-user:fixture-password@cdn.invalid/image?token=fixture-query#access_token=fixture-fragment\nARENA_WRITE_ACCESS_TOKEN="fixture-env"\n/Users/fixture/.aws/credentials' });
    for (const secret of ["fixture-user", "fixture-password", "fixture-query", "fixture-fragment", "fixture-env", "/Users/fixture/.aws/credentials"]) expect(redacted.value.text).not.toContain(secret);
    expect(redacted.paths).toEqual(["text"]);
  });
  test("a modified plan or modified prepared snapshot rejects before committing", async () => {
    const source = plan(); source.block.title = "changed";
    expect(() => intent(source)).toThrow("Plan hash");
    const prepared = intent(); prepared.snapshot.plan = structuredClone(prepared.snapshot.plan); prepared.snapshot.plan.block.title = "changed";
    const root = await directory(); await expect(writeSaveIntent(prepared, root)).rejects.toThrow("changed after preparation");
    expect(await readdir(root)).toEqual([]);
  });
  test("terminal unknown result preserves a creation attempt and redacts error credentials", async () => {
    const root = await directory(), saved = await writeSaveIntent(intent(), root);
    await writeSaveResult(saved, { attempt: { id: "attempt", planHash: plan().hash, destinations: ["90001"], status: "creation_unknown", createdAt: "2026-10-05T19:20:00Z" }, error: "Authorization: Bearer private-error-token" });
    const text = await readFile(join(saved, "result.json"), "utf8"), result = JSON.parse(text);
    expect(result.state).toBe("unknown"); expect(result.attempt.id).toBe("attempt");
    expect(result.saveId).toBe(intent().snapshot.saveId);
    expect(text).not.toContain("private-error-token"); expect(result.redactedPaths).toEqual(["error"]);
  });
  test("a missing response remains unknown instead of claiming no save", async () => {
    const root = await directory(), saved = await writeSaveIntent(intent(), root);
    await writeSaveResult(saved, { error: "ECONNRESET after request transmission" });
    expect(JSON.parse(await readFile(join(saved, "result.json"), "utf8")).state).toBe("unknown");
  });
});

describe("bounded scalar connection metadata", () => {
  test("full Unicode snapshot is losslessly reassembled with byte-bounded scalar chunks", () => {
    const saved = intent(plan("🧭漢字é ".repeat(350)), config("fallback", "full"));
    const metadata = saved.remoteMetadata!;
    expect(readProvenanceMetadata(metadata)).toEqual(saved.snapshot);
    for (const [key, value] of Object.entries(metadata)) {
      expect(key).toMatch(/^[A-Za-z0-9_]{1,40}$/);
      if (/^ab_snapshot_\d+$/.test(key)) {
        expect(Buffer.byteLength(String(value))).toBeLessThanOrEqual(1800);
        expect(String(value).length).toBeLessThanOrEqual(1900);
      }
    }
    expect(Buffer.byteLength(JSON.stringify(metadata))).toBeLessThanOrEqual(28_000);
    expect(Object.keys(metadata).length).toBeLessThanOrEqual(40);
  });
  test("oversize full records reject; explicit summary remains visibly incomplete", () => {
    const large = intent(plan("漢".repeat(8000)));
    expect(() => provenanceMetadata(large.snapshot, "full")).toThrow();
    const summary = provenanceMetadata(large.snapshot, "summary");
    expect(summary.ab_snapshot_complete).toBe(false);
    expect(Object.keys(summary).some(key => /^ab_snapshot_\d+$/.test(key))).toBe(false);
    expect(() => readProvenanceMetadata(summary)).toThrow("complete");
  });
  test("missing, tampered or mismatched chunks never claim faithful restoration", () => {
    const original = intent(plan(), config("fallback", "full")).remoteMetadata!;
    expect(() => readProvenanceMetadata({ ...original, ab_snapshot_00: "tampered" })).toThrow("checksum");
    const missing = { ...original }; delete missing.ab_snapshot_00;
    expect(() => readProvenanceMetadata(missing)).toThrow("Missing");
    expect(() => readProvenanceMetadata({ ...original, ab_save_id: "other" })).toThrow("identity");
    expect(() => readProvenanceMetadata({ ...original, ab_origin: "mcp-remote" })).toThrow("identity");
    const forged = structuredClone(intent().snapshot) as any; forged.authentication.authenticatedAccountVerified = true; delete forged.routing;
    expect(() => provenanceMetadata(forged, "full")).toThrow();
  });
  test("flat types, finite numbers, key, count, per-string and UTF-8 limits are enforced", () => {
    for (const invalid of [{ "bad-key": "x" }, { ["a".repeat(41)]: true }, { x: null }, { x: [] }, { x: {} }, { x: Infinity }, { x: "é".repeat(2001) }, Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`k${i}`, true])), Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, "🧭".repeat(1000)]))]) expect(() => validateMetadata(invalid)).toThrow();
    expect(() => validateMetadata({ x: "x".repeat(2000), n: 3, b: true })).not.toThrow();
  });
  test("merge preserves unrelated keys, null deletes, and resulting overflow rejects", () => {
    expect(mergedMetadata({ unrelated: "kept", old: true }, { old: null, status: "complete" })).toEqual({ unrelated: "kept", status: "complete" });
    const current = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, true]));
    expect(() => mergedMetadata(current, { added: true })).toThrow("50 keys");
    const special = JSON.parse('{"__proto__":"scalar"}');
    expect(mergedMetadata({}, special).__proto__).toBe("scalar");
    expect({}.toString).toBe(Object.prototype.toString);
  });
  test("same save replay preserves its snapshot while a different save cannot replace it", () => {
    const proposed = intent(plan(), config("fallback", "full")).remoteMetadata!;
    expect(initialProvenancePatch({ unrelated: "kept" }, proposed)).toEqual(proposed);
    expect(initialProvenancePatch({ ...proposed, unrelated: "kept" }, proposed)).toEqual(proposed);
    expect(() => initialProvenancePatch({ ...proposed, ab_save_id: "earlier-save" }, proposed)).toThrow("must not be overwritten");
    expect(() => initialProvenancePatch({ ...proposed, ab_snapshot_sha256: "different" }, proposed)).toThrow("must not be overwritten");
    const summary = provenanceMetadata(intent().snapshot, "summary");
    expect(() => initialProvenancePatch(proposed, summary)).toThrow("encoding must not be replaced");
  });
});

describe("official v3 placement adapter, mocked only", () => {
  test("structured channels hold inbox-only provenance and response IDs are not zipped to channels", async () => {
    const calls: Array<{ url: string; body: any }> = [];
    const client = new ArenaClient("fixture-only", "https://fixture.invalid/v3", async (input, init) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return Response.json({ data: [{ id: 900 }, { id: 800 }] }, { status: 201 });
    });
    const result = await client.connectWithMetadata(123, [{ id: 90001, metadata: { ab_save_id: "save" } }, { id: 42 }]);
    expect(calls[0]!.body).toEqual({ connectable_id: 123, connectable_type: "Block", channels: [{ id: 90001, metadata: { ab_save_id: "save" } }, { id: 42 }] });
    expect(calls[0]!.body.channel_ids).toBeUndefined();
    expect(result).toEqual([{ id: 900 }, { id: 800 }]);
    expect(result.every(connection => connection.channelId === undefined)).toBe(true);
  });
  test("invalid creation metadata/cap rejects before any network call", async () => {
    let calls = 0;
    const client = new ArenaClient("fixture-only", "https://fixture.invalid", async () => { calls++; return Response.json({}); });
    await expect(client.connectWithMetadata(123, [{ id: 90001, metadata: { long: "x".repeat(2001) } }])).rejects.toThrow();
    await expect(client.connectWithMetadata(123, Array.from({ length: 21 }, (_, i) => ({ id: i + 1 })))).rejects.toThrow();
    await expect(client.connectWithMetadata(123, [{ id: "0" }])).rejects.toThrow();
    await expect(client.connectWithMetadata(123, [{ id: 42 }, { id: "042" }])).rejects.toThrow("Duplicate");
    await expect(client.connectWithMetadata(123, [{ id: "9007199254740993" }])).rejects.toThrow();
    await expect(client.channelIds(["9007199254740993"])).rejects.toThrow();
    expect(calls).toBe(0);
  });
  test("slug and numeric aliases resolve to one numeric channel ID", async () => {
    const client = new ArenaClient("fixture-only", "https://fixture.invalid", async () => Response.json({ id: 90001 }));
    expect(await client.channelIds(["remote-inbox", "90001"])).toEqual([90001]);
  });
  test("update reads existing keys first and sends a merge patch with null deletion", async () => {
    const calls: Array<{ method?: string; body?: any }> = [];
    const client = new ArenaClient("fixture-only", "https://fixture.invalid", async (_input, init) => {
      calls.push({ method: init?.method, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      return Response.json({ id: 77, metadata: { unrelated: "kept", old: true } });
    });
    await client.updateConnectionMetadata(77, { old: null, ab_status: "complete" });
    expect(calls).toEqual([{ method: "GET" }, { method: "PUT", body: { metadata: { old: null, ab_status: "complete" } } }]);
  });
  test("overflow of existing metadata permits read but prevents mutation", async () => {
    const methods: string[] = [];
    const client = new ArenaClient("fixture-only", "https://fixture.invalid", async (_input, init) => {
      methods.push(init?.method!); return Response.json({ id: 77, metadata: Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, true])) });
    });
    await expect(client.updateConnectionMetadata(77, { added: true })).rejects.toThrow("50 keys");
    expect(methods).toEqual(["GET"]);
  });
});
