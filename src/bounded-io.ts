/** Race even a misbehaving transport against a finite signal; never await cancellation. */
export function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void pending.catch(() => {}); return Promise.reject(signal.reason); }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export async function boundedJson(message: { body: ReadableStream<Uint8Array> | null }, limit: number, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  const reader = message.body?.getReader();
  if (!reader) throw new Error("JSON body is required");
  const chunks: Uint8Array[] = []; let size = 0, complete = false;
  try {
    while (true) {
      const { value, done } = await abortable(reader.read(), signal);
      if (done) { complete = true; break; }
      size += value.length;
      if (size > limit) throw new Error(`JSON payload exceeds ${limit} bytes`);
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    if (!complete) void reader.cancel().catch(() => {});
    try { reader.releaseLock(); } catch { /* An interrupted read may still be pending. */ }
  }
}

export function deadline(milliseconds: number, parent?: AbortSignal): AbortSignal {
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0 || milliseconds > 360_000) throw new Error("Invalid finite deadline");
  const timeout = AbortSignal.timeout(milliseconds);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}
