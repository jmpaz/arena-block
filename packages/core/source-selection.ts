import { isInstagramReel, parseSource, type ParsedSource } from "./url.ts";

export type SourceSelection = {
  ref: string;
  role: "primary" | "extra";
  origin: "explicit" | "expanded";
  declaredIndex?: number;
  parentUri?: string;
};

function identity(source: ParsedSource): string {
  if (source.provider === "bluesky" || source.provider === "delve") return `${source.provider}:${source.handle.startsWith("did:") ? source.handle : source.handle.toLowerCase()}:${source.id}`;
  if (source.provider === "mastodon") return `mastodon:${source.server}:${source.id}`;
  if (source.provider === "reddit" && source.commentId) return `reddit-comment:${source.commentId}`;
  if (source.provider === "forum_magnum") return `forum-magnum:${source.site}:${source.commentId ? `comment:${source.commentId}` : `post:${source.id}`}`;
  return `${source.provider}:${source.id}`;
}

/** Preserve first occurrence and primary precedence before any provider request. */
export function explicitSelections(refs: string[], extraRefs: string[] = []): SourceSelection[] {
  if (!refs.length) throw new Error("At least one primary source is required");
  if (refs.length + extraRefs.length > 20) throw new Error("Use at most 20 source references");
  const seen = new Map<string, SourceSelection>();
  const selected: SourceSelection[] = [];
  for (const [index, ref] of [...refs, ...extraRefs].entries()) {
    const source = parseSource(ref);
    const key = identity(source);
    const previous = seen.get(key);
    if (previous) {
      // Keep the first source's role and position while retaining an explicit Reel alias.
      if (isInstagramReel(source.canonicalUrl)) previous.ref = source.canonicalUrl;
      continue;
    }
    const item: SourceSelection = { ref: source.canonicalUrl, role: index < refs.length ? "primary" : "extra",
      origin: "explicit", declaredIndex: index + 1 };
    selected.push(item);
    seen.set(key, item);
  }
  return selected;
}

export function selectionIdentity(ref: string): string { return identity(parseSource(ref)); }
