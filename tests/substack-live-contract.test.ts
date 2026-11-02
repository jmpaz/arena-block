import { expect, test } from "bun:test";
import { createContext, runInContext } from "node:vm";
import { readFile } from "node:fs/promises";
import { createDocument } from "@mixmark-io/domino";
import { readSubstackPage } from "../packages/core/substack-page.ts";
import { normalizeSubstackCapture } from "../packages/core/substack-record.ts";
import { resolveCapture } from "../extension/src/core.ts";
import { composePlan } from "../packages/core/compose.ts";
import { SocialResolver } from "../packages/core/providers/index.ts";
import { SubstackProvider } from "../packages/core/providers/substack.ts";
import { compositionPolicySchema } from "../packages/core/types.ts";
import {
  assertContract, classifyFailure, digest, fixtureDirectory, fixtureFetch, liveFetch, loadCatalog, loadResponses, projectContract,
  resolveContract, SubstackContractError, type RequestEvidence,
} from "../scripts/check-substack-contracts.ts";

const catalog = await loadCatalog();
for (const contract of catalog.cases) test(`real Substack contract ${contract.id}: ${contract.title}`, async () => {
  const fetcher = await fixtureFetch();
  for (const url of [contract.url, ...contract.variants]) assertContract(await resolveContract(contract, fetcher, url), contract);
});

test("CLI/service SocialResolver matches the helper source projection for all real cases", async () => {
  for (const contract of catalog.cases) {
    const capture = contract.retainedFile ? JSON.parse(await readFile(new URL(contract.retainedFile, fixtureDirectory), "utf8")) : undefined;
    const policy = compositionPolicySchema.parse({ threadExpansion: "off", quoteDepth: 8, media: "all" });
    const result = await new SocialResolver({ substack: new SubstackProvider(capture ? [capture] : [], await fixtureFetch()) }).resolveComposition([contract.url], [], policy);
    assertContract(composePlan(result.posts, result.policy), contract);
  }
});

test("sanitized response corpus pins acquisition provenance and exact bytes without running unrelated bootstrap scripts", async () => {
  const responses = await loadResponses();
  expect(responses.length).toBeGreaterThanOrEqual(20);
  for (const fixture of responses) {
    const raw = await readFile(new URL(fixture.file, fixtureDirectory), "utf8");
    expect(digest(raw)).toBe(fixture.sha256); expect(Buffer.byteLength(raw)).toBe(fixture.bytes);
    expect(fixture.provenance.inputSHA256).toMatch(/^[a-f0-9]{64}$/);
    if (fixture.contentType === "text/html") {
      const doc = createDocument(raw);
      expect(doc.querySelectorAll("script:not([type='application/ld+json'])").length).toBe(0);
      expect(doc.querySelectorAll('[class*="feedPermalinkUnit-"]').length).toBe(1);
    }
  }
  const missingQuote = catalog.cases.find(value => value.id === "360829302")!;
  const lam = missingQuote.expected.nodes.find(value => value.id === "359890078")!;
  expect(lam.bodyText).toContain("destructive policies that foreclose human potential.");
  expect(lam.bodyText).toContain("US GDP growth in ~2% range");
  expect(lam.links).toContainEqual({ kind: "video", role: "linked", url: "https://www.youtube.com/watch?v=1u5qMZvd6ps" });
  expect(lam.media).toEqual([]); // Linked video is not acquired native audio/video.
});

test("actual public response contracts survive the serialized browser/Safari reader with the same helper projection", async () => {
  const responses = await loadResponses();
  for (const contract of catalog.cases.filter(value => value.fixtureMode === "public-responses")) {
    const source = responses.find(value => value.url === contract.url)!;
    const fetcher = await fixtureFetch();
    const html = await readFile(new URL(source.file, fixtureDirectory), "utf8");
    const context = createContext({ document: createDocument(html), location: { href: contract.variants[0] }, URL, TextDecoder, Uint8Array,
      AbortController, setTimeout, clearTimeout, fetch: fetcher, DOMParser: class { parseFromString(value: string) { return createDocument(value); } } });
    const capture = normalizeSubstackCapture(await runInContext(`(${readSubstackPage.toString()})()`, context));
    const plan = await resolveCapture({ primary: [contract.url], extras: [], policy: { threadExpansion: "off", quoteDepth: 8, media: "all" }, substackCaptures: [capture] }, undefined, fetcher);
    assertContract(plan, contract);
  }
});

