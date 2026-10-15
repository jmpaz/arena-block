import { z } from "zod";
import { substackCaptureSchema, substackCapturesSchema, substackSourceKey, type SubstackCapture } from "./substack-record.ts";
import { redditBrowserCaptureSchema, redditCapturesSchema, redditSourceKey, type RedditBrowserCapture } from "./reddit-record.ts";
import { parseSource } from "./url.ts";
import { substackArticleRecordSchema, substackRelationSchema, substackThreadSchema, type SubstackArticleRecord } from "./substack-article-record.ts";

export const SCHEMA_VERSION = 1 as const;

export const mediaKindSchema = z.enum(["image", "video", "audio"]);
export type MediaKind = z.infer<typeof mediaKindSchema>;

export const mediaAssetSchema = z.object({
  ref: z.string().regex(/^(?:\d+|quote\d*)\.\d+$/),
  kind: mediaKindSchema,
  url: z.url(),
  id: z.string().optional(),
  mimeType: z.string().optional(),
  sourceRole: z.enum(["original", "preview"]).optional(),
  sourcePlacement: z.literal("body").optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  durationSeconds: z.number().positive().optional(),
  posterUrl: z.url().refine(value => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  }).optional(),
  acquisition: z.enum(["soundcloud-original-download", "substack-public-original"]).optional(),
  alt: z.string().default(""),
});
export type MediaAsset = z.infer<typeof mediaAssetSchema>;
export const mediaIssueSchema = z.object({
  sourcePlacement: z.literal("body"),
  status: z.enum(["missing_metadata", "unavailable", "unsupported", "unsafe_url"]),
  id: z.string().optional(), url: z.string().optional(),
});
export const MAX_QUOTE_DEPTH = 8;
export const DEFAULT_QUOTE_DEPTH = 2;
export const quoteDepthSchema = z.union([z.number().int().min(0).max(MAX_QUOTE_DEPTH), z.literal("full")]);
export type QuoteDepth = z.infer<typeof quoteDepthSchema>;
export const quoteStopSchema = z.enum(["end", "depth_limit", "unavailable", "deleted", "cycle", "invalid_reference"]);
export const quoteCoverageSchema = z.object({
  maxDepth: z.number().int().min(0).max(MAX_QUOTE_DEPTH), actualDepth: z.number().int().min(0).max(MAX_QUOTE_DEPTH),
  maxReached: z.boolean(), truncated: z.boolean(), stopped: quoteStopSchema, sourceIds: z.array(z.string()).max(MAX_QUOTE_DEPTH + 1),
  acquisitionDepth: z.number().int().min(0).max(MAX_QUOTE_DEPTH).optional(), mayExpand: z.boolean().optional(),
});
export type QuoteCoverage = z.infer<typeof quoteCoverageSchema>;
const quoteBoundarySchema = z.object({ status: quoteStopSchema.exclude(["end"]), id: z.string().optional(), canonicalUrl: z.url().optional() });

export const soundCloudArtworkUrlSchema = z.url().refine(value => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password && !url.port
    && (url.hostname === "sndcdn.com" || url.hostname.endsWith(".sndcdn.com"));
}, "Expected public SoundCloud artwork on sndcdn.com");
export const soundCloudTrackSchema = z.object({
  id: z.string().min(1), title: z.string().min(1), artists: z.array(z.string().min(1)),
  url: z.url().refine(value => {
    try { const source = parseSource(value); return source.provider === "soundcloud" && source.kind === "track" && source.canonicalUrl === value; }
    catch { return false; }
  }, "Expected a canonical public SoundCloud track URL"), durationSeconds: z.number().positive().optional(),
});
export const MAX_SOUNDCLOUD_PLAYLIST_TRACKS = 1000;
export const soundCloudMetadataSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("track"), trackId: z.string().min(1), artists: z.array(z.string().min(1)), description: z.string(),
    artworkUrl: soundCloudArtworkUrlSchema.optional(), durationSeconds: z.number().positive().optional(), originalDownloadAvailable: z.boolean(),
    originalDownloadExtension: z.string().optional() }),
  z.object({ kind: z.literal("playlist"), description: z.string(), artworkUrl: soundCloudArtworkUrlSchema.optional(), tracks: z.array(soundCloudTrackSchema),
    declaredTrackCount: z.number().int().min(0).max(MAX_SOUNDCLOUD_PLAYLIST_TRACKS) }),
]).refine(value => value.kind !== "playlist" || value.tracks.length === value.declaredTrackCount,
  "SoundCloud playlist metadata must contain its full declared track count");
