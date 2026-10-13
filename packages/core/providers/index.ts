import { compositionPolicySchema, type CompositionPolicy, type ResolvedPost } from "../types.ts";
import { parseSource } from "../url.ts";
import { explicitSelections, selectionIdentity } from "../source-selection.ts";
import { DelveProvider } from "./delve.ts";
import { BlueskyProvider } from "./bluesky.ts";
import { assignMediaRefs, type SocialProvider, type SourceResolutionPolicy } from "./provider.ts";
import { XProvider } from "./x.ts";
import { HackerNewsProvider } from "./hackernews.ts";
import { LobstersProvider } from "./lobsters.ts";
import { MastodonProvider } from "./mastodon.ts";

import { RedditProvider } from "./reddit.ts";
import { AtmosphereProvider } from "./atmosphere.ts";
import { ArenaMediaProvider } from "./arena-media.ts";

export class SocialResolver {
  private readonly providers: Partial<Record<ReturnType<typeof parseSource>["provider"], SocialProvider>>;

  constructor(providers?: Partial<Record<ReturnType<typeof parseSource>["provider"], SocialProvider>>) {
    this.providers = {
      arena: providers?.arena ?? new ArenaMediaProvider(),
      reddit: providers?.reddit ?? new RedditProvider(),
      tiktok: providers?.tiktok ?? new AtmosphereProvider("tiktok"),
      instagram: providers?.instagram ?? new AtmosphereProvider("instagram"),
      x: providers?.x ?? new XProvider(),
      bluesky: providers?.bluesky ?? new BlueskyProvider(),
      delve: providers?.delve ?? new DelveProvider(),
      mastodon: providers?.mastodon ?? new MastodonProvider(),
      hackernews: providers?.hackernews ?? new HackerNewsProvider(),
      lobsters: providers?.lobsters ?? new LobstersProvider(),
      soundcloud: providers?.soundcloud,
    };
  }

  clearSourceCache(): void { (this.providers.x as XProvider).clearCache?.(); }

  async resolve(refs: string[], signal?: AbortSignal, policy?: Partial<SourceResolutionPolicy>): Promise<ResolvedPost[]> {
    if (!refs.length || refs.length > 20) throw new Error("Resolve 1–20 source references");
    const sources = refs.map(parseSource);
    const posts = await Promise.all(sources.map((source) => {
      const provider = this.providers[source.provider];
      if (!provider) throw new Error(`No resolver is configured for ${source.provider}`);
      return provider.resolve(source, signal, policy);
    }));
    return posts.map(assignMediaRefs);
  }