test("every deterministic real-source contract matches the checked-in native bundled resolver", async () => {
  const bundle = await readFile(new URL("../ios/Sources/CaptureRuntime/Resources/capture-core.js", import.meta.url), "utf8");
  for (const contract of catalog.cases) {
    const fetcher = await fixtureFetch();
    const retained = contract.retainedFile ? JSON.parse(await readFile(new URL(contract.retainedFile, fixtureDirectory), "utf8")) : undefined;
    let finish!: (output: { result: string | null; error: string | null }) => void;
    const done = new Promise<{ result: string | null; error: string | null }>(resolve => { finish = resolve; });
    const context = createContext({ nativeSHA256: digest, setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms).unref(), clearTimeout, nativeCancelHTTP: () => {},
      nativeHTTP: (id: number, raw: string) => {
        const request = JSON.parse(raw);
        void fetcher(request.url, { credentials: "omit" }).then(async response => {
          context.captureHTTPComplete(id, JSON.stringify({ status: response.status, url: request.url, headers: { "content-type": response.headers.get("content-type") }, body: await response.text() }));
        }).catch(error => context.captureHTTPComplete(id, JSON.stringify({ error: String(error) })));
      }, nativeResolveComplete: (_id: string, result: string | null, error: string | null) => finish({ result, error }) });
    runInContext(bundle, context);
    // Normal native entry point accepts the same retained records as Safari.
    context.captureResolve("contract-" + contract.id, JSON.stringify([contract.url]), JSON.stringify({ threadExpansion: "off", quoteDepth: 8, media: "all" }), "false", "[]", "[]", retained ? JSON.stringify([retained]) : "[]");
    const output = await done;
    expect(output.error, contract.id).toBeNull();
    assertContract(JSON.parse(output.result!).plan, contract);
  }
}, 30_000);

test("truncated, ambiguous and changed-writing real-response negatives fail clearly", async () => {
  const negatives = JSON.parse(await readFile(new URL("negative-cases.json", fixtureDirectory), "utf8"));
  for (const negative of negatives.filter((value: any) => value.file)) {
    const contract = catalog.cases.find(value => value.id === negative.case)!;
    const raw = await readFile(new URL(negative.file, fixtureDirectory), "utf8");
    const error: any = await resolveContract(contract, await fixtureFetch(new Map([[negative.url, raw]]))).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    if (negative.expected === "collapsed preview") expect(error.message).toContain("collapsed preview");
    else expect(error.cause?.reason).toBe(negative.expected);
  }
});

test("complete root plus an unavailable quoted source never counts as full contract success", async () => {
  const contract = catalog.cases.find(value => value.id === "360337718")!;
  const plan = await resolveContract(contract, await fixtureFetch(new Map([["https://substack.com/@joodaloop/note/c-357819575", { status: 404, body: "Not found" }]])));
  expect(plan.sources[0]!.text).toContain("keeping the density theme going");
  expect(() => assertContract(plan, contract)).toThrow("Incomplete quoted body");
});

test("a valid edited/truncated body cannot pass merely because HTTP and schema succeed", async () => {
  const contract = catalog.cases.find(value => value.id === "346876542")!;
  const source = structuredClone((await resolveContract(contract, await fixtureFetch())).sources[0]!);
  source.text = "Shortened body"; source.substackCapture!.note.body.html = "<p>Shortened body</p>";
  const changed = composePlan([source], { threadExpansion: "off", quoteDepth: 8, media: "all" });
  const error = (() => { try { assertContract(changed, contract); } catch (error) { return error; } })() as SubstackContractError;
  expect(error.category).toBe("content-drift"); expect(error.differences).toContain("nodes.0.bodySHA256");
});

