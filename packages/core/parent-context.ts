import { z } from "zod";
import { MAX_QUOTE_DEPTH, type CompositionPolicy } from "./types.ts";

// Ancestors are nearest first in evidence; presentation reverses the selected
// prefix. These are comments, never replies, quoted sources or submissions.
export const parentEntrySchema = z.object({
  id: z.string().min(1), canonicalUrl: z.url(),
  status: z.enum(["available", "deleted", "unavailable"]),
  author: z.object({ handle: z.string().min(1) }).optional(),
  text: z.string().optional(), postedAt: z.string().optional(),
}).superRefine((entry, context) => {
  if (entry.status === "available" && (!entry.author || !entry.text?.trim() || !entry.postedAt))
    context.addIssue({ code: "custom", message: "Available parent needs author, writing and date" });
});
export type ParentEntry = z.infer<typeof parentEntrySchema>;
export const parentContextSchema = z.object({
  parents: z.array(parentEntrySchema).max(8),
  stopped: z.enum(["submission", "depth_limit", "unavailable", "cycle", "invalid_reference"]),
  boundary: z.object({ id: z.string().min(1), canonicalUrl: z.url() }).optional(),
  submission: z.object({ id: z.string().min(1), canonicalUrl: z.url(), title: z.string().min(1) }).optional(),
});
export type ParentContext = z.infer<typeof parentContextSchema>;

/** Parent context is opt-in; quote omission/depth never changes this scope. */
export function renderedParentDepth(policy: Pick<CompositionPolicy, "parentDepth">): number {
  return policy.parentDepth === "full" ? MAX_QUOTE_DEPTH : policy.parentDepth ?? 0;
}
