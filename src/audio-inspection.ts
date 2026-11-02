import { abortable } from "./bounded-io.ts";

type Child = { stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array>; exited: Promise<number>; kill(signal: "SIGKILL"): void };
type Controls = { timeoutMs?: number; settleMs?: number; outputBytes?: number; spawn?: (argv: string[]) => Child };

/** Inspect a local audio file with bounded output and explicit owned-child settlement. */
export async function inspectAudio(argv: string[], signal?: AbortSignal, controls: Controls = {}): Promise<string> {
  const timeoutMs = controls.timeoutMs ?? 30_000, settleMs = controls.settleMs ?? 2_000, cap = controls.outputBytes ?? 1024 * 1024;
  if (![timeoutMs, settleMs, cap].every(value => Number.isSafeInteger(value) && value > 0)
    || timeoutMs > 30_000 || settleMs > 2_000 || cap > 1024 * 1024) throw new Error("Invalid audio inspection bounds");
  const timeout = AbortSignal.timeout(timeoutMs), bounded = signal ? AbortSignal.any([signal, timeout]) : timeout;
  bounded.throwIfAborted();
  const child = controls.spawn ? controls.spawn(argv) : Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let exited = false, killed = false, statusFailed = false, killError: unknown;
  const status = child.exited.then(value => { exited = true; return value; }, error => { statusFailed = true; throw error; });
  const stop = () => {
    if (!exited && !killed && !statusFailed) {
      killed = true;
      try { child.kill("SIGKILL"); } catch (error) { killError = error; }
    }
  };
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  async function read(stream: ReadableStream<Uint8Array>): Promise<string> {
    const reader = stream.getReader(); readers.push(reader);
    let size = 0; const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > cap) throw new Error("Audio inspection output exceeded its limit");
        chunks.push(part.value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return new TextDecoder().decode(bytes);
    } finally { reader.releaseLock(); }
  }
  bounded.addEventListener("abort", stop, { once: true });
  if (bounded.aborted) stop();
  try {
    const [stdout, stderr, code] = await abortable(Promise.all([read(child.stdout), read(child.stderr), status]), bounded);
    bounded.throwIfAborted();
    if (code !== 0) throw new Error(`Audio inspection failed (${code}): ${stderr.trim().slice(0, 2000)}`);
    return stdout;
  } finally {
    bounded.removeEventListener("abort", stop);
    for (const reader of readers) { try { void reader.cancel().catch(() => {}); } catch { /* Already released. */ } }
    if (statusFailed) throw new Error("Audio inspection child status is uncertain; retain the resource lease and reconcile the owned job");
    if (!exited) {
      stop();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settled = await Promise.race([status.then(() => true, () => false), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), settleMs); })])
        .finally(() => { if (timer) clearTimeout(timer); });
      if (!settled) throw new Error("Audio inspection child settlement is uncertain; retain the resource lease and reconcile the owned job", { cause: killError });
    }
  }
}
