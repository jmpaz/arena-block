import { parseSource } from "./url.ts";
import { planHash } from "./compose.ts";
import type { BlockPlan } from "./types.ts";
type Input = { refs: string[]; extraRefs?: string[]; policy?: { threadExpansion?: string } };
export function needsSubstackPublicV2(input: Input): boolean {
  const sources = [...input.refs, ...(input.extraRefs ?? [])].flatMap(ref => { try { return [parseSource(ref)]; } catch { return []; } });
  return sources.some(source => source.provider === "substack" && "kind" in source)
    || input.refs.length === 1 && input.policy?.threadExpansion === "on" && sources[0]?.provider === "substack";
}
/** Preflight alone cannot prove a middle client retained fields introduced after its own schema. */
export function requireSubstackPublicResult(input: Input, plan: BlockPlan): void {
  if (!needsSubstackPublicV2(input)) return;
  const { hash, ...base } = plan;
  if (planHash(base) !== hash) throw new Error("The helper changed the Substack plan or stripped its source evidence");
  for (const ref of [...input.refs, ...(input.extraRefs ?? [])]) {
    const source = parseSource(ref);
    if (source.provider !== "substack" || !("kind" in source)) continue;
    const expected = new URL(source.canonicalUrl);
    const returned = plan.sources.find(post => { const url = new URL(post.canonicalUrl); return url.origin === expected.origin && url.pathname.replace(/\/$/, "") === expected.pathname.replace(/\/$/, ""); });
    if (!returned || returned.provider === "substack" && !returned.substackArticle || returned.provider === "web" && returned.canonicalUrl !== source.canonicalUrl) throw new Error("The helper did not retain the requested Substack article or exact ordinary Link");
  }
  const seed = input.refs.length === 1 ? parseSource(input.refs[0]!) : undefined;
  if (seed?.provider === "substack" && !("kind" in seed) && input.policy?.threadExpansion === "on") {
    const primaries = plan.sources.filter(post => post.selection?.role === "primary");
    if (!primaries.length || !primaries.some(post => post.id === seed.id) || primaries[0]?.substackThread?.seedId !== seed.id
      || primaries.some(post => !post.substackRelation)) throw new Error("The helper did not retain the verified Substack author-chain evidence");
  }
}
