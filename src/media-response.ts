import type { BunFile } from "bun";

/** Serve the media file for uploads, playback and HEAD/range requests. */
export function mediaResponse(request: Request, file: BunFile, contentType: string): Response {
  const headers = new Headers({ "content-type": contentType, "content-length": String(file.size),
    "accept-ranges": "bytes", "cache-control": "public, max-age=31536000, immutable" });
  if (request.method === "HEAD") return new Response(null, { headers });
  const range = request.headers.get("range");
  if (!range) return new Response(file, { headers });
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  const invalid = () => {
    headers.set("content-range", `bytes */${file.size}`);
    headers.set("content-length", "0");
    return new Response(null, { status: 416, headers });
  };
  if (!match || (!match[1] && !match[2]) || !file.size) return invalid();
  const start = match[1] ? Number(match[1]) : Math.max(0, file.size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), file.size - 1) : file.size - 1;
  if (![start, end, Number(match[1] || 0), Number(match[2] || 0)].every(Number.isSafeInteger)
    || start >= file.size || end < start || (!match[1] && Number(match[2]) === 0)) return invalid();
  headers.set("content-range", `bytes ${start}-${end}/${file.size}`);
  headers.set("content-length", String(end - start + 1));
  return new Response(file.slice(start, end + 1), { status: 206, headers });
}
