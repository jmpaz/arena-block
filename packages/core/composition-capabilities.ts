import { planHash } from "./compose.ts";
import type { BlockPlan, CompositionPolicy } from "./types.ts";

type CompositionInput = { policy?: Partial<CompositionPolicy> };

/** An explicit presentation choice must survive every intermediary. */
export function requiredCompositionCapabilities(input: CompositionInput): string[] {
  return input.policy?.quoteAuthorLink === undefined ? [] : ["quote-author-links-v1"];
}

export function requireRetainedCompositionPolicy(input: CompositionInput, plan: BlockPlan): void {
  const requested = input.policy?.quoteAuthorLink;
  if (requested === undefined) return;
  const { hash, ...content } = plan;
  if (plan.policy.quoteAuthorLink !== requested || planHash(content) !== hash) {
    throw new Error("The helper did not retain the quoted-author style. Update the helper and receiver, then try again. No save was submitted.");
  }
}