  /** Resolve the effective ordered source set and freeze each source's contribution role. */
  async resolveComposition(refs: string[], extraRefs: string[] = [], policyInput: Partial<CompositionPolicy> = {}, signal?: AbortSignal): Promise<{ posts: ResolvedPost[]; policy: CompositionPolicy }> {
    const selected = explicitSelections(refs, extraRefs);
    // Older plan clients may declare media-only indexes directly in policy.
    if (!extraRefs.length && policyInput.mediaOnlyPosts?.length) {
      const legacy = new Set(policyInput.mediaOnlyPosts);
      for (const item of selected) if (legacy.has(item.declaredIndex!)) item.role = "extra";
    }
    const primaries = selected.filter(item => item.role === "primary");
    const extras = selected.filter(item => item.role === "extra");
    const policy = compositionPolicySchema.parse(policyInput);
    let primaryPosts: ResolvedPost[];
    if (primaries.length === 1 && parseSource(primaries[0]!.ref).provider === "x" && policy.threadExpansion === "on") {
      const source = parseSource(primaries[0]!.ref);
      const provider = this.providers.x;
      if (source.provider !== "x" || !(provider instanceof XProvider)) throw new Error("x.com thread import is unavailable; add posts explicitly");
      const discovered = await provider.discoverLinear(source, signal, policy);
      primaryPosts = discovered.posts.map((post, index) => ({ ...post, selection: {
        role: "primary" as const, origin: post.id === discovered.seedId ? "explicit" as const : "expanded" as const,
        ...(post.id === discovered.seedId ? { declaredIndex: primaries[0]!.declaredIndex } : {}),
        ...(index > 0 ? { parentUri: discovered.posts[index - 1]!.canonicalUrl } : {}),
      } }));
    } else if (primaries.length === 1 && parseSource(primaries[0]!.ref).provider === "bluesky" && policy.threadExpansion !== "off") {
      const source = parseSource(primaries[0]!.ref);
      const provider = this.providers.bluesky;
      if (source.provider !== "bluesky" || !(provider instanceof BlueskyProvider)) throw new Error("Bluesky thread discovery is unavailable; turn thread expansion off or choose posts explicitly");
      const discovered = await provider.discoverLinear(source, signal);
      primaryPosts = discovered.posts.map(post => {
        const uri = `at://${discovered.seedUri.split("/")[2]}/app.bsky.feed.post/${post.id}`;
        const explicit = uri === discovered.seedUri;
        return { ...post, selection: { role: "primary" as const, origin: explicit ? "explicit" as const : "expanded" as const,
          ...(explicit ? { declaredIndex: primaries[0]!.declaredIndex } : {}),
          ...(discovered.parentUris.get(uri) ? { parentUri: discovered.parentUris.get(uri) } : {}) } };
      });
    } else if (primaries.length === 1 && parseSource(primaries[0]!.ref).provider === "delve" && policy.threadExpansion !== "off") {
      const source = parseSource(primaries[0]!.ref);
      const provider = this.providers.delve;
      if (source.provider !== "delve" || !(provider instanceof DelveProvider)) throw new Error("Delvetown thread discovery is unavailable; turn thread expansion off or choose posts explicitly");
      const discovered = await provider.discoverLinear(source, signal);
      primaryPosts = discovered.posts.map(post => {
        const uri = post.atproto?.uri;
        if (!uri) throw new Error("Delvetown thread post is missing its record identity");
        const explicit = uri === discovered.seedUri;
        return { ...post, selection: { role: "primary" as const, origin: explicit ? "explicit" as const : "expanded" as const,
          ...(explicit ? { declaredIndex: primaries[0]!.declaredIndex } : {}),
          ...(discovered.parentUris.get(uri) ? { parentUri: discovered.parentUris.get(uri) } : {}) } };
      });
    } else {
      primaryPosts = await Promise.all(primaries.map(async item => {
        const source = parseSource(item.ref);
        const provider = this.providers[source.provider];
        if (!provider) throw new Error(`No resolver is configured for ${source.provider}`);
        return { ...await provider.resolve(source, signal, policy), selection: { role: "primary" as const, origin: "explicit" as const, declaredIndex: item.declaredIndex } };
      }));
    }
    const extraPosts = await Promise.all(extras.map(async item => {
      const source = parseSource(item.ref);
      const provider = this.providers[source.provider];
      if (!provider) throw new Error(`No resolver is configured for ${source.provider}`);
      return { ...await provider.resolve(source, signal, policy), selection: { role: "extra" as const, origin: "explicit" as const, declaredIndex: item.declaredIndex } };
    }));
    // A provider can reveal an identity that was not apparent from an alias or
    // an automatically discovered thread member. Keep the first primary copy.
    const seen = new Set<string>();
    const posts = [...primaryPosts, ...extraPosts].filter(post => {
      const key = selectionIdentity(post.canonicalUrl);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (posts.length > 20) throw new Error("Expanded source selection exceeds 20 posts; turn thread expansion off or choose posts explicitly");
    const effective = compositionPolicySchema.parse({ ...policy,
      ...(extraRefs.length || policyInput.mediaOnlyPosts?.length
        ? { mediaOnlyPosts: posts.flatMap((post, index) => post.selection?.role === "extra" ? [index + 1] : []) } : {}) });
    return { posts: posts.map(assignMediaRefs), policy: effective };
  }
}
export { ArenaMediaProvider, arenaMediaPost } from "./arena-media.ts";
