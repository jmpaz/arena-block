import { redditReadNeedsBrowser } from "../../packages/core/reddit-record.ts";
import { resolveWithNative } from "./native-reddit.ts";
import { BrowserOAuth } from "./browser-auth.ts";
import { BrowserSaver, type BrowserSaveIntent } from "./browser-save.ts";
import { CaptureJobRunner, type CaptureJob } from "./capture-job.ts";
import { resolveCapture } from "./core.ts";
import { blockPlanSchema } from "../../packages/core/types.ts";

const extension = (globalThis as any).browser ?? (globalThis as any).chrome;
const intentKey = (id: string) => `arena-block-browser-save-${id}`;
const jobKey = (id: string) => `arena-block-capture-job-${id}`;
const active = new Map<string, Promise<BrowserSaveIntent>>();
const activeJobs = new Map<string, Promise<CaptureJob>>();
const jobOperations = new Map<string, Promise<unknown>>();
const saveOperations = new Map<string, Promise<unknown>>();

function serialize<T>(operations: Map<string, Promise<unknown>>, saveId: string, action: () => Promise<T>): Promise<T> {
  const before = operations.get(saveId) ?? Promise.resolve();
  const task = before.catch(() => {}).then(action);
  operations.set(saveId, task);
  void task.finally(() => {
    if (operations.get(saveId) === task) operations.delete(saveId);
  }).catch(() => {});
  return task;
}

function saver(): BrowserSaver {
  const credentials = new BrowserOAuth("", extension.identity, extension.storage.local);
  return new BrowserSaver(credentials, {
    async get(id) { return (await extension.storage.local.get(intentKey(id)))[intentKey(id)] as BrowserSaveIntent | undefined; },
    async put(intent) { await extension.storage.local.set({ [intentKey(intent.saveId)]: intent }); },
  });
}

async function native(action: string, fields: Record<string, unknown>): Promise<any> {
  const id = crypto.randomUUID();
  const result = await extension.runtime.sendNativeMessage("net.fjpaz.arena_block", { id, action, ...fields });
  if (!result || result.id !== id || !result.ok) throw new Error(result?.error ?? "The local helper is unavailable.");
  return result.value;
}

function jobs(): CaptureJobRunner {
  const saves = saver();
  return new CaptureJobRunner({
    async get(id) { return (await extension.storage.local.get(jobKey(id)))[jobKey(id)] as CaptureJob | undefined; },
    async put(job) { await extension.storage.local.set({ [jobKey(job.saveId)]: job }); },
  }, {
    async resolve(input) {
      try { return await resolveCapture(input); }
      catch (error) {
        if (redditReadNeedsBrowser(error)) throw error;
        if (!await extension.permissions.contains({ permissions: ["nativeMessaging"] })) throw error;
        return resolveWithNative({
          refs: input.primary, extraRefs: input.extras, policy: input.policy, refresh: false, redditCaptures: input.redditCaptures, substackCaptures: input.substackCaptures,
        }, native);
      }
    },
    async browserAvailable() {
      const response = await fetch(extension.runtime.getURL("oauth-client.json"));
      return Boolean((await response.json()).clientId);
    },
    async nativeAvailable() { return extension.permissions.contains({ permissions: ["nativeMessaging"] }); },
    browserPrepare: (id, plan, destinations) => saves.prepare(id, plan, destinations),
    browserCreate: id => saves.create(id),
    browserCheck: id => saves.check(id),
    nativeSave: (id, plan, destinations) => native("save", { saveId: id, plan, destinations }),
    nativeRetry: id => native("retry", { saveId: id }),
    nativeStatus: id => native("status", { saveId: id }),
  });
}

extension.runtime.onMessage.addListener((message: unknown, sender: { id?: string },
  respond: (reply: { ok: boolean; value?: BrowserSaveIntent | CaptureJob; error?: string }) => void) => {
  if (!message || typeof message !== "object") return false;
  const kind = (message as any).kind;
  if (!["arena-block-create", "arena-block-browser-status", "arena-block-job-run", "arena-block-job-status"].includes(kind)) return false;
  const saveId = (message as any).saveId;
  if (sender.id !== extension.runtime.id || typeof saveId !== "string" || !/^[0-9a-f-]{36}$/i.test(saveId)) {
    respond({ ok: false, error: "Invalid save request." });
    return false;
  }
  if (kind === "arena-block-browser-status") {
    const task: Promise<BrowserSaveIntent | undefined> = active.has(saveId)
      ? extension.storage.local.get(intentKey(saveId)).then((value: Record<string, BrowserSaveIntent>) => value[intentKey(saveId)])
      : serialize(saveOperations, saveId, () => saver().check(saveId));
    void task.then(value => value ? respond({ ok: true, value })
      : respond({ ok: false, error: "Save intent is missing" }),
      error => respond({ ok: false, error: error instanceof Error ? error.message : "Save status unavailable." }));
    return true;
  }
  if (kind !== "arena-block-create") {
    if (kind === "arena-block-job-status") {
      const task: Promise<CaptureJob | undefined> = activeJobs.has(saveId)
        ? extension.storage.local.get(jobKey(saveId)).then((value: Record<string, CaptureJob>) => value[jobKey(saveId)])
        : serialize(jobOperations, saveId, () => jobs().status(saveId));
      void task.then(value => value ? respond({ ok: true, value })
        : respond({ ok: false, error: "Capture job is missing" }),
        error => respond({ ok: false, error: error instanceof Error ? error.message : "Save status unavailable." }));
      return true;
    }
    let job = activeJobs.get(saveId);
    if (!job) {
      job = serialize(jobOperations, saveId, () => jobs().run(saveId));
      activeJobs.set(saveId, job);
      void job.finally(() => activeJobs.delete(saveId)).catch(() => {});
    }
    void job.then(value => respond({ ok: true, value }),
      error => respond({ ok: false, error: error instanceof Error ? error.message : "Save status unavailable." }));
    return true;
  }
  let task = active.get(saveId);
  if (!task) {
    task = serialize(saveOperations, saveId, () => saver().create(saveId));
    active.set(saveId, task);
    void task.finally(() => active.delete(saveId)).catch(() => {});
  }
  void task.then(value => respond({ ok: true, value }),
    error => respond({ ok: false, error: error instanceof Error ? error.message : "Save status unavailable." }));
  return true;
});
