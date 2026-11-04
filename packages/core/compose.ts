import { balancedMosaicLayout } from "./mosaic-layout.ts";
import { createHash } from "node:crypto";
import type {
  BlockPlan,
  CompositionPolicy,
  LayoutNode,
  MediaAsset,
  ResolvedPost,
} from "./types.ts";
import { compositionPolicySchema, DEFAULT_QUOTE_DEPTH, DEFAULT_VIDEO_FRAME_THRESHOLD_SECONDS, MAX_EXPANDED_SOURCE_POSTS, MAX_QUOTE_DEPTH, SCHEMA_VERSION } from "./types.ts";
import { combineAspects, explicitAudio, mediaAspect, tileRects, IMAGE_RECIPE_LONG_EDGE, IMAGE_RECIPE_MIN_TILE, VIDEO_RECIPE_LONG_EDGE, VIDEO_RECIPE_MIN_TILE, even } from "./render-recipe.ts";
import { atprotoMarkdown } from "./providers/atproto-post.ts";
import { availableQuoteNodes, quoteDateLabel, renderedQuoteDepth } from "./quote-policy.ts";
import { assertSoundCloudAudioIntent, soundCloudPlaylistText } from "./soundcloud.ts";
import { isInstagramReel, parseSource } from "./url.ts";
import { mediaSources, selectableMedia, planMedia } from "./media-tree.ts";
import { renderedParentDepth, type ParentEntry } from "./parent-context.ts";
import { selectionIdentity } from "./source-selection.ts";

function handle(post: ResolvedPost): string {
  return post.author.handle.replace(/^@/, "");
}

function authorTag(post: ResolvedPost): string {
  return post.provider === "reddit" ? handle(post) : `@${handle(post)}`;
}

function sourceAuthor(post: ResolvedPost): string {
  return `${post.provider}:${handle(post).toLowerCase()}`;
}

function expandedThread(posts: ResolvedPost[]): boolean {
  if (posts.length < 3 || posts.some(post => post.selection?.role !== "primary")
    || posts.filter(post => post.selection?.origin === "explicit").length !== 1) return false;
  return posts.every((post, index) => {
    if (sourceAuthor(post) !== sourceAuthor(posts[0]!)) return false;
    if (!index) return true;
    const previous = posts[index - 1]!;
    if (post.replyTo && post.replyTo.id !== previous.id) return false;
    const parent = post.selection?.parentUri;
    try {
      if (post.provider === "forum_magnum") {
        const source = parseSource(previous.canonicalUrl), current = parseSource(post.canonicalUrl);
        return source.provider === "forum_magnum" && current.provider === "forum_magnum" && source.site === current.site
          && source.id === current.id && source.commentId === previous.id && current.commentId === post.id
          && post.replyTo?.id === previous.id && parent === `forum-magnum:${source.site}:comment:${previous.id}`;
      }
      if (post.provider !== "bluesky" && post.provider !== "delve") return post.replyTo?.id === previous.id;
      if (!parent) return false;
      if (previous.atproto) return parent === previous.atproto.uri;
      return parseSource(parent).provider === post.provider
        && selectionIdentity(parent) === selectionIdentity(previous.canonicalUrl);
    } catch { return false; }
  });
}

function title(post: ResolvedPost, thread = false): string {
  if (post.postTitle !== undefined) return thread && post.provider === "substack" && !post.substackArticle
    && [`Note by @${handle(post)}`, `Substack Note by @${handle(post)}`].includes(post.postTitle)
    ? `Thread by @${handle(post)}` : post.postTitle;
  if (post.storyTitle !== undefined) return `${thread ? "Thread" : "Comment"} by ${handle(post)} on “${post.storyTitle}”`;
  if (post.provider === "hackernews" || post.provider === "lobsters") return `Comment by ${handle(post)}`;
  if (post.provider === "instagram" && isInstagramReel(post.canonicalUrl)) return `${thread ? "Thread" : "Reel"} by @${handle(post)}`;
  if (post.provider === "tiktok") return `${thread ? "Thread" : "TikTok"} by @${(post.author.name?.trim() || handle(post)).replace(/^@/, "")}`;
  return `${thread ? "Thread" : "Post"} by @${handle(post)}`;
}

