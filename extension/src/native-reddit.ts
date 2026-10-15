import { substackCapturesSchema, requireRetainedSubstackCaptures } from "../../packages/core/substack-record.ts";
import { blockPlanSchema, type PlanInput, type CompositionPolicy } from "../../packages/core/types.ts";
import { redditCapturesSchema, requireRetainedRedditCaptures } from "../../packages/core/reddit-record.ts";
import { requiredSubstackResolutionCapabilities, requireSubstackPublicResult } from "../../packages/core/substack-input-capabilities.ts";

type NativeCall = (action: string, fields: Record<string, unknown>) => Promise<any>;
export async function resolveWithNative(input: Omit<PlanInput, "redditCaptures" | "substackCaptures" | "policy"> & { redditCaptures?: PlanInput["redditCaptures"]; substackCaptures?: PlanInput["substackCaptures"]; policy?: Partial<CompositionPolicy> }, native: NativeCall) {
  const captures = redditCapturesSchema.parse(input.redditCaptures ?? []);
  const substack = substackCapturesSchema.parse(input.substackCaptures ?? []);
  const required = requiredSubstackResolutionCapabilities(input);
  if (captures.length || required.length) {
    const serving = await native("ping", {});
    const missing=required.filter(capability=>!serving?.planCapabilities?.includes(capability));
    if(missing.length)throw new Error(`Install a matching local helper and receiver for Substack acquisition (${missing.join(", ")}). No source read was submitted.`);
    if (captures.some(c => c.schema === "arena-block/reddit-public-page-capture") && !serving?.planCapabilities?.includes("reddit-public-page-records-v1")) throw new Error("The helper cannot retain Reddit public page records. No source read was submitted.");
    if (captures.length && !serving?.planCapabilities?.includes("reddit-browser-records-v1")) throw new Error("Install a matching local helper and receiver before resolving Reddit browser records. The browser preview and exported JSON remain available.");
  }
  const plan = blockPlanSchema.parse(await native("resolve", { input: { ...input, redditCaptures: captures, substackCaptures: substack } }));
  requireSubstackPublicResult(input, plan);
  requireRetainedRedditCaptures(plan, captures);
  requireRetainedSubstackCaptures(plan, substack);
  return plan;
}
