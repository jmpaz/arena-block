import { planHash } from "./compose.ts";
import type { BlockPlan, CompositionPolicy } from "./types.ts";

type CompositionInput = { policy?: Partial<CompositionPolicy> };

/** An explicit presentation choice must survive every intermediary. */
export function requiredCompositionCapabilities(input: CompositionInput): string[] {
  return [...(input.policy?.quoteAuthorLink === undefined ? [] : ["quote-author-links-v1"]),
    ...(input.policy?.parentDepth !== undefined || input.policy?.parentStyle !== undefined ? ["comment-parent-context-v1"] : [])];
}

export function requireRetainedCompositionPolicy(input: CompositionInput, plan: BlockPlan): void {
  const requested = input.policy?.quoteAuthorLink;
  const parentRequested = input.policy?.parentDepth !== undefined || input.policy?.parentStyle !== undefined;
  if (parentRequested && (plan.policy.parentDepth !== input.policy?.parentDepth || plan.policy.parentStyle !== input.policy?.parentStyle))
    throw new Error("The helper did not retain parent context options. Update the helper and receiver, then try again. No save was submitted.");
  if (requested === undefined && !parentRequested) return;
  const { hash, ...content } = plan;
  if (plan.policy.quoteAuthorLink !== requested || planHash(content) !== hash) {
    throw new Error("The helper did not retain the quoted-author style. Update the helper and receiver, then try again. No save was submitted.");
  }
}
