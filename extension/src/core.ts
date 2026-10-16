import { bindSubstackCaptures, type SubstackCapture } from "../../packages/core/substack-record.ts";
import { SubstackProvider } from "../../packages/core/providers/substack.ts";
import { bindRedditCaptures, type RedditBrowserCapture } from "../../packages/core/reddit-record.ts";
import { captureSource, publicationFields, webPlan } from "../../packages/core/capture.ts";
import { composePlan, planHash } from "../../packages/core/compose.ts";
import { SocialResolver } from "../../packages/core/providers/index.ts";
import { ArenaMediaProvider } from "../../packages/core/providers/arena-media.ts";
import { AtmosphereProvider } from "../../packages/core/providers/atmosphere.ts";
import { BlueskyProvider } from "../../packages/core/providers/bluesky.ts";
import { DelveProvider } from "../../packages/core/providers/delve.ts";
import { HackerNewsProvider } from "../../packages/core/providers/hackernews.ts";
import { LobstersProvider } from "../../packages/core/providers/lobsters.ts";
import { MastodonProvider } from "../../packages/core/providers/mastodon.ts";
import { RedditProvider } from "../../packages/core/providers/reddit.ts";
import { ForumMagnumProvider } from "../../packages/core/providers/forum-magnum.ts";
import { NativeSoundCloudProvider } from "../../packages/core/providers/soundcloud-native.ts";
import { XProvider } from "../../packages/core/providers/x.ts";
import { compositionPolicySchema, type BlockPlan, type CompositionPolicy } from "../../packages/core/types.ts";
import { parseSource } from "../../packages/core/url.ts";
import { mediaSources, planMedia } from "../../packages/core/media-tree.ts";

export type CaptureInput = { primary: string[]; extras: string[]; policy: Partial<CompositionPolicy>; redditCaptures?: RedditBrowserCapture[]; substackCaptures?: SubstackCapture[] };

/** Original audio is one attachment, separate from visual compositions. */
export function mediaSelectionPolicy(plan: BlockPlan, ref: string, selected: boolean): Partial<CompositionPolicy> {
  const available = planMedia(plan), asset = available.find(asset => asset.ref === ref);
  if (!asset) throw new Error("Selected media is not available in this quote scope");
  if (selected && asset.kind === "audio") return { media: "selected", selectedMedia: [ref], mediaOrder: [ref], videoFrames: [], audio: "auto" };
  const refs = new Set(plan.policy.media === "selected" ? plan.policy.selectedMedia : plan.block.selectedMedia);
  const audio = plan.policy.audio;
  if (audio && !["auto", "mix"].includes(audio) && !available.some(asset => asset.ref === audio)
    && mediaSources(plan.sources).some(node => node.quoteDepth > 0 && node.media.some(asset => asset.ref === audio))) refs.add(audio);
  if (selected) {
    for (const node of mediaSources(plan.sources)) for (const item of node.media) if (item.kind === "audio") refs.delete(item.ref);
    refs.add(ref);
  } else refs.delete(ref);
  const order = (plan.policy.mediaOrder ?? plan.block.selectedMedia).filter(value => refs.has(value));
  for (const value of refs) if (!order.includes(value)) order.push(value);
  return { media: "selected", selectedMedia: [...refs], mediaOrder: order,
    videoFrames: (plan.policy.videoFrames ?? []).filter(value => refs.has(value)),
    ...(!selected && audio === ref ? { audio: "auto" } : {}) };
}

const browserFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  headers.delete("user-agent");
  return fetch(input, { ...init, headers, credentials: "omit" });
}) as typeof fetch;

function resolver(fetcher: typeof fetch = browserFetch, captures: RedditBrowserCapture[] = [], substack: SubstackCapture[] = []): SocialResolver {
  return new SocialResolver({
    arena: new ArenaMediaProvider(fetcher),
    reddit: new RedditProvider(fetcher, captures),
    substack: new SubstackProvider(substack, fetcher),
    forum_magnum: new ForumMagnumProvider(fetcher),
    tiktok: new AtmosphereProvider("tiktok", fetcher),
    instagram: new AtmosphereProvider("instagram", fetcher),
    x: new XProvider(undefined, fetcher),
    bluesky: new BlueskyProvider(undefined, fetcher, { retainConversationCoverage: true }),
    delve: new DelveProvider(undefined, fetcher),
    mastodon: new MastodonProvider(fetcher),
    hackernews: new HackerNewsProvider(fetcher),
    lobsters: new LobstersProvider(fetcher),
    soundcloud: new NativeSoundCloudProvider(fetcher),
  });
}

