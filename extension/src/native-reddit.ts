import { substackCapturesSchema, requireRetainedSubstackCaptures } from "../../packages/core/substack-record.ts";
import { blockPlanSchema, type PlanInput, type CompositionPolicy } from "../../packages/core/types.ts";
import { redditCapturesSchema, requireRetainedRedditCaptures } from "../../packages/core/reddit-record.ts";
import { needsSubstackPublicV2, requireSubstackPublicResult } from "../../packages/core/substack-input-capabilities.ts";

type NativeCall = (action: string, fields: Record<string, unknown>) => Promise<any>;
export async function resolveWithNative(input: Omit<PlanInput, "redditCaptures" | "substackCaptures" | "policy"> & { redditCaptures?: PlanInput["redditCaptures"]; substackCaptures?: PlanInput["substackCaptures"]; policy?: Partial<CompositionPolicy> }, native: NativeCall) {
  const captures = redditCapturesSchema.parse(input.redditCaptures ?? []);
  const substack = substackCapturesSchema.parse(input.substackCaptures ?? []);
  const publicV2 = needsSubstackPublicV2(input);
  if (captures.length || substack.length || publicV2) {
    const serving = await native("ping", {});
    if (publicV2 && !serving?.planCapabilities?.includes("substack-public-sources-v2")) throw new Error("Install a matching helper and receiver for public Substack articles and author-chain expansion. No source read was submitted.");
    if (substack.length && !serving?.planCapabilities?.includes("substack-browser-records-v1")) throw new Error("Install a matching local helper and receiver before resolving Substack records. No source read was submitted.");
    if (captures.length && !serving?.planCapabilities?.includes("reddit-browser-records-v1")) throw new Error("Install a matching local helper and receiver before resolving Reddit browser records. The browser preview and exported JSON remain available.");
  }
  const plan = blockPlanSchema.parse(await native("resolve", { input: { ...input, redditCaptures: captures, substackCaptures: substack } }));
  requireSubstackPublicResult(input, plan);
  requireRetainedRedditCaptures(plan, captures);
  requireRetainedSubstackCaptures(plan, substack);
  return plan;
}
