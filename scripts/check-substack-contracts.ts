/** Read-only, manual Substack source contracts. Importing this file never fetches. */
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createDocument } from "@mixmark-io/domino";
import { resolveCapture } from "../extension/src/core.ts";
import { blockPlanSchema, type BlockPlan, type ResolvedPost } from "../packages/core/types.ts";
import type { SubstackNote } from "../packages/core/substack-record.ts";

export const fixtureDirectory = new URL("../tests/fixtures/substack-contracts/", import.meta.url);
export type ResponseFixture = {
  url: string; file: string; contentType: string; status: number; sha256: string; bytes: number;
  provenance: { inputFixture: string; inputSHA256: string; originalResponseSHA256: string | null; observedAt: string | null; projection: string };
};
export type ContractCase = {
  id: string; title: string; url: string; variants: string[]; fixtureMode: "public-responses" | "retained-record";
  retainedFile?: string; maxRequests: number; expected: ContractProjection; limitations?: string[];
};
export type ContractProjection = {
  canonicalSource: string; kind: string; selectedMedia: string[];
  nodes: Array<{ id: string; url: string; author: ResolvedPost["author"]; bodyText: string; bodySHA256: string; text: string;
    links: unknown[]; media: unknown[]; attachments: unknown[] }>;
};
export type ContractCatalog = { version: 1; cases: ContractCase[]; receivingWitness: { block: string; captureId: string; noteId: string; scope: string } };
export const digest = (text: string) => createHash("sha256").update(text).digest("hex");
export const normalizedText = (text: string) => text.replace(/\s+/gu, " ").trim();
const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value && typeof value === "object"
  ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== "observedAt").sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, stable(child)])) : value;

export async function loadCatalog(): Promise<ContractCatalog> {
  const catalog = JSON.parse(await readFile(new URL("catalog.json", fixtureDirectory), "utf8")) as ContractCatalog;
  if (catalog.version !== 1 || !Array.isArray(catalog.cases) || new Set(catalog.cases.map(value => value.id)).size !== catalog.cases.length) throw Error("Invalid Substack contract catalog");
  return catalog;
}
export async function loadResponses(): Promise<ResponseFixture[]> {
  return JSON.parse(await readFile(new URL("responses.json", fixtureDirectory), "utf8")).responses;
}
export async function fixtureFetch(overrides = new Map<string, string | { status: number; body: string }>()): Promise<typeof fetch> {
  const responses = new Map<string, { fixture: ResponseFixture; text: string }>();
  for (const fixture of await loadResponses()) {
    const text = await readFile(new URL(fixture.file, fixtureDirectory), "utf8");
    if (digest(text) !== fixture.sha256 || Buffer.byteLength(text) !== fixture.bytes) throw Error(`Fixture integrity failed: ${fixture.file}`);
    responses.set(fixture.url, { fixture, text });
  }
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input), record = responses.get(url);
    if (init?.credentials !== "omit") throw Error("Contract fetch must omit credentials");
    // Aliases exercise URL parsing, not a fabricated second DOM response.
    const match = /\/note\/c-(\d+)$/.exec(url);
    const selected = record ?? (match ? [...responses.values()].find(value => value.fixture.url.endsWith(`/note/c-${match[1]}`)) : undefined);
    if (!selected) throw Error(`Uncaptured source request: ${url}`);
    const replacement = overrides.get(url) ?? overrides.get(selected.fixture.url);
    const text = typeof replacement === "string" ? replacement : replacement?.body ?? selected.text;
    return new Response(text, { status: typeof replacement === "object" ? replacement.status : selected.fixture.status, headers: { "content-type": selected.fixture.contentType } });
  }) as typeof fetch;
}

