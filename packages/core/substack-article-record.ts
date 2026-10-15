import { z } from "zod";
const publicURL = z.url().refine(value => { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && !url.port; }, "Expected HTTPS without credentials or custom ports");

export const substackArticleRecordSchema = z.object({
  version: z.literal(1), id: z.number().int().positive(), publicationId: z.number().int().positive(),
  url: publicURL, slug: z.string().min(1).max(512), title: z.string().min(1).max(2000), subtitle: z.string().max(10000),
  authors: z.array(z.object({ id: z.number().int().positive(), name: z.string().min(1).max(512), handle: z.string().regex(/^[a-zA-Z0-9_-]+$/).max(128), profileUrl: publicURL }).strict()).min(1).max(50),
  observedAt: z.iso.datetime(), method: z.literal("public-api"), audience: z.literal("everyone"), bodyHtml: z.string().min(1).max(500000),
}).strict();
export type SubstackArticleRecord = z.infer<typeof substackArticleRecordSchema>;

export const substackRelationSchema = z.object({
  version: z.literal(1), userId: z.number().int().positive(), ancestorIds: z.array(z.string().regex(/^[1-9]\d*$/)).max(32),
  reportedReplies: z.number().int().nonnegative(), observedAt: z.iso.datetime(), evidenceUrl: publicURL,
}).strict();
export const substackThreadSchema = z.object({ version: z.literal(1), scope: z.literal("same-author-linear"), seedId: z.string().regex(/^[1-9]\d*$/),
  rootId: z.string().regex(/^[1-9]\d*$/), pagesRead: z.number().int().positive().max(64), complete: z.literal(true),
  observedAt: z.iso.datetime(), evidenceUrls: z.array(publicURL).min(1).max(64),
}).strict();
