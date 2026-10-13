import URLPolyfill from "core-js-pure/actual/url/index.js";
import URLSearchParamsPolyfill from "core-js-pure/actual/url-search-params/index.js";
import AbortControllerPolyfill, { AbortSignal as AbortSignalPolyfill } from "abort-controller/dist/abort-controller.js";
import { Headers as HeadersPolyfill, Response as ResponsePolyfill } from "whatwg-fetch";

const host = globalThis as any;
const intervals = new Map<number, number>();
let intervalID = 0;
host.setInterval = (callback: () => void, delay: number) => {
  const id = ++intervalID;
  const tick = () => { callback(); if (intervals.has(id)) intervals.set(id, host.setTimeout(tick, delay)); };
  intervals.set(id, host.setTimeout(tick, delay));
  return id;
};
host.clearInterval = (id: number) => { host.clearTimeout(intervals.get(id)); intervals.delete(id); };
host.URL = URLPolyfill;
host.URLSearchParams = URLSearchParamsPolyfill;
host.Headers = HeadersPolyfill;
host.Response = ResponsePolyfill;
host.AbortController = AbortControllerPolyfill;
host.AbortSignal = AbortSignalPolyfill;
host.ReadableStream = class {};
host.AbortSignal.timeout = (milliseconds: number) => {
  const controller = new AbortControllerPolyfill();
  host.setTimeout(() => controller.abort(), milliseconds);
  return controller.signal;
};
host.AbortSignal.any = (signals: AbortSignal[]) => {
  const controller = new AbortControllerPolyfill();
  for (const signal of signals) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return controller.signal;
};
let requestID = 0;
const requests = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; dispose: () => void }>();
host.captureHTTPComplete = (id: number, json: string) => {
  const pending = requests.get(id);
  if (!pending) return;
  requests.delete(id);
  pending.dispose();
  const result = JSON.parse(json);
  if (result.error) pending.reject(new Error(result.error));
  else {
    const response = new ResponsePolyfill(result.body, { status: result.status, headers: result.headers });
    Object.defineProperty(response, "url", { value: result.url });
    pending.resolve(response);
  }
};
host.fetch = (input: string, init: RequestInit = {}) => new Promise((resolve, reject) => {
  const id = ++requestID;
  const abort = () => {
    requests.delete(id);
    host.nativeCancelHTTP(id);
    const error = new Error("The operation was aborted");
    error.name = "AbortError";
    reject(error);
  };
  if (init.signal?.aborted) return abort();
  init.signal?.addEventListener("abort", abort, { once: true });
  requests.set(id, { resolve, reject, dispose: () => init.signal?.removeEventListener("abort", abort) });
  const headers: Record<string, string> = {};
  new HeadersPolyfill(init.headers as any).forEach((value, key) => { headers[key] = value; });
  host.nativeHTTP(id, JSON.stringify({ url: String(input), method: init.method ?? "GET", headers, body: init.body, redirect: init.redirect ?? "follow" }));
});