export function projectContract(plan: BlockPlan): ContractProjection {
  blockPlanSchema.parse(plan);
  if (plan.sources.length !== 1) throw Error("Contract expects exactly one selected root Note");
  const root = plan.sources[0]!;
  let post: ResolvedPost | undefined = root, note: SubstackNote | undefined = root.substackCapture?.note;
  const nodes: ContractProjection["nodes"] = [];
  while (post && note) {
    if (note.body.status !== "complete") throw Error(`Incomplete authored body for Note ${post.id}`);
    if (post.quoteBoundary || note.quote && !note.quote.expanded) throw Error(`Incomplete quoted body after Note ${post.id}: ${post.quoteBoundary?.status ?? note.quote?.status ?? "unavailable"}`);
    const bodyText = normalizedText(createDocument(`<html><body>${note.body.html}</body></html>`).body.textContent ?? "");
    nodes.push({ id: post.id, url: post.canonicalUrl, author: post.author, bodyText, bodySHA256: digest(bodyText), text: post.text,
      links: stable(note.links) as unknown[], media: stable(post.media.map(({ ref, alt, ...media }) => ({ ref, alt, ...media }))) as unknown[],
      attachments: stable(note.attachmentEvidence?.attachments ?? []) as unknown[] });
    post = post.quote; note = note.quote?.expanded;
  }
  if (post || note) throw Error("Resolved quote tree and retained full source tree disagree");
  return { canonicalSource: plan.block.canonicalSource, kind: plan.block.kind, selectedMedia: plan.block.selectedMedia, nodes };
}

export class SubstackContractError extends Error {
  constructor(public readonly category: "content-drift" | "incomplete-quote" | "render-contract", message: string, public readonly differences: string[] = []) { super(message); }
}
function differences(actual: unknown, expected: unknown, path = "", results: string[] = []): string[] {
  if (JSON.stringify(stable(actual)) === JSON.stringify(stable(expected))) return results;
  if (actual && expected && typeof actual === "object" && typeof expected === "object" && Array.isArray(actual) === Array.isArray(expected)) {
    for (const key of new Set([...Object.keys(actual), ...Object.keys(expected)])) differences((actual as any)[key], (expected as any)[key], path ? `${path}.${key}` : key, results);
  } else results.push(path);
  return results;
}
export function assertContract(plan: BlockPlan, contract: ContractCase): ContractProjection {
  let projection: ContractProjection;
  try { projection = projectContract(plan); }
  catch (error) {
    if (String(error).includes("Incomplete quoted body")) throw new SubstackContractError("incomplete-quote", String(error));
    throw error;
  }
  const changed = differences(projection, contract.expected);
  if (changed.length) throw new SubstackContractError("content-drift", `Substack contract ${contract.id} changed: ${changed.join(", ")}`, changed);
  // Body text and attachment roles are pinned above independently of Markdown
  // presentation. Check the actual composed payload retains each full source's
  // writing and that quotations precede their containing author's writing.
  const unquote = (text: string) => normalizedText(text.replace(/^(?:[ \t]*>[ \t]*)+/gm, ""));
  const rendered = unquote(plan.block.markdown);
  let previous = -1;
  for (const node of [...projection.nodes].reverse()) {
    const text = unquote(node.text);
    if (!text) continue; // The image-only contract pins explicit empty prose.
    const at = rendered.indexOf(text);
    if (at < 0 || at < previous) throw new SubstackContractError("render-contract", `Full source writing is missing or out of order in rendered Markdown: ${node.id}`);
    previous = at;
  }
  return projection;
}
export async function resolveContract(contract: ContractCase, fetcher: typeof fetch, url = contract.url): Promise<BlockPlan> {
  const capture = contract.retainedFile ? JSON.parse(await readFile(new URL(contract.retainedFile, fixtureDirectory), "utf8")) : undefined;
  return resolveCapture({ primary: [url], extras: [], policy: { threadExpansion: "off", quoteDepth: 8, media: "all" }, ...(capture ? { substackCaptures: [capture] } : {}) }, undefined, fetcher);
}

