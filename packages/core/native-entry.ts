import { resolveMediaURL, resolveMediaSources } from "./media-acquisition.ts";
import { verifyPublication, arenaImageUrl } from "./verification.ts";
import "./native-platform.ts";
import { composePlan, planHash } from "./compose.ts";
import { publicationFields, publicationPayload, publicationPayloadForMedia, captureSource } from "./capture.ts";
import { SocialResolver } from "./providers/index.ts";
import { BlueskyProvider } from "./providers/bluesky.ts";
import { NativeSoundCloudProvider } from "./providers/soundcloud-native.ts";
import { arenaMediaPost } from "./providers/arena-media.ts";
import { blockPlanSchema, compositionPolicySchema, resolvedPostSchema } from "./types.ts";
import { captureRenderRecipe } from "./render-recipe.ts";
const host = globalThis as any;
const jobs = new Map<string, AbortController>();
const resolver = new SocialResolver({ soundcloud: new NativeSoundCloudProvider(),
  bluesky: new BlueskyProvider(undefined, undefined, { retainConversationCoverage: true }) });
host.captureCancel = (id: string) => jobs.get(id)?.abort();
host.captureResolve = (id: string, refsJSON: string, policyJSON: string, refreshJSON = "false", extraRefsJSON = "[]") => {
  const policy = compositionPolicySchema.parse(JSON.parse(policyJSON));
  if (JSON.parse(refreshJSON) === true) resolver.clearSourceCache();
  const controller = new AbortController();
  jobs.get(id)?.abort();
  jobs.set(id, controller);
  resolver.resolveComposition(JSON.parse(refsJSON), JSON.parse(extraRefsJSON), policy, controller.signal)
    .then(resolved => {
      if (controller.signal.aborted || jobs.get(id) !== controller) return;
      const plan = composePlan(resolved.posts, resolved.policy);
      host.nativeResolveComplete(id, JSON.stringify({ plan, fields: publicationFields(plan) }), null);
    }, error => { if (jobs.get(id) === controller) host.nativeResolveComplete(id, null, error instanceof Error ? error.message : String(error)); })
    .catch(error => { if (jobs.get(id) === controller) host.nativeResolveComplete(id, null, String(error)); })
    .finally(() => { if (jobs.get(id) === controller) jobs.delete(id); });
};
host.captureCompose = (postsJSON: string, policyJSON: string) => {
  const plan = composePlan(resolvedPostSchema.array().parse(JSON.parse(postsJSON)), JSON.parse(policyJSON));
  return JSON.stringify({ plan, fields: publicationFields(plan) });
};
host.captureSource = (value: string) => JSON.stringify(captureSource(value));
host.captureArenaMediaPost = (block: string, blockID: string) => JSON.stringify(arenaMediaPost(JSON.parse(block), blockID));
host.captureFields = (value: string) => JSON.stringify(publicationFields(blockPlanSchema.parse(JSON.parse(value))));
host.captureRenderRecipe = (plan: string, probes: string) => JSON.stringify(captureRenderRecipe(blockPlanSchema.parse(JSON.parse(plan)), JSON.parse(probes)));
host.capturePayload = (plan: string, publicBase: string, media: string, channels: string) => JSON.stringify(publicationPayload(blockPlanSchema.parse(JSON.parse(plan)), publicBase, JSON.parse(media), JSON.parse(channels)));

host.captureVerify = (plan: string, block: string) => {
  const parsed = JSON.parse(block);
  verifyPublication(blockPlanSchema.parse(JSON.parse(plan)), parsed, parsed);
  return "null";
};
host.captureLocalPayload = (plan: string, mediaURL: string, ingestURL: string, channels: string) => JSON.stringify(publicationPayloadForMedia(blockPlanSchema.parse(JSON.parse(plan)), mediaURL || undefined, ingestURL || undefined, JSON.parse(channels)));
host.captureEdit = (planJSON: string, editsJSON: string) => {
  const { hash, ...base } = blockPlanSchema.parse(JSON.parse(planJSON));
  const edits = JSON.parse(editsJSON);
  for (const key of ["title", "markdown", "description"] as const) {
    if (edits[key] !== undefined) {
      if (typeof edits[key] !== "string") throw new Error(`Expected text for ${key}`);
      base.block[key] = edits[key];
    }
  }
  const plan = { ...base, hash: planHash(base) };
  return JSON.stringify({ plan, fields: publicationFields(plan) });
};

host.captureCopiedCover = (block: string) => arenaImageUrl(JSON.parse(block)) ?? "";

host.captureResolveMediaURL = (id: string, url: string) => {
  const controller = new AbortController();
  jobs.set(id, controller);
  resolveMediaURL(url, fetch, controller.signal)
    .then(result => host.nativeResolveComplete(id, result, null), error => host.nativeResolveComplete(id, null, error instanceof Error ? error.message : String(error)))
    .finally(() => jobs.delete(id));
};

host.captureMediaSources = (id: string, url: string) => {
  const controller = new AbortController();
  jobs.set(id, controller);
  resolveMediaSources(url, fetch, controller.signal)
    .then(result => host.nativeResolveComplete(id, JSON.stringify(result), null), error => host.nativeResolveComplete(id, null, error instanceof Error ? error.message : String(error)))
    .finally(() => jobs.delete(id));
};