export async function resolveCapture(input: CaptureInput, signal?: AbortSignal, fetcher: typeof fetch = browserFetch): Promise<BlockPlan> {
  if (!input.primary.length || input.primary.length + input.extras.length > 20) throw new Error("Choose 1–20 sources");
  const captures = bindRedditCaptures([...input.primary, ...input.extras], input.redditCaptures ?? []);
  const substack = bindSubstackCaptures([...input.primary, ...input.extras], input.substackCaptures ?? []);
  const policy = compositionPolicySchema.parse(input.policy);
  if (input.primary.length === 1 && input.extras.length === 0 && captureSource(input.primary[0]!).kind === "url") {
    return webPlan({ url: input.primary[0]! });
  }
  const resolved = await resolver(fetcher, captures, substack).resolveComposition(input.primary, input.extras, policy, signal);
  return composePlan(resolved.posts, resolved.policy);
}

export function revisePlan(plan: BlockPlan, changes: { policy?: Partial<CompositionPolicy>; title?: string; markdown?: string; description?: string }): BlockPlan {
  const policy = changes.policy ? compositionPolicySchema.parse({ ...plan.policy, ...changes.policy }) : plan.policy;
  const composed = changes.policy ? composePlan(plan.sources, policy) : structuredClone(plan);
  const { hash: _, ...base } = composed;
  if (changes.title !== undefined) base.block.title = changes.title;
  if (changes.markdown !== undefined) base.block.markdown = changes.markdown;
  if (changes.description !== undefined) base.block.description = changes.description;
  return { ...base, hash: planHash(base) };
}

export function previewFields(plan: BlockPlan): Record<string, unknown> {
  return publicationFields(plan);
}

export function requiredOrigins(refs: string[], captures: RedditBrowserCapture[] = [], substack: SubstackCapture[] = []): string[] {
  const origins = new Set<string>();
  const keys = new Set(bindRedditCaptures(refs, captures).map(capture => parseSource(capture.sourceUrl).canonicalUrl));
  for (const capture of bindSubstackCaptures(refs, substack)) keys.add(parseSource(capture.sourceUrl).canonicalUrl);
  for (const ref of refs) {
    try { if (keys.has(parseSource(ref).canonicalUrl)) continue; } catch { /* Generic web source below. */ }
    const source = captureSource(ref);
    if (source.kind === "url") continue;
    switch (parseSource(ref).provider) {
      case "substack": break; // Use the invoked tab or local public resolver; never request new host access.
      case "arena": origins.add("https://api.are.na/*"); break;
      case "x": origins.add("https://api.fxtwitter.com/*"); break;
      case "bluesky": origins.add("https://public.api.bsky.app/*"); break;
      case "delve": origins.add("https://api.delve.town/*"); break;
      case "reddit":
        origins.add("https://www.reddit.com/*");
        break;
      case "forum_magnum": {
        const site = parseSource(ref);
        if (site.provider !== "forum_magnum") break;
        origins.add(`${site.site === "lesswrong" ? "https://www.lesswrong.com" : site.site === "alignment_forum" ? "https://www.alignmentforum.org" : "https://forum.effectivealtruism.org"}/*`);
        break;
      }
      case "instagram": case "tiktok": origins.add("https://api.atmosphere.tools/*"); break;
      case "mastodon": origins.add(`${new URL(ref).origin}/*`); break;
      case "hackernews": origins.add("https://hacker-news.firebaseio.com/*"); break;
      case "lobsters": origins.add("https://lobste.rs/*"); break;
      case "soundcloud": origins.add("https://soundcloud.com/*"); break;
    }
  }
  return [...origins];
}
