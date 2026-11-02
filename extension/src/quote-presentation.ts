import { composePlan } from "../../packages/core/compose.ts";
import type { BlockPlan, CompositionPolicy } from "../../packages/core/types.ts";
import { revisePlan } from "./core.ts";

export type QuoteAuthorChoice = "" | "source" | "plain";

export function quoteAuthorChoice(value: unknown, plan?: BlockPlan): QuoteAuthorChoice {
  if (value === "source" || value === "plain" || value === "") return value;
  return plan?.policy.quoteAuthorLink ?? "";
}

export function quoteAuthorPolicy(choice: QuoteAuthorChoice): Partial<CompositionPolicy> {
  return choice ? { quoteAuthorLink: choice } : {};
}

export function reviseQuoteAuthorLink(plan: BlockPlan, choice: QuoteAuthorChoice,
  edits?: { title?: string; markdown?: string; description?: string }): BlockPlan {
  const policy = { ...plan.policy };
  delete policy.quoteAuthorLink;
  const composed = composePlan(plan.sources, { ...policy, ...quoteAuthorPolicy(choice) });
  return edits ? revisePlan(composed, edits) : composed;
}
