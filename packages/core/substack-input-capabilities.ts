import { parseSource } from "./url.ts";
import { planHash } from "./compose.ts";
import type { BlockPlan, CompositionPolicy } from "./types.ts";
import type { SubstackCapture } from "./substack-record.ts";
import { explicitSelections } from "./source-selection.ts";
import { renderedQuoteDepth } from "./quote-policy.ts";
type Input = { refs: string[]; extraRefs?: string[]; policy?: Partial<CompositionPolicy>; substackCaptures?: SubstackCapture[] };
function selections(input: Input) {
  const selected=explicitSelections(input.refs,input.extraRefs??[]);
  if(!input.extraRefs?.length&&input.policy?.mediaOnlyPosts?.length){const extras=new Set(input.policy.mediaOnlyPosts);for(const item of selected)if(extras.has(item.declaredIndex!))item.role="extra";}
  return selected;
}
function noteInputs(input: Input) {
  return selections(input).flatMap(item=>{const s=parseSource(item.ref);return s.provider==="substack"&&!("kind"in s)?[s]:[];});
}
function threadSeed(input: Input) {
  if(input.policy?.threadExpansion!=="on")return undefined;
  const primaries=selections(input).filter(item=>item.role==="primary"),source=primaries.length===1?parseSource(primaries[0]!.ref):undefined;
  return source?.provider==="substack"&&!("kind"in source)?source:undefined;
}
export function requiredSubstackResolutionCapabilities(input: Input): string[] {
  const required = new Set<string>();
  if (noteInputs(input).length && renderedQuoteDepth({ quote: input.policy?.quote ?? "block", quoteDepth: input.policy?.quoteDepth }) > 0) required.add("quoted-image-media-v1");
  if (noteInputs(input).length && renderedQuoteDepth({ quote: input.policy?.quote ?? "block", quoteDepth: input.policy?.quoteDepth }) > 0) required.add("quoted-video-audio-v1");
  if(input.substackCaptures?.length)required.add("substack-browser-records-v1");
  if(needsSubstackPublicV2(input))required.add("substack-public-sources-v2");
  const captured=new Set((input.substackCaptures??[]).flatMap(c=>{try{return[parseSource(c.sourceUrl).id];}catch{return[];}}));
  if(noteInputs(input).some(s=>!captured.has(s.id)))required.add("substack-note-attachments-v1");
  if(threadSeed(input))required.add("substack-note-attachments-v1");
  for(const capture of input.substackCaptures??[]){let node: SubstackCapture["note"]|undefined=capture.note;while(node){if(node.attachmentEvidence||node.quote?.status==="depth_limit"&&!node.quote.expanded)required.add("substack-note-attachments-v1");node=node.quote?.expanded;}}
  return [...required];
}
export function needsSubstackPublicV2(input: Input): boolean {
  const sources = selections(input).map(item=>parseSource(item.ref));
  return sources.some(source => source.provider === "substack" && "kind" in source)
    || !!threadSeed(input);
}
function incomplete(reason: string): Error {
  return new Error("The local helper returned an incomplete capture. Update it, then try again.", { cause: reason });
}
/** Check the returned plan because an older intermediary may discard new fields. */
export function requireSubstackPublicResult(input: Input, plan: BlockPlan): void {
  if (!needsSubstackPublicV2(input) && !requiredSubstackResolutionCapabilities(input).includes("substack-note-attachments-v1")) return;
  const { hash, ...base } = plan;
  if (planHash(base) !== hash) throw incomplete("The helper changed the Substack plan or stripped its source evidence");
  for(const source of noteInputs(input)) if(!plan.sources.some(post=>post.provider==="substack"&&post.id===source.id&&post.substackCapture))throw incomplete("The helper did not retain the requested complete Substack Note source");
  for (const ref of [...input.refs, ...(input.extraRefs ?? [])]) {
    const source = parseSource(ref);
    if (source.provider !== "substack" || !("kind" in source)) continue;
    const expected = new URL(source.canonicalUrl);
    const returned = plan.sources.find(post => { const url = new URL(post.canonicalUrl); return url.origin === expected.origin && url.pathname.replace(/\/$/, "") === expected.pathname.replace(/\/$/, ""); });
    if (!returned || returned.provider === "substack" && !returned.substackArticle || returned.provider === "web" && returned.canonicalUrl !== source.canonicalUrl) throw incomplete("The helper did not retain the requested Substack article or exact ordinary Link");
  }
  const seed = threadSeed(input);
  if (seed) {
    const primaries = plan.sources.filter(post => post.selection?.role === "primary");
    if (!primaries.length || !primaries.some(post => post.id === seed.id) || primaries[0]?.substackThread?.seedId !== seed.id
      || primaries.some(post => !post.substackRelation)) throw incomplete("The helper did not retain the verified Substack author-chain evidence");
  }
}