export type SoundCloudMetadata = z.infer<typeof soundCloudMetadataSchema>;

const strongRefSchema = z.object({ uri: z.string().startsWith("at://"), cid: z.string().min(1) });
const facetSchema = z.object({
  index: z.object({ byteStart: z.number().int().nonnegative(), byteEnd: z.number().int().nonnegative() }),
  features: z.array(z.object({ $type: z.string().min(1), uri: z.string().optional(), did: z.string().optional(), tag: z.string().optional() }).passthrough()),
});
const atprotoSchema = z.object({ uri: z.string().startsWith("at://"), cid: z.string().min(1), authorDid: z.string().startsWith("did:"),
  record: z.record(z.string(), z.unknown()), reply: z.object({ root: strongRefSchema, parent: strongRefSchema }).optional() });
const externalSchema = z.object({ url: z.url(), title: z.string(), description: z.string(), thumbnailUrl: z.url().optional() });
const embeddedRecordSchema = z.object({ uri: z.string().startsWith("at://"), status: z.enum(["not-found", "blocked", "detached", "unsupported"]), type: z.string().optional() });

export type ResolvedPost = {
  provider: "substack" | "reddit" | "x" | "bluesky" | "delve" | "mastodon" | "tiktok" | "instagram" | "hackernews" | "lobsters" | "arena" | "web" | "soundcloud" | "forum_magnum";
  id: string;
  canonicalUrl: string;
  /** How this source entered the ordered composition. Provider reads omit this. */
  selection?: { role: "primary" | "extra"; origin: "explicit" | "expanded"; declaredIndex?: number; parentUri?: string };
  author: {
    handle: string;
    name?: string;
  };
  text: string;
  /** Provider-observed reply parent, distinct from a quoted post. */
  replyTo?: { id: string; authorHandle?: string };
  /** Exact X display-hidden leading mention span, validated against raw facets. */
  replyAddressPrefix?: string;
  /** Bounded public author-chain evidence; unrelated conversation gaps are not missing author posts. */
  threadCoverage?: { scope: "author-chain"; replyGaps: { uri: string; reported?: number; returned: number; unavailable: number }[] };
  article?: string;
  postedAt?: string;
  storyTitle?: string;
  postTitle?: string;
  soundcloud?: SoundCloudMetadata;
  substackCapture?: SubstackCapture;
  substackArticle?: SubstackArticleRecord;
  substackRelation?: z.infer<typeof substackRelationSchema>;
  substackThread?: z.infer<typeof substackThreadSchema>;
  redditCapture?: RedditBrowserCapture;
  media: MediaAsset[];
  mediaIssues?: z.infer<typeof mediaIssueSchema>[];
  arenaBlock?: { type: "Image" | "Link" | "Attachment" | "Embed"; sourceURL?: string; updatedAt?: string; mediaUpdatedAt?: string };
  quote?: ResolvedPost;
  atproto?: z.infer<typeof atprotoSchema>;
  facets?: z.infer<typeof facetSchema>[];
  external?: z.infer<typeof externalSchema>;
  embeddedRecord?: z.infer<typeof embeddedRecordSchema>;
  quoteBoundary?: z.infer<typeof quoteBoundarySchema>;
  quoteCoverage?: QuoteCoverage;
  quoteSnapshot?: { basis: "embedded"; hydration: "unavailable" | "deleted" };
};

