import { blockPlanSchema, type PlanInput, type CompositionPolicy } from "../../packages/core/types.ts";
import { redditCapturesSchema, requireRetainedRedditCaptures } from "../../packages/core/reddit-record.ts";

type NativeCall = (action: string, fields: Record<string, unknown>) => Promise<any>;
export async function resolveWithNative(input: Omit<PlanInput, "redditCaptures" | "policy"> & { redditCaptures?: PlanInput["redditCaptures"]; policy?: Partial<CompositionPolicy> }, native: NativeCall) {
  const captures = redditCapturesSchema.parse(input.redditCaptures ?? []);
  if (captures.length) {
    const serving = await native("ping", {});
    if (!serving?.planCapabilities?.includes("reddit-browser-records-v1")) throw new Error("Install a matching local helper and receiver before resolving Reddit browser records. The browser preview and exported JSON remain available.");
  }
  const plan = blockPlanSchema.parse(await native("resolve", { input: { ...input, redditCaptures: captures } }));
  requireRetainedRedditCaptures(plan, captures);
  return plan;
}