export type RequestEvidence = { url: string; status?: number; contentType?: string; bytes?: number; sha256?: string; observedAt: string; error?: string };
export type FailureCategory = "network" | "access-restricted" | "rate-limited" | "source-unavailable" | "upstream-service" | "content-drift" | "incomplete-quote" | "render-contract" | "parser-contract" | "source-shape-or-availability" | "request-budget";
export function classifyFailure(error: unknown, requests: RequestEvidence[]): FailureCategory {
  if (requests.some(value => value.status === 429)) return "rate-limited";
  if (requests.some(value => [401, 403].includes(value.status ?? 0))) return "access-restricted";
  if (requests.some(value => [404, 410].includes(value.status ?? 0))) return "source-unavailable";
  if (requests.some(value => (value.status ?? 0) >= 500)) return "upstream-service";
  if (/request budget|byte budget|exceeds 2 MiB/.test(String(error))) return "request-budget";
  if (requests.some(value => value.error)) return "network";
  if (error instanceof SubstackContractError) return error.category;
  const cause = (error as Error & { cause?: { reason?: string } })?.cause;
  // A 200 page with no selected source can be a new unavailable/private page,
  // not necessarily a parser bug. Preserve the ambiguity instead of guessing.
  if (["selected_root_count", "missing_text_container"].includes(cause?.reason ?? "")) return "source-shape-or-availability";
  return "parser-contract";
}

/** One sequential in-memory response cache shared across all requested cases. */
export function liveFetch(maxRequests: number, intervalMs = 1000, transport: typeof fetch = fetch) {
  const cache = new Map<string, Promise<{ body: string; status: number; headers: Headers; evidence: RequestEvidence }>>();
  const evidence: RequestEvidence[] = [], accesses: RequestEvidence[] = [];
  let queue = Promise.resolve();
  let lastRequest = 0, totalBytes = 0;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input), address = new URL(url);
    if (init?.credentials !== "omit") throw Error("Live contracts never use credentials");
    if (address.protocol !== "https:" || address.username || address.password || !["substack.com", "on.substack.com"].includes(address.hostname)
      || !(/^\/(?:(?:@[a-zA-Z0-9_]+|profile\/[1-9]\d*(?:-[a-zA-Z0-9_-]+)?)\/)?note\/c-[1-9]\d*\/?$/.test(address.pathname)
        || /^\/api\/v1\/reader\/comment\/[1-9]\d*$/.test(address.pathname)
        || /^\/api\/v1\/posts\/[a-zA-Z0-9_-]+$/.test(address.pathname)
        || /^\/api\/v1\/video\/upload\/[a-f0-9-]{36}$/.test(address.pathname))) throw Error(`Unapproved contract source URL: ${url}`);
    let pending = cache.get(url);
    if (!pending) {
      if (cache.size >= maxRequests) throw Error(`Substack request budget ${maxRequests} reached`);
      pending = queue.then(async () => {
        const wait = Math.max(0, lastRequest + intervalMs - Date.now());
        if (wait) await new Promise(resolve => setTimeout(resolve, wait));
        lastRequest = Date.now();
        const record: RequestEvidence = { url, observedAt: new Date().toISOString() }; evidence.push(record);
        try {
          const response = await transport(url, { ...init, credentials: "omit", redirect: init?.redirect ?? "manual", signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(20_000)]) });
          record.status = response.status; record.contentType = response.headers.get("content-type") ?? "";
          if (Number(response.headers.get("content-length")) > 2 * 1024 * 1024) { await response.body?.cancel(); throw Error("Contract source exceeds 2 MiB"); }
          const chunks: Uint8Array[] = []; let bytes = 0; const reader = response.body?.getReader();
          try { if (reader) while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; totalBytes += part.value.byteLength;
            if (bytes > 2 * 1024 * 1024 || totalBytes > 32 * 1024 * 1024) throw Error("Contract response acquisition exceeds byte budget"); chunks.push(part.value); } }
          finally { if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); } }
          const joined = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
          const body = new TextDecoder().decode(joined); record.bytes = bytes; record.sha256 = digest(body);
          return { body, status: response.status, headers: response.headers, evidence: record };
        } catch (error) { record.error = String(error); throw error; }
      });
      queue = pending.then(() => {}, () => {});
      cache.set(url, pending);
    }
    try {
      const value = await pending; accesses.push(value.evidence);
      return new Response(value.body, { status: value.status, headers: value.headers });
    } catch (error) {
      const failed = evidence.find(value => value.url === url);
      if (failed) accesses.push(failed);
      throw error;
    }
  }) as typeof fetch;
  return { fetcher, evidence, accesses };
}

