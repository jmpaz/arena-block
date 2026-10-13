import type { BlockPlan } from "../../packages/core/types.ts";
import type { CaptureInput } from "./core.ts";
import { browserCanPublish, type BrowserSaveIntent } from "./browser-save.ts";
import { revisePlan } from "./core.ts";

export type CaptureJobPhase = "queued" | "resolving" | "prepared" | "creating" | "needs_auth" |
  "needs_helper" | "unknown" | "created" | "partial" | "saved" | "rejected" | "failed";
export type CaptureJob = {
  saveId: string;
  input: CaptureInput;
  edits?: { title?: string; markdown?: string; description?: string };
  destinations: string[];
  phase: CaptureJobPhase;
  plan?: BlockPlan;
  method?: "browser" | "native";
  error?: string;
};
export type CaptureJobStore = { get(id: string): Promise<CaptureJob | undefined>; put(job: CaptureJob): Promise<void> };
export type CaptureJobServices = {
  resolve(input: CaptureInput): Promise<BlockPlan>;
  browserAvailable(): Promise<boolean>;
  nativeAvailable(): Promise<boolean>;
  browserPrepare(id: string, plan: BlockPlan, destinations: string[]): Promise<BrowserSaveIntent>;
  browserCreate(id: string): Promise<BrowserSaveIntent>;
  browserCheck(id: string): Promise<BrowserSaveIntent>;
  nativeSave(id: string, plan: BlockPlan, destinations: string[]): Promise<{ phase: string }>;
  nativeRetry(id: string): Promise<{ phase: string }>;
  nativeStatus(id: string): Promise<{ phase: string }>;
};

/** Read-only resolution may repeat. Once submission begins, only status may reconcile it. */
export class CaptureJobRunner {
  constructor(private readonly store: CaptureJobStore, private readonly services: CaptureJobServices) {}

  async status(id: string): Promise<CaptureJob> {
    const job = await this.store.get(id);
    if (!job) throw new Error("Capture job is missing");
    if (job.method === "browser" && ["creating", "created", "partial", "unknown"].includes(job.phase)) {
      return this.acceptBrowser(job, await this.services.browserCheck(id));
    }
    if (job.method === "native" && ["creating", "created", "partial", "unknown"].includes(job.phase)) {
      try {
        const result = await this.services.nativeStatus(id);
        const phase = result.phase;
        if (!["running", "creating", "created", "partial", "saved", "unknown", "not_saved", "rejected"].includes(phase))
          throw new Error("The local helper returned an unknown save phase");
        const latest = await this.store.get(id);
        if (latest?.phase === "saved") return latest;
        if (latest && latest.phase !== job.phase && phase !== "saved") return latest;
        const next: CaptureJob = { ...(latest ?? job), phase: phase === "running" ? "creating"
          : phase === "not_saved" ? "rejected" : phase as CaptureJobPhase };
        await this.store.put(next);
        return next;
      } catch {
        const latest = await this.store.get(id);
        if (latest?.phase === "saved") return latest;
        if (latest && latest.phase !== job.phase) return latest;
        const unknown = { ...(latest ?? job), phase: "unknown" as const };
        await this.store.put(unknown);
        return unknown;
      }
    }
    return job;
  }

  async run(id: string): Promise<CaptureJob> {
    let job = await this.store.get(id);
    if (!job) throw new Error("Capture job is missing");
    if (["saved", "unknown", "partial", "created"].includes(job.phase)) return this.status(id);
    if (job.phase === "creating") {
      const checked = await this.status(id);
      if (checked.phase !== "prepared") return checked;
      job = checked;
    }
    try {
      if (!job.plan) {
        job = { ...job, phase: "resolving", error: undefined };
        await this.store.put(job);
        const resolved = await this.services.resolve(job.input);
        const plan = job.edits ? revisePlan(resolved, job.edits) : resolved;
        job = { ...job, plan, phase: "prepared" };
        await this.store.put(job);
      }
      if (!job.method) {
        const browser = browserCanPublish(job.plan!) && await this.services.browserAvailable();
        job = { ...job, method: browser ? "browser" : "native" };
        await this.store.put(job);
      }
      if (job.method === "browser") {
        try { await this.services.browserPrepare(id, job.plan!, job.destinations); }
        catch (error) {
          if (String(error).includes("Connect your Are.na account")) {
            job = { ...job, phase: "needs_auth", error: undefined };
            await this.store.put(job);
            return job;
          }
          throw error;
        }
        job = { ...job, phase: "creating" };
        await this.store.put(job);
        return this.acceptBrowser(job, await this.services.browserCreate(id));
      }
      if (!await this.services.nativeAvailable()) {
        job = { ...job, phase: "needs_helper", error: undefined };
        await this.store.put(job);
        return job;
      }
      const retry = job.phase === "rejected";
      job = { ...job, phase: "creating" };
      await this.store.put(job);
      const response = retry ? await this.services.nativeRetry(id)
        : await this.services.nativeSave(id, job.plan!, job.destinations);
      if (response.phase === "saved") {
        job = { ...job, phase: "saved" };
        await this.store.put(job);
        return job;
      }
      return this.status(id);
    } catch (error) {
      // A native submit can reach the daemon before its response is lost. Preserve its UUID.
      if (job.phase === "creating") {
        const checked = await this.status(id);
        if (checked.method !== "browser" || checked.phase !== "prepared") return checked;
        const failed: CaptureJob = { ...checked, phase: "failed",
          error: error instanceof Error ? error.message : "Could not prepare the save" };
        await this.store.put(failed);
        return failed;
      }
      const next: CaptureJob = { ...job, phase: "failed", error: error instanceof Error ? error.message : "Capture failed" };
      await this.store.put(next);
      return next;
    }
  }

  private async acceptBrowser(job: CaptureJob, intent: BrowserSaveIntent): Promise<CaptureJob> {
    const latest = await this.store.get(job.saveId);
    if (latest?.phase === "saved") return latest;
    if (latest && latest.phase !== job.phase && intent.phase !== "saved") return latest;
    const next = { ...(latest ?? job), phase: intent.phase === "prepared" ? "prepared" as const : intent.phase };
    await this.store.put(next);
    return next;
  }
}
