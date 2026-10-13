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
import { NativeSoundCloudProvider } from "../../packages/core/providers/soundcloud-native.ts";
import { XProvider } from "../../packages/core/providers/x.ts";
import { compositionPolicySchema, type BlockPlan, type CompositionPolicy } from "../../packages/core/types.ts";
import { parseSource } from "../../packages/core/url.ts";

export type CaptureInput = { primary: string[]; extras: string[]; policy: Partial<CompositionPolicy> };

const browserFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  headers.delete("user-agent");
  return fetch(input, { ...init, headers, credentials: "omit" });
}) as typeof fetch;

function resolver(fetcher: typeof fetch = browserFetch): SocialResolver {
  return new SocialResolver({
    arena: new ArenaMediaProvider(fetcher),
    reddit: new RedditProvider(fetcher),
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
  const policy = compositionPolicySchema.parse(input.policy);
  if (input.primary.length === 1 && input.extras.length === 0 && captureSource(input.primary[0]!).kind === "url") {
    return webPlan({ url: input.primary[0]! });
  }
  const resolved = await resolver(fetcher).resolveComposition(input.primary, input.extras, policy, signal);
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

export function requiredOrigins(refs: string[]): string[] {
  const origins = new Set<string>();
  for (const ref of refs) {
    const source = captureSource(ref);
    if (source.kind === "url") continue;
    switch (parseSource(ref).provider) {
      case "arena": origins.add("https://api.are.na/*"); break;
      case "x": origins.add("https://api.fxtwitter.com/*"); break;
      case "bluesky": origins.add("https://public.api.bsky.app/*"); break;
      case "delve": origins.add("https://api.delve.town/*"); break;
      case "reddit":
        origins.add("https://www.reddit.com/*");
        origins.add("https://vxreddit.com/*");
        origins.add("https://arctic-shift.photon-reddit.com/*");
        break;
      case "instagram": case "tiktok": origins.add("https://api.atmosphere.tools/*"); break;
      case "mastodon": origins.add(`${new URL(ref).origin}/*`); break;
      case "hackernews": origins.add("https://hacker-news.firebaseio.com/*"); break;
      case "lobsters": origins.add("https://lobste.rs/*"); break;
      case "soundcloud": origins.add("https://soundcloud.com/*"); break;
    }
  }
  return [...origins];
}