async function main() {
  const args = process.argv.slice(2), catalog = await loadCatalog();
  const value = (name: string) => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
  const known = new Set(["--live", "--case", "--max-requests", "--output", "--help"]);
  for (let index = 0; index < args.length; index++) { const arg = args[index]!; if (!known.has(arg)) throw Error(`Unknown option ${arg}`); if (["--case", "--max-requests", "--output"].includes(arg)) { if (!args[++index] || args[index]!.startsWith("--")) throw Error(`${arg} needs a value`); } }
  const ids = value("--case")?.split(","), cases = catalog.cases.filter(item => !ids || ids.includes(item.id));
  if (ids?.some(id => !cases.some(item => item.id === id))) throw Error("Unknown Substack contract case");
  const budget = Number(value("--max-requests") ?? 48);
  if (!Number.isInteger(budget) || budget < 1 || budget > 64) throw Error("--max-requests must be 1–64");
  if (!args.includes("--live") || args.includes("--help")) {
    console.log("Read-only public Substack contract check. No save, credentials, media download or automatic schedule.\nRun: bun scripts/check-substack-contracts.ts --live [--case ID,ID] [--max-requests 48] [--output /tmp/result.json]\nWithout --live, only this request plan is printed.");
    console.log(JSON.stringify({ maxRequests: budget, minimumIntervalMs: 1000, cases: cases.map(({ id, title, url, fixtureMode, maxRequests }) => ({ id, title, url, fixtureMode, estimatedRequests: maxRequests })), estimatedUncachedRequests: cases.reduce((count, item) => count + item.maxRequests, 0), mediaDownloads: 0 }, null, 2));
    return;
  }
  const live = liveFetch(budget), results: unknown[] = [];
  for (const contract of cases) {
    const started = live.accesses.length;
    try {
      // Live always reacquires the actual URL, even for a retained-record
      // deterministic case. A replay can never count as a live source pass.
      const plan = await resolveContract({ ...contract, retainedFile: undefined }, live.fetcher);
      const projection = assertContract(plan, contract);
      results.push({ id: contract.id, url: contract.url, status: "pass", projection, plan, planSHA256: digest(JSON.stringify(plan)), requests: live.accesses.slice(started) });
      console.error(`${contract.id}: pass`);
    } catch (error) {
      const requests = live.accesses.slice(started), category = classifyFailure(error, requests);
      results.push({ id: contract.id, url: contract.url, status: "fail", category, message: String(error), cause: (error as Error)?.cause ?? null,
        differences: error instanceof SubstackContractError ? error.differences : [], requests });
      console.error(`${contract.id}: ${category}: ${String(error)}`);
      if (["rate-limited", "access-restricted", "request-budget", "network"].includes(category)) break;
    }
  }
  const report = { schema: "arena-block/substack-live-contracts", version: 1, observedAt: new Date().toISOString(), readOnly: true, requestBudget: budget,
    requests: live.evidence, results, unrun: cases.filter(item => !results.some((value: any) => value.id === item.id)).map(item => item.id),
    caveat: "Content drift may be a legitimate edit. A 200 source-shape-or-availability failure needs human review; it does not prove a parser regression or upstream deletion. No media bytes were downloaded." };
  const output = value("--output"); if (output) { const path = resolve(output); await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(report, null, 2) + "\n"); }
  else console.log(JSON.stringify(report, null, 2));
  if (report.unrun.length || results.some((value: any) => value.status !== "pass")) process.exitCode = 1;
}
if (import.meta.main) await main();