export const resolvedPostSchema: z.ZodType<ResolvedPost> = z.lazy(() =>
  z.object({
    provider: z.enum(["substack", "reddit", "x", "bluesky", "delve", "mastodon", "tiktok", "instagram", "hackernews", "lobsters", "arena", "web", "soundcloud", "forum_magnum"]),
    id: z.string().min(1),
    canonicalUrl: z.url(),
    selection: z.object({ role: z.enum(["primary", "extra"]), origin: z.enum(["explicit", "expanded"]),
      declaredIndex: z.number().int().min(1).optional(), parentUri: z.string().min(1).optional() }).optional(),
    author: z.object({
      handle: z.string().min(1),
      name: z.string().optional(),
    }),
    text: z.string(),
    replyTo: z.object({ id: z.string().min(1), authorHandle: z.string().min(1).optional() }).optional(),
    replyAddressPrefix: z.string().min(1).optional(),
    threadCoverage: z.object({ scope: z.literal("author-chain"), replyGaps: z.array(z.object({
      uri: z.string().min(1), reported: z.number().nonnegative().optional(), returned: z.number().nonnegative(), unavailable: z.number().nonnegative(),
    })) }).optional(),
    article: z.string().min(1).optional(),
    substackArticle: substackArticleRecordSchema.optional(),
    substackRelation: substackRelationSchema.optional(),
    substackThread: substackThreadSchema.optional(),
    postedAt: z.string().optional(),
    storyTitle: z.string().min(1).optional(),
    postTitle: z.string().min(1).optional(),
    soundcloud: soundCloudMetadataSchema.optional(),
    substackCapture: substackCaptureSchema.optional(),
    redditCapture: redditBrowserCaptureSchema.optional(),
    media: z.array(mediaAssetSchema),
    mediaIssues: z.array(mediaIssueSchema).optional(),
    arenaBlock: z.object({ type: z.enum(["Image", "Link", "Attachment", "Embed"]), sourceURL: z.url().optional(), updatedAt: z.string().optional(), mediaUpdatedAt: z.string().optional() }).optional(),
    quote: resolvedPostSchema.optional(),
    atproto: atprotoSchema.optional(),
    facets: z.array(facetSchema).optional(),
    external: externalSchema.optional(),
    embeddedRecord: embeddedRecordSchema.optional(),
    quoteBoundary: quoteBoundarySchema.optional(), quoteCoverage: quoteCoverageSchema.optional(),
    quoteSnapshot: z.object({ basis: z.literal("embedded"), hydration: z.enum(["unavailable", "deleted"]) }).optional(),
  }).superRefine((post, context) => {
    if (post.provider === "substack" && post.id.startsWith("article:") && !post.substackArticle) {
      context.addIssue({ code: "custom", message: "Substack article is missing its complete source record", path: ["substackArticle"] });
    }
    if (post.substackArticle && (post.provider !== "substack" || post.id !== `article:${post.substackArticle.id}`
      || post.canonicalUrl !== post.substackArticle.url || post.author.handle !== post.substackArticle.authors[0]?.handle || !post.article)) {
      context.addIssue({ code: "custom", message: "Mismatched Substack article provenance", path: ["substackArticle"] });
    }
    if (post.substackRelation) {
      try {
        if (post.provider !== "substack" || post.id !== substackSourceKey(post.canonicalUrl)
          || post.replyTo?.id !== post.substackRelation.ancestorIds.at(-1)) throw new Error("Mismatched reply");
      } catch { context.addIssue({ code: "custom", message: "Mismatched Substack reply provenance", path: ["substackRelation"] }); }
    }
    if (post.substackCapture) {
      try {
        const note = post.substackCapture.note;
        if (post.provider !== "substack" || post.id !== substackSourceKey(note.url)
          || substackSourceKey(post.canonicalUrl) !== substackSourceKey(post.substackCapture.sourceUrl)
          || post.author.handle !== note.author.handle) throw new Error("Mismatched Substack capture provenance");
      } catch { context.addIssue({ code: "custom", message: "Mismatched Substack capture provenance", path: ["substackCapture"] }); }
    }
    if (!post.redditCapture) return;
    try {
      if (post.provider !== "reddit" || post.id !== (post.redditCapture.comment?.id ?? post.redditCapture.post.id) ||
          redditSourceKey(post.canonicalUrl) !== redditSourceKey(post.redditCapture.sourceUrl)) throw new Error("Mismatched Reddit capture provenance");
    } catch { context.addIssue({ code: "custom", message: "Mismatched Reddit capture provenance", path: ["redditCapture"] }); }
  }),
);

