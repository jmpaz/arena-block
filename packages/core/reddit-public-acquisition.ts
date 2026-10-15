import { normalizeRedditCapture } from "./reddit-record.ts";
import type { ParsedSource } from "./url.ts";

const host = globalThis as any;
let next = 0;
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; cleanup(): void }>();
host.captureRedditPublicPageComplete = (id: number, raw: string | null, error: string | null) => {
  const job = pending.get(id); if (!job) return;
  pending.delete(id); job.cleanup();
  if (error) job.reject(new Error(error));
  else { try { job.resolve(normalizeRedditCapture(JSON.parse(raw ?? "null"))); } catch { job.reject(new Error("Reddit public browser returned invalid data")); } }
};
export function nativeRedditPublicAcquirer(): ((source: Extract<ParsedSource, { provider: "reddit" }>, signal: AbortSignal) => Promise<unknown>) | undefined {
  if (typeof host.nativeAcquireRedditPublicPage !== "function") return;
  return (source, signal) => new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const id = ++next;
    const abort = () => {
      pending.delete(id); signal.removeEventListener("abort", abort);
      host.nativeCancelRedditPublicPage?.(id); reject(signal.reason ?? new Error("Reddit public read cancelled"));
    };
    pending.set(id, { resolve, reject, cleanup: () => signal.removeEventListener("abort", abort) });
    signal.addEventListener("abort", abort, { once: true });
    try { host.nativeAcquireRedditPublicPage(id, source.canonicalUrl); }
    catch (error) { pending.delete(id); signal.removeEventListener("abort", abort); reject(error); }
  });
}
