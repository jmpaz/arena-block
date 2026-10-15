import { readRedditPage } from "../../packages/core/reddit-browser-reader.ts";
import { readRedditPublicPage } from "../../packages/core/reddit-public-page-reader.ts";

(globalThis as any).arenaAcquireRedditPublicPage = async (expected: string) => {
  try {
    readRedditPublicPage(expected, { inspectOnly: true });
    try { return { ok: true, capture: await readRedditPage(expected) }; }
    catch (error) {
      if (!/Reddit browser read returned HTTP 403 without usable JSON/.test(String(error))) throw error;
      return { ok: true, capture: readRedditPublicPage(expected) };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, pending: /is not ready/.test(message), error: message };
  }
};
