import { z } from "zod";

const uploadSchema = z.object({ id: z.uuid(), state: z.literal("transcoded"), publication_id: z.number().int().positive(),
  post_id: z.number().int().positive(), user_id: z.number().int().positive(), media_type: z.enum(["video", "audio"]),
  duration: z.number().positive(), width: z.number().int().positive().nullable().optional(), height: z.number().int().positive().nullable().optional(),
  thumbnail_id: z.number().int().nonnegative().nullable().optional(), is_free_preview: z.boolean().optional(),
});
const publicURL = z.url().refine(value => { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && !url.port; });
export const substackNativeMediaSchema = z.object({ kind: z.enum(["video", "audio"]), uploadId: z.uuid(), url: publicURL,
  durationSeconds: z.number().positive(), width: z.number().int().positive().optional(), height: z.number().int().positive().optional(), posterUrl: publicURL.optional(),
}).strict();
export type SubstackNativeMedia = z.infer<typeof substackNativeMediaSchema>;

/** Project only native media offered by a complete, freely public article contract. */
export function publicSubstackNativeMedia(value: unknown, canonicalURL: string, inlineUploads: unknown[] = []): SubstackNativeMedia[] {
  const post = z.object({ id: z.number().int().positive(), publication_id: z.number().int().positive(), audience: z.literal("everyone"),
    video_upload_id: z.uuid().nullable().optional(), videoUpload: uploadSchema.nullable().optional(),
    podcast_url: z.string().nullable().optional(), podcastUpload: uploadSchema.nullable().optional(),
  }).parse(value);
  const origin = new URL(canonicalURL).origin, media: SubstackNativeMedia[] = [];
  const bind = (upload: z.infer<typeof uploadSchema>) => {
    if (upload.post_id !== post.id || upload.publication_id !== post.publication_id || upload.is_free_preview) throw new Error("Substack native media is a preview or belongs to a different article");
  };
  const video = (upload: z.infer<typeof uploadSchema>) => {
    if (upload.media_type !== "video") throw new Error("Substack inline video metadata has the wrong media type");
    bind(upload);
    // This is Substack's player route (src, type=mp4, publication context), not
    // a guessed unsigned Mux URL or an exported account/media token.
    const source = new URL(`/api/v1/video/upload/${upload.id}/src`, origin);
    source.searchParams.set("type", "mp4"); source.searchParams.set("override_publication_id", String(post.publication_id));
    const thumbnail = upload.thumbnail_id;
    const projected: SubstackNativeMedia = { kind: "video", uploadId: upload.id, url: source.href, durationSeconds: upload.duration,
      ...(upload.width ? { width: upload.width } : {}), ...(upload.height ? { height: upload.height } : {}),
      ...(thumbnail !== undefined && thumbnail !== null ? { posterUrl: `https://substack-video.s3.amazonaws.com/video_upload/post/${post.id}/${upload.id}/transcoded-${String(thumbnail).padStart(5, "0")}.png` } : {}) };
    const previous = media.find(item => item.uploadId === upload.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(projected)) throw new Error("Substack upload snapshots disagree about the same original media");
    if (!previous) media.push(projected);
  };
  if (post.video_upload_id) {
    const upload = post.videoUpload;
    if (!upload || upload.id !== post.video_upload_id) throw new Error("Substack article has no verified complete video metadata");
    video(upload);
  }
  for (const value of inlineUploads) {
    const upload = uploadSchema.parse(value);
    video(upload);
  }
  if (post.podcast_url) {
    const upload = post.podcastUpload;
    if (!upload || upload.media_type !== "audio") throw new Error("Substack article has no verified complete audio metadata");
    bind(upload);
    const source = new URL(post.podcast_url);
    if (source.protocol !== "https:" || source.username || source.password || source.port || source.hostname !== "api.substack.com"
      || source.pathname !== `/api/v1/audio/upload/${upload.id}/src` || source.search || source.hash) throw new Error("Substack original audio URL disagrees with its public upload identity");
    media.push({ kind: "audio", uploadId: upload.id, url: source.href, durationSeconds: upload.duration });
  }
  return media;
}
