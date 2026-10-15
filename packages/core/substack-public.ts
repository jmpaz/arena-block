/** Read public JSON with cookies and credentials disabled, rejecting redirects. */
export async function substackPublicJSON(url: string, fetcher: typeof fetch, signal?: AbortSignal, budget?: { bytes: number; maximum: number }): Promise<unknown> {
  const bounded = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(20_000)]);
  const response = await fetcher(url, { credentials: "omit", redirect: "error", signal: bounded, headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`Substack public read returned HTTP ${response.status}`);
  if (!/\bapplication\/(?:[a-z.+-]*\+)?json\b/i.test(response.headers.get("content-type") ?? "")) throw new Error("Substack public read did not return JSON");
  if (response.url && response.url !== url) throw new Error("Substack public read changed its endpoint");
  const maximum = 2 * 1024 * 1024;
  if (Number(response.headers.get("content-length")) > maximum) throw new Error("Substack public response exceeds 2 MiB");
  let text = "";
  if (response.body && typeof response.body.getReader === "function" && typeof TextDecoder !== "undefined") {
    const reader = response.body.getReader(), decoder = new TextDecoder(); let bytes = 0;
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break;
        if ((bytes += part.value.byteLength) > maximum) throw new Error("Substack public response exceeds 2 MiB");
        text += decoder.decode(part.value, { stream: true });
      }
      text += decoder.decode();
    } finally { void reader.cancel().catch(() => {}); }
  } else {
    text = await response.text(); let bytes = 0;
    for (const char of text) { const cp = char.codePointAt(0)!; bytes += cp < 128 ? 1 : cp < 2048 ? 2 : cp < 65536 ? 3 : 4; }
    if (bytes > maximum) throw new Error("Substack public response exceeds 2 MiB");
  }
  if (bounded.aborted) throw new Error("Substack public read cancelled");
  if (budget) {
    for (const char of text) { const cp = char.codePointAt(0)!; budget.bytes += cp < 128 ? 1 : cp < 2048 ? 2 : cp < 65536 ? 3 : 4; }
    if (budget.bytes > budget.maximum) throw new Error("Substack conversation exceeds the aggregate public response budget");
  }
  return JSON.parse(text);
}
