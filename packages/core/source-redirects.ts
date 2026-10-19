import { parseSource, soundCloudShareURL } from "./url.ts";

type SourceFetcher = (input: string, init?: RequestInit) => Promise<Response>;
const MAX_SHARE_REQUESTS = 3;
const SHARE_TIMEOUT_MS = 10_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export async function resolveSoundCloudShareURL(value: string, fetcher: SourceFetcher = fetch,
  options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<string> {
  let current = soundCloudShareURL(value);
  if (!current) return value;
  const timeoutMs = options.timeoutMs ?? SHARE_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > SHARE_TIMEOUT_MS) throw new Error("Invalid SoundCloud share-link timeout");
  const controller = new AbortController();
  let failure: Error | undefined;
  let rejectStopped!: (error: Error) => void;
  const stopped = new Promise<never>((_, reject) => { rejectStopped = reject; });
  const stop = (error: Error) => { if (failure) return; failure = error; rejectStopped(error); controller.abort(); };
  const cancel = () => stop(new Error("SoundCloud share-link resolution cancelled"));
  if (options.signal?.aborted) throw new Error("SoundCloud share-link resolution cancelled");
  options.signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => stop(new Error("SoundCloud share-link resolution timed out")), timeoutMs);
  const seen = new Set<string>();
  try {
    for (let request = 0; request < MAX_SHARE_REQUESTS; request++) {
      if (failure) throw failure;
      if (seen.has(current)) throw new Error("SoundCloud share-link redirect loop");
      seen.add(current);
      const response = await Promise.race([fetcher(current, {
        method: "HEAD", redirect: "manual", credentials: "omit", signal: controller.signal,
      }), stopped]);
      if (failure) throw failure;
      if (response.redirected || response.url && response.url !== current) throw new Error("SoundCloud share-link request followed an unchecked redirect");
      if (!REDIRECT_STATUSES.has(response.status)) throw new Error("SoundCloud share link did not redirect to a public track or playlist");
      const location = response.headers.get("location");
      if (!location || location.length > 8192) throw new Error("SoundCloud share link has no bounded redirect destination");
      let next: string;
      try { next = new URL(location, current).href; }
      catch { throw new Error("SoundCloud share link has an invalid redirect destination"); }
      const share = soundCloudShareURL(next);
      if (share) { current = share; continue; }
      let source: ReturnType<typeof parseSource>;
      try { source = parseSource(next); }
      catch { throw new Error("SoundCloud share link did not resolve to a public SoundCloud track or playlist"); }
      if (source.provider !== "soundcloud") throw new Error("SoundCloud share link did not resolve to a public SoundCloud track or playlist");
      return source.canonicalUrl;
    }
    throw new Error("SoundCloud share link exceeded three redirect requests");
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
  }
}

export async function resolveSourceRefs(refs: string[], fetcher: SourceFetcher = fetch, signal?: AbortSignal): Promise<string[]> {
  const shares = refs.map(ref => {
    const share = soundCloudShareURL(ref);
    if (!share) parseSource(ref);
    return share;
  });
  const pending = new Map<string, Promise<string>>();
  return Promise.all(refs.map((ref, index) => {
    const share = shares[index];
    if (!share) return ref;
    let result = pending.get(share);
    if (!result) { result = resolveSoundCloudShareURL(share, fetcher, { signal }); pending.set(share, result); }
    return result;
  }));
}