export const compositionPolicySchema = z.object({
  media: z.enum(["auto", "none", "all", "video", "audio", "images", "selected"]).default("auto"),
  audio: z.union([z.enum(["auto", "mix"]), z.string().regex(/^\d+\.\d+$/)]).optional(),
  selectedMedia: z.array(z.string().regex(/^\d+\.\d+$/)).default([]),
  videoFrames: z.array(z.string().regex(/^\d+\.\d+$/)).max(100).optional(),
  videoFrameThresholdSeconds: z.number().int().min(1).max(600).optional(),
  // Stable source refs in the complete desired tile order; inclusion stays independent.
  mediaOrder: z.array(z.string().regex(/^\d+\.\d+$/)).max(100).optional(),
  mediaOnlyPosts: z.array(z.number().int().min(2)).optional(),
  threadExpansion: z.enum(["auto", "off", "on"]).optional(),
  quote: z.enum(["block", "sequence", "omit"]).default("block"),
  quoteDepth: quoteDepthSchema.optional(),
  quoteDates: z.enum(["auto", "source", "none"]).optional(),
  separator: z.enum(["auto", "always", "never"]).default("auto"),
});
export type CompositionPolicy = z.infer<typeof compositionPolicySchema>;

export const layoutNodeSchema: z.ZodType<LayoutNode> = z.lazy(() =>
  z.union([
    z.object({ kind: z.literal("media"), ref: z.string() }),
    z.object({
      kind: z.literal("split"),
      axis: z.enum(["horizontal", "vertical"]),
      children: z.array(layoutNodeSchema).min(2),
    }),
  ]),
);
export type LayoutNode =
  | { kind: "media"; ref: string }
  | {
      kind: "split";
      axis: "horizontal" | "vertical";
      children: LayoutNode[];
    };

// Explicit requests remain limited to 20 refs; a provider-observed thread can
// contain more posts while still producing one bounded immutable plan.
export const MAX_EXPANDED_SOURCE_POSTS = 32;

export const blockPlanSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  sources: z.array(resolvedPostSchema).min(1).max(MAX_EXPANDED_SOURCE_POSTS),
  policy: compositionPolicySchema,
  block: z.object({
    kind: z.enum(["text", "image", "link", "video", "audio", "url"]),
    title: z.string(),
    markdown: z.string(),
    description: z.string().optional(),
    canonicalSource: z.url(),
    artworkUrl: soundCloudArtworkUrlSchema.optional(),
    selectedMedia: z.array(z.string()),
    frameMedia: z.array(z.object({ ref: z.string().regex(/^\d+\.\d+$/), url: z.url().refine(value => {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password;
    }) })).optional(),
    layout: layoutNodeSchema.optional(),
    quoteCoverage: z.array(z.object({ sourceId: z.string(), availableDepth: z.number().int().min(0).max(MAX_QUOTE_DEPTH),
      renderedDepth: z.number().int().min(0).max(MAX_QUOTE_DEPTH), requestedDepth: quoteDepthSchema, maxDepth: z.number().int().min(0).max(MAX_QUOTE_DEPTH),
      maxReached: z.boolean(), truncated: z.boolean(), stopped: quoteStopSchema,
      mayExpand: z.boolean().optional(),
      dateUncertainty: z.array(z.enum(["same_day", "missing_or_incomparable_source_days"])).optional() })).optional(),
  }),
}).superRefine((plan, context) => {
  const refs = new Set<string>();
  for (const frame of plan.block.frameMedia ?? []) {
    const original = plan.sources.flatMap(source => source.media).find(asset => asset.ref === frame.ref);
    if (refs.has(frame.ref) || !plan.block.selectedMedia.includes(frame.ref) || original?.kind !== "video"
      || original.posterUrl !== frame.url) {
      context.addIssue({ code: "custom", message: "A frame must use the selected video's observed poster", path: ["block", "frameMedia"] });
    }
    refs.add(frame.ref);
  }
});
export type BlockPlan = z.infer<typeof blockPlanSchema>;

