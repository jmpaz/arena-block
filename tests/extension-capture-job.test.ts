import { expect, test } from "bun:test";
import { CaptureJobRunner, type CaptureJob, type CaptureJobServices } from "../extension/src/capture-job.ts";
import { resolveCapture } from "../extension/src/core.ts";
import type { BrowserSaveIntent } from "../extension/src/browser-save.ts";

async function fixture() {
  const input = { primary: ["https://example.com/queued"], extras: [], policy: {} };
  const plan = await resolveCapture(input);
  const jobs = new Map<string, CaptureJob>();
  const store = { async get(id: string) { return jobs.get(id); },
    async put(job: CaptureJob) { jobs.set(job.saveId, structuredClone(job)); } };
  const original: CaptureJob = { saveId: "00000000-0000-4000-8000-000000000001",
    input, destinations: ["test-channel"], phase: "queued" };
  await store.put(original);
  let createCalls = 0;
  let phase: BrowserSaveIntent["phase"] = "prepared";
  const browserIntent = (): BrowserSaveIntent => ({ saveId: original.saveId, accountId: 7, plan,
    destinations: original.destinations, channelIds: [17], phase });
  const services: CaptureJobServices = {
    resolve: async () => plan,
    browserAvailable: async () => true,
    nativeAvailable: async () => false,
    browserPrepare: async () => browserIntent(),
    browserCreate: async () => { createCalls++; phase = "saved"; return browserIntent(); },
    browserCheck: async () => browserIntent(),
    nativeSave: async () => ({ phase: "running" }),
    nativeRetry: async () => ({ phase: "running" }),
    nativeStatus: async () => ({ phase: "saved" }),
  };
  return { original, jobs, store, services, plan, get createCalls() { return createCalls; },
    setPhase(next: BrowserSaveIntent["phase"]) { phase = next; } };
}

test("a queued source resolves and freezes its save once", async () => {
  const f = await fixture();
  const runner = new CaptureJobRunner(f.store, f.services);
  expect((await runner.run(f.original.saveId)).phase).toBe("saved");
  expect(f.jobs.get(f.original.saveId)?.plan?.hash).toBe(f.plan.hash);
  expect((await runner.run(f.original.saveId)).phase).toBe("saved");
  expect(f.createCalls).toBe(1);
});

test("a queued source keeps explicit title and text edits after resolution", async () => {
  const f = await fixture();
  await f.store.put({ ...f.original, edits: { title: "My title", markdown: "My notes" } });
  let preparedTitle = "", preparedText = "";
  const runner = new CaptureJobRunner(f.store, { ...f.services,
    browserPrepare: async (id, plan, destinations) => {
      preparedTitle = plan.block.title;
      preparedText = plan.block.markdown;
      return f.services.browserPrepare(id, plan, destinations);
    },
  });
  expect((await runner.run(f.original.saveId)).phase).toBe("saved");
  expect(preparedTitle).toBe("My title");
  expect(preparedText).toBe("My notes");
});

test("resolution interrupted before any write can resume from the frozen source", async () => {
  const f = await fixture();
  const interrupted = new CaptureJobRunner(f.store, { ...f.services,
    resolve: async () => new Promise<typeof f.plan>(() => {}) });
  void interrupted.run(f.original.saveId);
  for (let i = 0; i < 20 && f.jobs.get(f.original.saveId)?.phase !== "resolving"; i++) await Promise.resolve();
  expect(f.jobs.get(f.original.saveId)?.phase).toBe("resolving");
  expect((await new CaptureJobRunner(f.store, f.services).run(f.original.saveId)).phase).toBe("saved");
  expect(f.createCalls).toBe(1);
});

test("a fresh runner checks an interrupted create without sending a second POST", async () => {
  const f = await fixture();
  let attempts = 0;
  const interrupted = new CaptureJobRunner(f.store, { ...f.services,
    browserCreate: async () => { attempts++; f.setPhase("creating"); return new Promise<BrowserSaveIntent>(() => {}); } });
  void interrupted.run(f.original.saveId);
  for (let i = 0; i < 30 && attempts !== 1; i++) await Promise.resolve();
  expect(f.jobs.get(f.original.saveId)?.phase).toBe("creating");
  expect(attempts).toBe(1);
  f.setPhase("unknown");
  expect((await new CaptureJobRunner(f.store, f.services).run(f.original.saveId)).phase).toBe("unknown");
  expect(attempts).toBe(1);
});

test("a delayed status check cannot replace a completed save receipt", async () => {
  const f = await fixture();
  await f.store.put({ ...f.original, plan: f.plan, method: "browser", phase: "creating" });
  let release: ((value: BrowserSaveIntent) => void) | undefined;
  let checks = 0;
  const checked = new Promise<BrowserSaveIntent>(resolve => { release = resolve; });
  const runner = new CaptureJobRunner(f.store, { ...f.services,
    browserCheck: async () => { checks++; return checked; },
  });
  const waiting = runner.status(f.original.saveId);
  for (let i = 0; i < 20 && checks === 0; i++) await Promise.resolve();
  expect(checks).toBe(1);
  await f.store.put({ ...f.original, plan: f.plan, method: "browser", phase: "saved" });
  release!({ saveId: f.original.saveId, accountId: 7, plan: f.plan,
    destinations: f.original.destinations, channelIds: [17], phase: "creating" });
  expect((await waiting).phase).toBe("saved");
  expect(f.jobs.get(f.original.saveId)?.phase).toBe("saved");
});

test("a media job waits for helper access and reuses its save UUID", async () => {
  const f = await fixture();
  let ready = false, nativeCalls = 0;
  const services: CaptureJobServices = { ...f.services,
    browserAvailable: async () => false, nativeAvailable: async () => ready,
    nativeSave: async id => { expect(id).toBe(f.original.saveId); nativeCalls++; return { phase: "running" }; } };
  const runner = new CaptureJobRunner(f.store, services);
  expect((await runner.run(f.original.saveId)).phase).toBe("needs_helper");
  expect(nativeCalls).toBe(0);
  ready = true;
  expect((await runner.run(f.original.saveId)).phase).toBe("saved");
  expect(nativeCalls).toBe(1);
});

test("a definite prewrite failure remains retryable with the same save ID", async () => {
  const f = await fixture();
  const first = new CaptureJobRunner(f.store, { ...f.services,
    browserCreate: async () => { throw new Error("The signed-in Are.na account changed"); } });
  const failed = await first.run(f.original.saveId);
  expect(failed.phase).toBe("failed");
  expect(failed.saveId).toBe(f.original.saveId);
  expect((await new CaptureJobRunner(f.store, f.services).run(f.original.saveId)).phase).toBe("saved");
  expect(f.createCalls).toBe(1);
});
