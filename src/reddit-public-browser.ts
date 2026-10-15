import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { normalizeRedditCapture, REDDIT_CAPTURE_MAX_BYTES } from "../packages/core/reddit-record.ts";
import type { ParsedSource } from "../packages/core/url.ts";

async function bounded(stream: ReadableStream<Uint8Array>, limit: number): Promise<string> {
  const reader = stream.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength;
      if (bytes > limit) throw new Error("Reddit public browser response exceeds its bound"); chunks.push(value); }
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
  const output = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(output);
}
/** Optional platform adapter, packaged beside the CLI. It receives no access tokens or browser profile. */
export function publicRedditBrowser(options: { platform?: string; helper?: string; reader?: string } = {}): ((source: Extract<ParsedSource, { provider: "reddit" }>, signal: AbortSignal) => Promise<unknown>) | undefined {
  if ((options.platform ?? process.platform) !== "darwin") return;
  const helper = options.helper ?? process.env.ARENA_BLOCK_PUBLIC_BROWSER_HELPER ?? fileURLToPath(new URL("../libexec/arena-block-public-browser", import.meta.url));
  const reader = options.reader ?? process.env.ARENA_BLOCK_PUBLIC_BROWSER_READER ?? fileURLToPath(new URL("../ios/Sources/CaptureRuntime/Resources/reddit-public-page.js", import.meta.url));
  if (!existsSync(helper) || !existsSync(reader)) return;
  return async (source, signal) => {
    signal.throwIfAborted();
    const env = Object.fromEntries(["HOME", "PATH", "TMPDIR", "LANG", "LC_ALL"].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
    const child = Bun.spawn([helper, source.canonicalUrl, reader], { stdout: "pipe", stderr: "pipe", env });
    const stop = () => { child.kill("SIGTERM"); };
    const timeout = setTimeout(stop, 35_000); signal.addEventListener("abort", stop, { once: true });
    try {
      const [code, output, error] = await Promise.all([child.exited, bounded(child.stdout, REDDIT_CAPTURE_MAX_BYTES), bounded(child.stderr, 8192)]);
      signal.throwIfAborted();
      if (code !== 0) throw new Error(error.trim() || "Reddit public browser did not complete");
      return normalizeRedditCapture(JSON.parse(output));
    } finally { clearTimeout(timeout); signal.removeEventListener("abort", stop); if (child.exitCode === null) stop(); }
  };
}