function body(post: ResolvedPost): string {
  const text = atprotoMarkdown(post);
  return post.provider === "linkedin" ? text.replace(/^( {0,3})(?=#+)/gm, "$1\\") : text;
}

// Escape source lines containing thematic-break syntax before adding dividers.
function escapeAuthoredSeparators(value: string): string {
  return value.split("\n").map(line => line.replace(/^( {0,3})([-*_])(?:(?:[ \t]*\2)){2,}[ \t]*$/, (_match, indent: string, delimiter: string) =>
    `${indent}\\${delimiter}${line.slice(indent.length + 1)}`)).join("\n");
}

function description(posts: ResolvedPost[]): string | undefined {
  const introductions = posts
    .filter((post) => post.article !== undefined && post.text.trim())
    .map((post) => escapeAuthoredSeparators(post.text.trim()));
  const dates = posts.filter(post => post.storyTitle !== undefined && post.provider !== "forum_magnum")
    .flatMap(post => post.postedAt ? [`Posted at: ${post.postedAt}`] : []);
  return [...dates, ...introductions].join("\n\n---\n\n") || undefined;
}

const MEDIA_FIRST_PROVIDERS = new Set<ResolvedPost["provider"]>(["linkedin", "reddit", "instagram", "tiktok", "arena", "soundcloud"]);

function mediaMarker(media: MediaAsset[], frameRefs: Set<string>): string {
  if (!media.length) return "";
  if(media.some(asset=>asset.sourceAttribution)){
    const literal=(value:string)=>value.replace(/[\r\n]+/g," ").replace(/[\\`*_{}\[\]<>]/g,"\\$&");
    return media.map(asset=>{
      const source=asset.sourceAttribution;
      return source?`*Audio from [${literal(source.title)}](<${source.url}>), by ${source.authors.map(literal).join(", ")}*`:
        `*[${frameRefs.has(asset.ref)?"video frame":asset.kind}]*`;
    }).join("\n\n");
  }
  const kinds = media.map((item) => frameRefs.has(item.ref) ? "video frame" : item.kind);
  const uniform = new Set(kinds).size === 1;
  return `*[${uniform && kinds.length > 1 ? `${kinds[0]}s` : kinds.join(", ")}]*`;
}

function quoteBody(post: ResolvedPost, frameRefs: Set<string>): string {
  return [escapeAuthoredSeparators(body(post).trim()), mediaMarker(post.media, frameRefs)].filter(Boolean).join("\n\n");
}

function withoutCarriedMedia(post: ResolvedPost, carried: Set<string>): ResolvedPost {
  if (!MEDIA_FIRST_PROVIDERS.has(post.provider)) return post;
  const quote = post.quote && withoutCarriedMedia(post.quote, carried);
  return { ...post, media: post.media.filter((item) => !carried.has(item.url)), ...(quote ? { quote } : {}) };
}

function blockquote(body: string): string {
  return body.split("\n").map((line) => line ? `> ${line}` : ">").join("\n");
}

function codeSpan(value: string): string {
  const text = value.replace(/[\r\n]+/g, " ");
  const fence = "`".repeat(Math.max(0, ...[...text.matchAll(/`+/g)].map(match => match[0].length)) + 1);
  return `${fence}${text.includes("`") || /^ | $/.test(text) ? ` ${text} ` : text}${fence}`;
}

// Comment ancestry and authored quotes share the existing nesting convention.
function withPrior(own: string, prior: string, nested: boolean): string {
  return [prior && nested ? blockquote(prior) : prior, own].filter(Boolean).join("\n\n");
}

function quoteHeader(post: ResolvedPost, root: ResolvedPost, policy: CompositionPolicy): string {
  const date = quoteDateLabel(root, post, policy.quoteDates).label;
  // A quote is an independently authored source, even when the quoting
  // account also wrote it. Keep both identities visible at the boundary.
  const author = codeSpan(authorTag(post));
  const linked = policy.quoteAuthorLink === "source" || policy.quoteAuthorLink === undefined && post.provider === "substack";
  const credit = linked ? `[${author}](<${post.canonicalUrl}>)` : author;
  const lead = [credit, date ? `(${date})` : ""].filter(Boolean).join(" ");
  return [lead, post.quoteSnapshot ? "*[embedded source snapshot; standalone quote unavailable]*" : ""].filter(Boolean).join(" · ");
}

function quoteBoundary(post: ResolvedPost): string {
  const boundary = post.quoteBoundary;
  if (!boundary) return "";
  const label = `Quoted post ${boundary.status.replaceAll("_", " ")}`;
  return boundary.canonicalUrl ? `*[${label}](${boundary.canonicalUrl})*` : `*[${label}]*`;
}

function renderQuoted(post: ResolvedPost, root: ResolvedPost, policy: CompositionPolicy, depth: number, visited: Set<ResolvedPost>, frameRefs: Set<string>): string {
  if (visited.has(post)) return "*[Cyclic quoted source omitted]*";
  const path = new Set(visited); path.add(post);
  const own = [quoteHeader(post, root, policy), quoteBody(depth < renderedQuoteDepth(policy) ? post : { ...post, embeddedRecord: undefined }, frameRefs)].filter(Boolean).join(post.provider === "substack" ? "\n\n" : "\n");
  const descendant = depth < renderedQuoteDepth(policy) && post.quote ? renderQuoted(post.quote, root, policy, depth + 1, path, frameRefs) : "";
  const boundary = depth < renderedQuoteDepth(policy) ? quoteBoundary(post) : "";
  const prior = descendant || boundary;
  return withPrior(own, prior, policy.quote === "block");
}

function renderParents(post: ResolvedPost, policy: CompositionPolicy, frameRefs: Set<string>): string | undefined {
  const depth = renderedParentDepth(policy), context = post.parentContext;
  if (!depth) return undefined;
  if (!context) {
    if (post.provider === "hackernews" || post.provider === "lobsters") throw new Error("This comment snapshot has no parent evidence. Read the source again before including parent context. No block was created.");
    return undefined;
  }
  // A selected submission has no ancestors; a retained depth preference leaves it intact.
  if (!context.parents.length && context.stopped === "submission"
    && context.submission?.id === post.id && context.submission.canonicalUrl === post.canonicalUrl) return undefined;
  const parents = context.parents.slice(0, depth);
  const boundary = (depth > parents.length && context.stopped !== "submission") || (depth === MAX_QUOTE_DEPTH && context.stopped === "depth_limit")
    ? `*[Further parent context ${context.stopped.replaceAll("_", " ")}]${context.boundary ? `(<${context.boundary.canonicalUrl}>)` : ""}*` : "";
  function entry(parent: ParentEntry): string {
    if (parent.status !== "available") return `*[Parent comment ${parent.status}](<${parent.canonicalUrl}>)*`;
    const node: ResolvedPost = { provider: post.provider, id: parent.id, canonicalUrl: parent.canonicalUrl,
      author: parent.author!, text: parent.text!, postedAt: parent.postedAt, media: [] };
    return policy.parentStyle === "quote"
      ? [quoteHeader(node, post, policy), quoteBody(node, frameRefs)].join("\n")
      : `${codeSpan(handle(node))}\n${quoteBody(node, frameRefs)}`;
  }
  if (policy.parentStyle !== "quote") {
    return [boundary, ...[...parents].reverse().map(entry), `${codeSpan(handle(post))}\n${quoteBody(post, frameRefs)}`].filter(Boolean).join("\n\n---\n\n");
  }
  let prior = boundary;
  for (const parent of [...parents].reverse()) prior = withPrior(entry(parent), prior, true);
  return withPrior(quoteBody(post, frameRefs), prior, true);
}

function renderPost(post: ResolvedPost, policy: CompositionPolicy, frameRefs: Set<string>, quoteAfterText = false): string {
  const parents = renderParents(post, policy, frameRefs);
  if (parents !== undefined) return parents;
  const text = quoteBody(!renderedQuoteDepth(policy) ? { ...post, embeddedRecord: undefined } : post, frameRefs);
  if (!renderedQuoteDepth(policy)) return text;
  if (!post.quote) return [quoteBoundary(post), text].filter(Boolean).join("\n\n");
  const quoted = renderQuoted(post.quote, post, policy, 1, new Set([post]), frameRefs);
  if (policy.quote === "sequence") {
    return (quoteAfterText ? [text, quoted] : [quoted, text]).filter(Boolean).join("\n\n");
  }
  return (quoteAfterText ? [text, blockquote(quoted)] : [blockquote(quoted), text]).filter(Boolean).join("\n\n");
}

function renderSequence(posts: ResolvedPost[], policy: CompositionPolicy, frameRefs: Set<string> = new Set()): string {
  const multiSource = posts.length > 1;
  const entries = posts.map((post, index) => {
    const previous = posts[index - 1];
    const sameAuthorReply = index > 0 && post.provider === "x" && previous?.provider === "x"
      && sourceAuthor(post) === sourceAuthor(previous) && post.replyTo?.id === previous.id;
    const hasCarriedReplyAddress = sameAuthorReply && !post.quote
      && post.replyAddressPrefix && post.text.startsWith(post.replyAddressPrefix);
    // Only omit x.com's reply-address run for a verified adjacent same-author
    // thread reply. Quote bodies, roots, mixed speakers and inline mentions
    // remain literal source text.
    const body = renderPost(hasCarriedReplyAddress ? { ...post, text: post.text.slice(post.replyAddressPrefix!.length) } : post,
      policy, frameRefs, sameAuthorReply && !!post.quote);
    if (!multiSource) return body;
    // The title identifies the first speaker. Label turns, not every post;
    // source URLs and exact times remain in plan.sources.
    const speakerChanged = index > 0 && sourceAuthor(post) !== sourceAuthor(posts[index - 1]!);
    const forumHeader = post.provider === "forum_magnum"
      ? [`\`${authorTag(post)}\``, post.postedAt ? `([${post.postedAt.slice(0, 10)}](<${post.canonicalUrl}>))` : `[Source](<${post.canonicalUrl}>)`].join(" ") : "";
    const flatParentHeader = renderedParentDepth(policy) > 0 && post.parentContext && policy.parentStyle !== "quote";
    return [forumHeader || (speakerChanged && !flatParentHeader ? `\`${authorTag(post)}\`` : ""), body].filter(Boolean).join("\n");
  });
  return entries.reduce((rendered, entry, index) => {
    if (!index) return entry;
    const divider = policy.separator !== "never";
    return `${rendered}${divider ? "\n\n---\n\n" : "\n\n"}${entry}`;
  }, "");
}

function selectedMedia(posts: ResolvedPost[], policy: CompositionPolicy): MediaAsset[] {
  const rootMedia = selectableMedia(posts, renderedQuoteDepth(policy));
  if (policy.media === "none") return [];
  if (policy.media === "selected") {
    const requested = new Set(policy.selectedMedia);
    return rootMedia.filter((item) => requested.has(item.ref));
  }
  if (policy.media === "all") return rootMedia;
  if (policy.media === "video") return rootMedia.filter((item) => item.kind === "video");
  if (policy.media === "audio") return rootMedia.filter((item) => item.kind === "audio");
  if (policy.media === "images") return rootMedia.filter((item) => item.kind === "image");
  // Auto keeps root-post media. Retain quoted assets only when an existing
  // order, frame or soundtrack choice names them explicitly.
  const audioRef = explicitAudio(policy);
  const explicitRefs = new Set([...(policy.mediaOrder ?? []), ...(policy.videoFrames ?? []), ...(policy.videoMotion ?? []), ...(audioRef ? [audioRef] : [])]);
  const nodes = mediaSources(posts, renderedQuoteDepth(policy));
  const quotedMedia = nodes.filter(node => node.quoteDepth > 0)
    .flatMap(node => node.media).filter(item => explicitRefs.has(item.ref));
  const automaticMedia = nodes.flatMap(node => node.quoteDepth ? node.media.filter(item => explicitRefs.has(item.ref)) : node.media)
    .filter(item => item.sourcePlacement !== "body");
  if(automaticMedia.length>1&&automaticMedia.every(asset=>asset.kind==="audio")&&automaticMedia.some(asset=>asset.sourceAttribution))
    throw new Error("Choose one original audio attachment. Audio files must be captured separately.");
  if (quotedMedia.some(item => item.kind !== "image")) {
    const visuals = automaticMedia.filter(item => item.kind !== "audio");
    if (visuals.length) return visuals;
    const audio = automaticMedia.filter(item => item.kind === "audio");
    if (audio.length > 1) throw new Error("Choose one original audio attachment. Audio files must be captured separately.");
    return audio;
  }
  // Native podcast audio is an alternative to its visuals, never an automatic
  // soundtrack for an ordered composition or media extra.
  if (policy.mediaOnlyPosts?.length || posts.length > 1) return automaticMedia.filter(item => item.kind !== "audio");
  if (MEDIA_FIRST_PROVIDERS.has(posts[0]!.provider)) return automaticMedia;
  const video = automaticMedia.find((item) => item.kind === "video");
  const images = automaticMedia.filter((item) => item.kind === "image");
  const publicAudio = posts[0]!.provider === "substack" ? automaticMedia.find(item => item.kind === "audio" && item.acquisition === "substack-public-original") : undefined;
  return video ? [video, ...quotedMedia] : images.length ? images : publicAudio ? [publicAudio] : [];
}

const RETAINED_ARRANGEMENTS = 32;

type Arrangement = { node: LayoutNode; aspect: number; shape: string };

function squareness(aspect: number): number {
  return Math.abs(Math.log(aspect));
}

function leaf(item: MediaAsset): Arrangement {
  return { node: { kind: "media", ref: item.ref }, aspect: mediaAspect(item), shape: "." };
}

function join(axis: "horizontal" | "vertical", parts: Arrangement[]): Arrangement {
  return {
    node: { kind: "split", axis, children: parts.map((part) => part.node) },
    aspect: combineAspects(axis, parts.map((part) => part.aspect)),
    shape: `${axis[0]}(${parts.map((part) => part.shape).join(",")})`,
  };
}

function arrangements(items: Arrangement[]): Arrangement[] {
  if (items.length === 1) return items;
  const midpoint = Math.ceil(items.length / 2);
  const rights = arrangements(items.slice(midpoint));
  const mirrored = midpoint * 2 === items.length
    && items.slice(midpoint).every((item, index) => item.shape === items[index]!.shape);
  const combined = arrangements(items.slice(0, midpoint)).flatMap((left) =>
    rights.filter((right) => !mirrored || right.shape === left.shape).flatMap((right) => [
      join("horizontal", [left, right]),
      join("vertical", [left, right]),
    ]),
  );
  const seen = new Set<number>();
  return combined
    .filter((candidate) => {
      const key = Math.round(candidate.aspect * 1000);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => squareness(a.aspect) - squareness(b.aspect))
    .slice(0, RETAINED_ARRANGEMENTS);
}

function squarest(items: Arrangement[]): Arrangement {
  return arrangements(items)[0]!;
}

function imageGroup(images: MediaAsset[]): Arrangement | undefined {
  if (!images.length) return undefined;
  const portraits = images.every((item) => item.width && item.height && item.width <= item.height);
  if (images.length === 3 && portraits) return join("horizontal", images.map(leaf));
  return squarest(images.map(leaf));
}

function rowArrangements(media: MediaAsset[]): Arrangement[] {
  // Contiguous rows make order spatial: left to right, then top to bottom.
  // A recursive square layout can instead place the next item below the first.
  return media.map((_, index) => {
    const columns = index + 1;
    const rows: Arrangement[] = [];
    for (let offset = 0; offset < media.length; offset += columns) {
      const items = media.slice(offset, offset + columns).map(leaf);
      rows.push(items.length === 1 ? items[0]! : join("horizontal", items));
    }
    return rows.length === 1 ? rows[0]! : join("vertical", rows);
  }).sort((a, b) => squareness(a.aspect) - squareness(b.aspect));
}

function orderedLayout(media: MediaAsset[]): LayoutNode | undefined {
  return media.length ? rowArrangements(media)[0]!.node : undefined;
}

function legibleMediaLayout(media: MediaAsset[], preferred: LayoutNode): LayoutNode {
  // Leave existing valid layouts byte-for-byte intact. Search at most 100
  // contiguous row widths; never remove/reorder assets or enlarge the canvas.
  if (media.length < 2 || media.length > 100 || media.some(item => !["image", "video"].includes(item.kind))) return preferred;
  const video = media.some(item => item.kind === "video");
  const native = Math.max(0, ...media.map(item => Math.max(item.width ?? 0, item.height ?? 0)));
  const longEdge = video ? even(Math.min(VIDEO_RECIPE_LONG_EDGE, native || VIDEO_RECIPE_LONG_EDGE)) : IMAGE_RECIPE_LONG_EDGE;
  const minTile = video ? VIDEO_RECIPE_MIN_TILE : IMAGE_RECIPE_MIN_TILE;
  const assets = new Map(media.map(item => [item.ref, item]));
  const fits = (node: LayoutNode) => [...tileRects(node, assets, longEdge, 0).rects.values()]
    .every(rect => Math.min(rect.width, rect.height) >= minTile);
  if (fits(preferred)) return preferred;
  return rowArrangements(media).find(candidate => fits(candidate.node))?.node ?? preferred;
}

function compactLayoutFor(posts: ResolvedPost[], media: MediaAsset[], ordered: boolean): LayoutNode | undefined {
  if (ordered) {
    const preferred = orderedLayout(media);
    return preferred ? legibleMediaLayout(media, preferred) : undefined;
  }
  const selected = new Set(media.map((item) => item.ref));
  const groups = posts.flatMap((post) => {
    const chosen = post.media.filter((item) => selected.has(item.ref));
    if (!chosen.length) return [];
    if (MEDIA_FIRST_PROVIDERS.has(post.provider)) return [squarest(chosen.map(leaf))];
    const videos = chosen.filter((item) => item.kind === "video").map(leaf);
    const images = imageGroup(chosen.filter((item) => item.kind === "image"));
    return [squarest([...videos, ...(images ? [images] : [])])];
  });
  return groups.length ? legibleMediaLayout(media, squarest(groups).node) : undefined;
}

function layoutFor(posts: ResolvedPost[], media: MediaAsset[], ordered: boolean, mode: CompositionPolicy["mosaicLayout"]): LayoutNode | undefined {
  const preferred = compactLayoutFor(posts, media, ordered);
  return preferred ? balancedMosaicLayout(media, preferred, mode, ordered) : undefined;
}

export function reviseMosaicLayout(plan: BlockPlan, mode: NonNullable<CompositionPolicy["mosaicLayout"]>): BlockPlan {
  if (plan.block.excerpt) throw new Error("Text excerpts do not have a media layout; retain their exact text plan");
  const { hash, ...original } = plan;
  if (planHash(original) !== hash) throw new Error("The retained plan hash does not match its content. No layout was changed.");
  const policy = compositionPolicySchema.parse({ ...plan.policy, mosaicLayout: mode });
  const frames = new Map((plan.block.frameMedia ?? []).map(item => [item.ref, item.url]));
  const effective = (item: MediaAsset): MediaAsset => frames.has(item.ref)
    ? { ...item, kind: "image", url: frames.get(item.ref)! } : item;
  const assets = new Map(planMedia(plan).map(item => [item.ref, effective(item)]));
  const media = plan.block.selectedMedia.map(ref => {
    const item = assets.get(ref); if (!item) throw new Error(`Selected media ${ref} is missing from the retained plan`); return item;
  });
  const ordered = policy.mediaOrder !== undefined || mediaSources(plan.sources).some(node => node.quoteDepth > 0
    && node.media.some(item => plan.block.selectedMedia.includes(item.ref)));
  const layout = media.length > 1 && media.every(item => item.kind !== "audio")
    ? layoutFor(plan.sources.map(post => ({ ...post, media: post.media.map(effective) })), media, ordered, mode) : plan.block.layout;
  const { hash: _hash, ...body } = plan;
  const base = { ...body, policy, block: { ...body.block, ...(layout ? { layout } : {}) } };
  return { ...base, hash: planHash(base) };
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function planHash(value: Omit<BlockPlan, "hash">): string {
  // Posters are presentation hints. Their signed URLs may rotate between
  // reads without changing the chosen source, media, or publication intent.
  const withoutPosters = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(withoutPosters);
    if (item && typeof item === "object") return Object.fromEntries(
      Object.entries(item as Record<string, unknown>)
        .filter(([key]) => key !== "posterUrl")
        .map(([key, nested]) => [key, key === "frameMedia" && Array.isArray(nested)
          ? nested.map(frame => {
            const item = frame as { ref: string; url: string }, url = new URL(item.url);
            return { ref: item.ref, url: url.origin + url.pathname };
          }) : withoutPosters(nested)]),
    );
    return item;
  };
  return createHash("sha256").update(stable(withoutPosters(value))).digest("hex");
}

export function composePlan(
  posts: ResolvedPost[],
  policyInput: Partial<CompositionPolicy> = {},
): BlockPlan {
  if (!posts.length) throw new Error("At least one resolved post is required");
  if (posts.length > MAX_EXPANDED_SOURCE_POSTS) throw new Error(`At most ${MAX_EXPANDED_SOURCE_POSTS} resolved source posts are supported`);
  const policy = compositionPolicySchema.parse(policyInput);
  for (const post of posts) assertSoundCloudAudioIntent(post, policy);
  if (["all", "images"].includes(policy.media)) {
    const issue = posts.flatMap(post => [post, ...availableQuoteNodes(post).slice(0, renderedQuoteDepth(policy))])
      .flatMap(post => post.mediaIssues ?? [])[0];
    if (issue) throw new Error(`Body media ${issue.id ?? issue.url ?? "reference"} is ${issue.status}; choose available media explicitly`);
  }
  if (posts.some(post => post.provider === "web")) {
    if (posts.length !== 1 || posts[0]!.provider !== "web" || posts[0]!.media.length || policy.media !== "none") {
      throw new Error("An ordinary web link must be one source without composed media");
    }
    const source = posts[0]!;
    const base: Omit<BlockPlan, "hash"> = {
      schemaVersion: SCHEMA_VERSION, sources: posts, policy,
      block: { kind: "url", title: source.postTitle ?? new URL(source.canonicalUrl).hostname,
        markdown: "", ...(source.text.trim() ? { description: source.text.trim() } : {}),
        canonicalSource: source.canonicalUrl, selectedMedia: [] },
    };
    return { ...base, hash: planHash(base) };
  }
  if (posts[0]!.provider === "soundcloud") {
    if (posts.length !== 1 || !posts[0]!.soundcloud) throw new Error("Capture one SoundCloud track or playlist at a time");
    const source = posts[0]!;
    const metadata = source.soundcloud!;
    if (policy.audio !== undefined) throw new Error("--audio chooses video-mosaic soundtracks; use --media for SoundCloud audio");
    if (metadata.kind === "playlist") {
      if (policy.media === "selected" && policy.selectedMedia.length) throw new Error("SoundCloud playlists have no selectable media refs; choose auto, images, all, or none");
      if (policy.mediaOrder?.length) throw new Error("SoundCloud playlists have no media tile order");
      const includeArtwork = ["auto", "all", "images"].includes(policy.media) && Boolean(metadata.artworkUrl);
      const markdown = soundCloudPlaylistText(metadata, metadata.description, false);
      const base: Omit<BlockPlan, "hash"> = { schemaVersion: SCHEMA_VERSION, sources: posts, policy,
        block: { kind: includeArtwork ? "image" : "text", title: source.postTitle ?? "SoundCloud playlist",
          markdown: includeArtwork ? `${markdown}\n\nSource: [SoundCloud playlist](${source.canonicalUrl})` : markdown,
          canonicalSource: source.canonicalUrl, selectedMedia: [],
          ...(includeArtwork ? { artworkUrl: metadata.artworkUrl } : {}) } };
      return { ...base, hash: planHash(base) };
    }
    const chosen = selectedMedia(posts, policy);
    if (policy.media === "selected" && chosen.length !== policy.selectedMedia.length) {
      throw new Error("One or more selected media references do not exist on the SoundCloud track");
    }
    if (policy.mediaOrder !== undefined) {
      const audio = new Map(chosen.map(item => [item.ref, item]));
      if (policy.mediaOrder.length !== chosen.length || new Set(policy.mediaOrder).size !== chosen.length || policy.mediaOrder.some(ref => !audio.has(ref))) {
        throw new Error("Media order must name every selected media reference exactly once");
      }
    }
    if (chosen.some(item => item.kind !== "audio" || !["soundcloud-original-download", "soundcloud-mp3"].includes(item.acquisition ?? ""))) {
      throw new Error("SoundCloud audio requires a supported download method");
    }
    const hasAudio = chosen.length === 1;
    const keepArtwork = hasAudio || ["auto", "all", "images"].includes(policy.media);
    const base: Omit<BlockPlan, "hash"> = { schemaVersion: SCHEMA_VERSION, sources: posts, policy,
      block: { kind: hasAudio ? "audio" : "url", title: source.postTitle ?? "SoundCloud track",
        markdown: hasAudio ? source.text : "", ...(hasAudio ? {} : { description: source.text }),
        canonicalSource: source.canonicalUrl, selectedMedia: chosen.map(item => item.ref),
        ...(keepArtwork && metadata.artworkUrl ? { artworkUrl: metadata.artworkUrl } : {}) } };
    return { ...base, hash: planHash(base) };
  }
  const mediaOnlyPosts = new Set(policy.mediaOnlyPosts);
  if ([...mediaOnlyPosts].some(index => index > posts.length)) {
    throw new Error("One or more media-only post indexes do not exist");
  }
  let chosen = selectedMedia(posts, policy);
  const allKnown = selectableMedia(posts);
  const knownRefs = new Set(allKnown.map(item => item.ref));
  const visibleRefs = new Set(selectableMedia(posts, renderedQuoteDepth(policy)).map(item => item.ref));
  const hiddenQuotes = new Set(allKnown.filter(item => !visibleRefs.has(item.ref)).map(item => item.ref));
  if (policy.media === "selected" && (new Set(policy.selectedMedia).size !== policy.selectedMedia.length || policy.selectedMedia.some(ref => !knownRefs.has(ref)))) {
    throw new Error("One or more selected media references do not exist in the available source assets");
  }
  if (policy.mediaOrder !== undefined) {
    const assets = new Map(chosen.map(item => [item.ref, item]));
    const order = policy.mediaOrder.filter(ref => !hiddenQuotes.has(ref));
    if (order.length !== chosen.length || new Set(policy.mediaOrder).size !== policy.mediaOrder.length || order.some(ref => !assets.has(ref))) {
      throw new Error("Media order must name every selected media reference exactly once");
    }
    chosen = order.map(ref => assets.get(ref)!);
  }
  const explicitFrames = new Set(policy.videoFrames ?? []);
  const explicitMotion = new Set(policy.videoMotion ?? []);
  if ([...explicitMotion].some(ref => explicitFrames.has(ref))) throw new Error("Choose either Video or Frame for each video reference");
  if ([...explicitMotion].some(ref => !allKnown.some(item => item.ref === ref && item.kind === "video"
    && (hiddenQuotes.has(ref) || chosen.some(selected => selected.ref === ref))))) {
    throw new Error("A chosen moving video must name an available selected video; no block was created");
  }
  if ([...explicitFrames].some(ref => !allKnown.some(item => item.ref === ref && item.kind === "video" && item.posterUrl
    && (hiddenQuotes.has(ref) || chosen.some(selected => selected.ref === ref))))) {
    throw new Error("A chosen video frame needs its selected source video and an observed poster; no block was created");
  }
  const frameThreshold = policy.videoFrameThresholdSeconds ?? DEFAULT_VIDEO_FRAME_THRESHOLD_SECONDS;
  const frames = chosen.filter(item => item.kind === "video" && item.posterUrl
    && (explicitFrames.has(item.ref) || !explicitMotion.has(item.ref) && (item.durationSeconds ?? 0) > frameThreshold));
  const frameMedia = frames.map(item => ({ ref: item.ref, url: item.posterUrl! }));
  const frameByRef = new Map(frameMedia.map(item => [item.ref, item.url]));
  const effective = chosen.map(item => frameByRef.has(item.ref)
    ? { ...item, kind: "image" as const, url: frameByRef.get(item.ref)! } : item);
  const renderPosts = posts.map(post => ({ ...post, media: post.media.map(item => frameByRef.has(item.ref)
    ? { ...item, kind: "image" as const, url: frameByRef.get(item.ref)! } : item) }));
  const audioAssets = effective.filter(item => item.kind === "audio");
  if (audioAssets.length && (chosen.length !== 1 || posts.length !== 1 || !["soundcloud-original-download", "substack-public-original"].includes(audioAssets[0]!.acquisition ?? ""))) {
    throw new Error("Capture one original audio attachment alone; choose audio or visual media. Audio cannot be composited or converted.");
  }
  const audio = explicitAudio(policy);
  if (audio && !effective.some((item) => item.kind === "video" && item.ref === audio)
    && !(hiddenQuotes.has(audio) && allKnown.some(item => item.ref === audio && item.kind === "video"))) {
    throw new Error(`Audio source ${audio} is not a selected video`);
  }
  const carried = new Set(effective.map((item) => item.url));
  const textPosts = posts
    .filter((_, index) => !mediaOnlyPosts.has(index + 1))
    .map((post) => withoutCarriedMedia(post, carried));
  const markdown = renderSequence(textPosts, policy, new Set(frameMedia.map(item => item.ref)));
  const blockDescription = description(textPosts);
  const quoteCoverage = textPosts.filter(post => post.quote || post.quoteCoverage || post.quoteBoundary).map(post => {
    const nodes = availableQuoteNodes(post), renderedDepth = Math.min(nodes.length, renderedQuoteDepth(policy));
    const source = post.quoteCoverage;
    const dateUncertainty = [...new Set(nodes.slice(0, renderedDepth).flatMap(quote => {
      const status = quoteDateLabel(post, quote, policy.quoteDates).uncertainty; return status ? [status] : [];
    }))];
    return { sourceId: post.id, availableDepth: nodes.length, renderedDepth, requestedDepth: policy.quoteDepth ?? DEFAULT_QUOTE_DEPTH,
      maxDepth: source?.maxDepth ?? MAX_QUOTE_DEPTH, maxReached: source?.maxReached ?? false,
      truncated: (source?.truncated ?? false) || nodes.length > renderedDepth, stopped: source?.stopped ?? "end" as const,
      mayExpand: source?.mayExpand ?? false,
      ...(dateUncertainty.length ? { dateUncertainty } : {}) };
  });
  const first = posts[0]!;
  const sequence = posts.filter((post, index) => post.selection?.role !== "extra" && !mediaOnlyPosts.has(index + 1));
  const thread = expandedThread(sequence);
  const canonical = first.provider === "forum_magnum"
    ? posts.find(post => post.selection?.role === "primary" && post.selection.origin === "explicit") ?? first : first;
  const video = effective.some((item) => item.kind === "video");
  const audioOnly = audioAssets.length === 1;
  const soloVideo = video && chosen.length === 1;
  const base: Omit<BlockPlan, "hash"> = {
    schemaVersion: SCHEMA_VERSION,
    sources: posts,
    policy,
    block: {
      kind: video ? "video" : audioOnly ? "audio" : chosen.length ? "link" : "text",
      title: title(first, thread),
      markdown,
      ...(blockDescription === undefined ? {} : { description: blockDescription }),
      canonicalSource: canonical.canonicalUrl,
      ...(audioOnly && first.soundcloud?.kind === "track" && first.soundcloud.artworkUrl ? { artworkUrl: first.soundcloud.artworkUrl } : {}),
      selectedMedia: chosen.map((item) => item.ref),
      ...(frameMedia.length ? { frameMedia } : {}),
      ...(chosen.length && !soloVideo && !audioOnly ? { layout: layoutFor(renderPosts, effective,
        policy.mediaOrder !== undefined || mediaSources(posts, renderedQuoteDepth(policy)).some(node => node.quoteDepth > 0 && node.media.some(asset => chosen.some(item => item.ref === asset.ref))), policy.mosaicLayout) } : {}),
      ...(quoteCoverage.length ? { quoteCoverage } : {}),
    },
  };
  return { ...base, hash: planHash(base) };
}