test("fixture contracts pin media roles and independent article authors, not nonempty parse counts", () => {
  const byId = (id: string) => catalog.cases.find(value => value.id === id)!.expected;
  expect(byId("362104813").nodes[0]!.bodyText).toBe("");
  expect(byId("362104813").nodes[0]!.media).toMatchObject([{ kind: "image", sourceRole: "original", url: "https://substack-post-media.s3.amazonaws.com/public/images/9fc436fc-78b9-407e-9a44-70f18500a27d_1448x1086.png" }]);
  expect(byId("359359118").nodes[0]!.media).toMatchObject([{ kind: "video", acquisition: "substack-public-original", url: "https://substack.com/api/v1/video/upload/9681d26c-5e44-4f6e-bd53-679694ab6da6/src?type=mp4" }]);
  expect(byId("311363713").nodes[0]!.author.handle).toBe("evadmartain");
  expect(byId("311363713").nodes[0]!.media).toMatchObject([{ kind: "audio", sourceAttribution: { kind: "substack-podcast", authors: ["Hamish McKenzie"], url: "https://on.substack.com/p/transcription" } }]);
  expect(byId("337896966").nodes[0]!.attachments).toMatchObject([{ kind: "article", authors: [{ name: "SOFSET" }], selection: { startParagraph: 32, endParagraph: 33, isAutoSelection: false } }]);
  expect(byId("348712218").nodes.map(value => value.id)).toEqual(["348712218", "347044458", "346876542"]);
  expect(byId("360337718").nodes[0]!.text).toContain("http://nicochilla.com");
});

test("live failures distinguish observed HTTP availability/access/network from content and parser drift", () => {
  const evidence = (status: number): RequestEvidence[] => [{ url: "https://substack.com/note/c-1", status, observedAt: "2026-10-16T00:00:00Z" }];
  expect(classifyFailure(Error("404"), evidence(404))).toBe("source-unavailable");
  expect(classifyFailure(Error("403"), evidence(403))).toBe("access-restricted");
  expect(classifyFailure(Error("429"), evidence(429))).toBe("rate-limited");
  expect(classifyFailure(Error("503"), evidence(503))).toBe("upstream-service");
  expect(classifyFailure(Error("DNS"), [{ url: "url", observedAt: "time", error: "DNS" }])).toBe("network");
  expect(classifyFailure(new SubstackContractError("content-drift", "edited body"), evidence(200))).toBe("content-drift");
  expect(classifyFailure(Error("schema or mismatch"), evidence(200))).toBe("parser-contract");
  expect(classifyFailure(Object.assign(Error("missing"), { cause: { reason: "selected_root_count" } }), evidence(200))).toBe("source-shape-or-availability");
  expect(classifyFailure(Error("request budget 2 reached"), [])).toBe("request-budget");
});

test("live reader rejects media/foreign/authenticated requests before network access", async () => {
  const live = liveFetch(1, 0);
  for (const url of ["https://substack.com/api/v1/audio/upload/id/src", "https://substack.com/api/v1/video/upload/9681d26c-5e44-4f6e-bd53-679694ab6da6/src", "https://cdn.example/video.mp4", "https://user:secret@substack.com/note/c-1"]) {
    await expect(live.fetcher(url, { credentials: "omit" })).rejects.toThrow("Unapproved");
  }
  await expect(live.fetcher("https://substack.com/note/c-1", { credentials: "include" })).rejects.toThrow("never use credentials");
  expect(live.evidence).toHaveLength(0);
});


test("manual live transport serializes requests, reuses response evidence and enforces its request limit", async () => {
  let active = 0, maximum = 0; const requests: string[] = [];
  const transport = (async (input: RequestInfo | URL) => {
    requests.push(String(input)); active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 2)); active--;
    return new Response("public fixture", { status: 200, headers: { "content-type": "text/html" } });
  }) as typeof fetch;
  const live = liveFetch(2, 1, transport), first = "https://substack.com/note/c-1", second = "https://substack.com/note/c-2";
  await Promise.all([live.fetcher(first, { credentials: "omit" }), live.fetcher(second, { credentials: "omit" }), live.fetcher(first, { credentials: "omit" })]);
  expect(maximum).toBe(1); expect(requests).toEqual([first, second]); expect(live.evidence).toHaveLength(2); expect(live.accesses).toHaveLength(3);
  await expect(live.fetcher("https://substack.com/note/c-3", { credentials: "omit" })).rejects.toThrow("request budget");
  expect(requests).toHaveLength(2);
});