export const planInputSchema = z.object({
  refs: z.array(z.union([
    z.url(),
    z.string().refine((value) => {
      if (!value.startsWith("at://")) return false;
      try {
        return ["bluesky", "delve"].includes(parseSource(value).provider);
      } catch {
        return false;
      }
    }, "Expected a supported AT Protocol post URI"),
  ])).min(1).max(20),
  extraRefs: z.array(z.string().min(1).max(8192)).max(19).default([]),
  policy: compositionPolicySchema.optional(),
  refresh: z.boolean().default(false),
  redditCaptures: redditCapturesSchema,
  substackCaptures: substackCapturesSchema,
}).refine(input => input.refs.length + input.extraRefs.length <= 20, "At most 20 source posts are supported");
export type PlanInput = z.infer<typeof planInputSchema>;

export const publishRequestSchema = z.object({
  plan: blockPlanSchema,
  destinations: z.array(z.string().min(1)).min(1).max(20),
  force: z.boolean().default(false),
  operationId: z.uuid().optional(),
  // The daemon validates the complete capsule against its own policy and the plan.
  remoteSave: z.object({
    snapshot: z.record(z.string(), z.unknown()),
    snapshotSha256: z.string().regex(/^[a-f0-9]{64}$/),
    mode: z.enum(["summary", "full"]),
  }).strict().optional(),
});
export type PublishRequest = z.infer<typeof publishRequestSchema>;

const mediaArtifactSchema = z.object({
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  url: z.url(),
  mimeType: z.enum(["image/jpeg", "video/mp4", "audio/mpeg", "audio/mp4", "audio/wav", "audio/flac", "audio/ogg", "audio/opus", "audio/aac"]),
  size: z.number().int().nonnegative(),
});

const initialFieldsSchema = z.object({
  status: z.enum(["pending", "attempted", "applied"]),
  content: z.string().optional(),
  description: z.string(),
}).strict();
export type InitialFields = z.infer<typeof initialFieldsSchema>;

export const publicationReceiptSchema = z.object({
  id: z.string(),
  planHash: z.string(),
  blockId: z.number().int().positive(),
  blockUrl: z.url(),
  destinations: z.array(z.string()),
  connectionIds: z.array(z.number().int().positive()),
  status: z.enum(["publishing", "verified", "rolled_back", "rollback_failed", "needs_attention"]),
  stage: z.enum(["processing", "updating", "verifying", "connecting"]).optional(),
  pendingDestinations: z.array(z.string()).optional(),
  attemptedChannelIds: z.array(z.number().int().positive().safe()).optional(),
  mediaArtifact: mediaArtifactSchema.optional(),
  initialFields: initialFieldsSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  error: z.string().optional(),
  remoteProvenance: z.object({
    saveId: z.uuid(), snapshotSha256: z.string().regex(/^[a-f0-9]{64}$/),
    accountId: z.number().int().positive().safe(), credentialProfile: z.string(),
    inboxChannelId: z.number().int().positive().safe(), connectionId: z.number().int().positive().safe().optional(),
    state: z.enum(["pending", "verified", "unknown"]),
  }).strict().optional(),
});
export type PublicationReceipt = z.infer<typeof publicationReceiptSchema>;

export const creationAttemptSchema = z.object({
  id: z.string(),
  planHash: z.string(),
  destinations: z.array(z.string()),
  attemptedChannelIds: z.array(z.number().int().positive().safe()).optional(),
  status: z.enum(["creating", "creation_unknown", "created", "rejected"]),
  createdAt: z.string(),
  mediaArtifact: mediaArtifactSchema.optional(),
  initialFields: initialFieldsSchema.optional(),
  error: z.string().optional(),
});
export type CreationAttempt = z.infer<typeof creationAttemptSchema>;

export const publicationStateSchema = z.object({
  operationId: z.uuid().optional(),
  receipt: publicationReceiptSchema.optional(),
  attempt: creationAttemptSchema.optional(),
});
export type PublicationState = z.infer<typeof publicationStateSchema>;

export const resumePublicationSchema = z.object({
  destinations: z.array(z.string().min(1)).min(1).max(20),
});
