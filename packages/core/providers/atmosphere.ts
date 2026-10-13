import { z } from "zod";
import type { ResolvedPost } from "../types.ts";
import { parseSource, type ParsedSource } from "../url.ts";
import type { Fetcher } from "./comments.ts";
import type { SocialProvider } from "./provider.ts";

const webUrl = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password;
}, "Expected a public HTTPS media URL");
const mediaSchema = z.object({
  type: z.enum(["photo", "video", "gif"]),
  url: webUrl,
  width: z.number().int().positive().nullish(),
  height: z.number().int().positive().nullish(),
  duration: z.number().positive().nullish(),
  thumbnail_url: z.string().nullish(),
  alt: z.string().nullish(),
});
const responseSchema = z.object({
  code: z.literal(200).optional(),
  status: z.object({
    id: z.string().min(1),
    url: webUrl,
    text: z.string(),
    created_at: z.string(),
    author: z.object({ screen_name: z.string().min(1), name: z.string().optional() }),
    media: z.object({ all: z.array(mediaSchema).min(1) }),
  }),
});

function publicPoster(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}

export class AtmosphereProvider implements SocialProvider {
  constructor(
    private readonly provider: "tiktok" | "instagram",
    private readonly fetcher: Fetcher = fetch,
  ) {}

  async resolve(source: ParsedSource, signal?: AbortSignal): Promise<ResolvedPost> {
    if (source.provider !== this.provider) throw new Error(`Expected a ${this.provider} source`);
    const response = await this.fetcher(`https://api.atmosphere.tools/2/${this.provider}/status/${encodeURIComponent(source.id)}`, {
      headers: { accept: "application/json", "user-agent": "arena-block/0.1" },
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Atmosphere returned ${response.status} for ${source.canonicalUrl}`);
    const parsed = responseSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error(`Atmosphere returned an unavailable or incomplete ${this.provider} post: ${source.canonicalUrl}`);
    const post = parsed.data.status;
    const canonical = parseSource(post.url);
    if (canonical.provider !== this.provider || canonical.id !== post.id
      || ((this.provider === "instagram" || /^\d+$/.test(source.id)) && post.id !== source.id)) {
      throw new Error(`Atmosphere returned a different post for ${source.canonicalUrl}`);
    }
    const postedAt = new Date(post.created_at);
    if (!Number.isFinite(postedAt.getTime())) throw new Error(`Invalid ${this.provider} post timestamp`);
    const media = post.media.all.map((item) => ({
      ref: "0.0",
      kind: item.type === "photo" ? "image" as const : "video" as const,
      url: item.url,
      ...(item.width ? { width: item.width } : {}),
      ...(item.height ? { height: item.height } : {}),
      ...(item.duration ? { durationSeconds: item.duration } : {}),
      ...(item.type !== "photo" && publicPoster(item.thumbnail_url) ? { posterUrl: publicPoster(item.thumbnail_url) } : {}),
      alt: item.alt ?? "",
    }));
    return {
      provider: this.provider, id: post.id,
      canonicalUrl: this.provider === "tiktok" && media.every((item) => item.kind === "image")
        ? canonical.canonicalUrl.replace("/video/", "/photo/") : canonical.canonicalUrl,
      author: { handle: post.author.screen_name, ...(post.author.name ? { name: post.author.name } : {}) },
      text: post.text, postedAt: postedAt.toISOString(), media,
    };
  }
}
