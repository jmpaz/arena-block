import "./native-platform.ts";
import { SubstackProvider } from "./providers/substack.ts";
import { bindSubstackCaptures, normalizeSubstackCapture, substackCapturesSchema } from "./substack-record.ts";
import { RedditProvider } from "./providers/reddit.ts";
import { bindRedditCaptures, normalizeRedditCapture, redditCapturesSchema } from "./reddit-record.ts";
import { resolveMediaURL, resolveMediaSources } from "./media-acquisition.ts";
import { verifyPublication, arenaImageUrl } from "./verification.ts";
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
function nativeResolver(captures = redditCapturesSchema.parse([]), substack = substackCapturesSchema.parse([])) { return new SocialResolver({ substack: new SubstackProvider(substack), reddit: new RedditProvider(undefined, captures), soundcloud: new NativeSoundCloudProvider(),
  bluesky: new BlueskyProvider(undefined, undefined, { retainConversationCoverage: true }) }); }
const resolver = nativeResolver();
host.captureCancel = (id: string) => jobs.get(id)?.abort();
host.captureResolve = (id: string, refsJSON: string, policyJSON: string, refreshJSON = "false", extraRefsJSON = "[]", redditCapturesJSON = "[]", substackCapturesJSON = "[]") => {
  const refs = JSON.parse(refsJSON), extras = JSON.parse(extraRefsJSON);
  const captures = bindRedditCaptures([...refs, ...extras], redditCapturesSchema.parse(JSON.parse(redditCapturesJSON)));
  const substack = bindSubstackCaptures([...refs, ...extras], substackCapturesSchema.parse(JSON.parse(substackCapturesJSON)));
  const requestResolver = captures.length || substack.length ? nativeResolver(captures, substack) : resolver;
  const policy = compositionPolicySchema.parse(JSON.parse(policyJSON));
  if (JSON.parse(refreshJSON) === true) requestResolver.clearSourceCache();
  const controller = new AbortController();
  jobs.get(id)?.abort();
  jobs.set(id, controller);
  requestResolver.resolveComposition(refs, extras, policy, controller.signal)
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
host.captureSubstackImport = (value: string) => JSON.stringify(normalizeSubstackCapture(JSON.parse(value)));
host.captureRedditImport = (value: string) => JSON.stringify(normalizeRedditCapture(JSON.parse(value)));
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
