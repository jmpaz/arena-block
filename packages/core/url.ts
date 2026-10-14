const X_HOSTS = new Set([
  "x.com",
  "twitter.com",
  "fixupx.com",
  "fxtwitter.com",
  "vxtwitter.com",
  "twittpr.com",
]);

export type ParsedSource =
  | { provider: "arena"; id: string; canonicalUrl: string }
  | { provider: "forum_magnum"; site: "lesswrong" | "alignment_forum" | "ea_forum"; id: string; canonicalUrl: string; commentId?: string }
  | { provider: "reddit"; id: string; canonicalUrl: string; short?: boolean; commentId?: string }
  | { provider: "x"; handle: string; id: string; canonicalUrl: string }
  | { provider: "bluesky"; handle: string; id: string; canonicalUrl: string }
  | { provider: "delve"; handle: string; id: string; canonicalUrl: string }
  | { provider: "tiktok" | "instagram"; id: string; canonicalUrl: string }
  | { provider: "mastodon"; server: string; id: string; canonicalUrl: string }
  | { provider: "hackernews" | "lobsters"; id: string; canonicalUrl: string }
  | { provider: "soundcloud"; kind: "track" | "playlist"; id: string; canonicalUrl: string };

export function atprotoActorPath(actor: string): string { return actor.replaceAll("%", "%25"); }

export function parseSource(value: string): ParsedSource {
  if (value.startsWith("at://")) {
    const match = /^at:\/\/([a-zA-Z0-9.:%_-]+)\/(app\.bsky|town\.delve)\.feed\.post\/([a-zA-Z0-9._~:-]+)$/.exec(value);
    if (!match || [".", ".."].includes(match[3]!)) throw new Error(`Expected a supported AT Protocol post URI: ${value}`);
    const provider = match[2] === "town.delve" ? "delve" : "bluesky";
    const handle = match[1]!.startsWith("did:") ? match[1]! : decodeURIComponent(match[1]!);
    if (provider === "delve" && !validDelveActor(handle)) throw new Error("Expected a Delvetown handle or DID");
    return { provider, handle, id: match[3]!, canonicalUrl: `https://${provider === "delve" ? "delve.town" : "bsky.app"}/profile/${atprotoActorPath(handle)}/post/${match[3]}` };
  }
  const url = new URL(value);
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const parts = url.pathname.split("/").filter(Boolean);
  const forumSites: Record<string, { site: "lesswrong" | "alignment_forum" | "ea_forum"; origin: string }> = {
    "lesswrong.com": { site: "lesswrong", origin: "https://www.lesswrong.com" },
    "greaterwrong.com": { site: "lesswrong", origin: "https://www.lesswrong.com" },
    "alignmentforum.org": { site: "alignment_forum", origin: "https://www.alignmentforum.org" },
    "forum.effectivealtruism.org": { site: "ea_forum", origin: "https://forum.effectivealtruism.org" },
  };
  const forum = forumSites[host];
  if (forum) {
    if (url.protocol !== "https:" || url.username || url.password || url.port) throw new Error("Forum Magnum URLs must use HTTPS without credentials or custom ports");
    const postId = /^\/posts\/([A-Za-z0-9]+)(?:\/[^/]+)?\/?$/.exec(url.pathname)?.[1]
      ?? /^\/s\/[A-Za-z0-9]+\/p\/([A-Za-z0-9]+)\/?$/.exec(url.pathname)?.[1]
      ?? /^\/p\/([A-Za-z0-9]+)\/?$/.exec(url.pathname)?.[1]
      ?? /^\/posts\/([A-Za-z0-9]+)\/[^/]+\/comment\/[A-Za-z0-9]+\/?$/.exec(url.pathname)?.[1];
    if (!postId) throw new Error(`Expected a Forum Magnum post or comment permalink: ${value}`);
    const pathComment = /^\/posts\/[A-Za-z0-9]+\/[^/]+\/comment\/([A-Za-z0-9]+)\/?$/.exec(url.pathname)?.[1];
    const queryComments = url.searchParams.getAll("commentId");
    if (queryComments.some(item => !/^[A-Za-z0-9]+$/.test(item))) throw new Error("Invalid Forum Magnum comment ID");
    const fragmentComment = /^#(?:comment-)?([A-Za-z0-9]{12,30})$/.exec(url.hash)?.[1];
    if (url.hash.startsWith("#comment-") && !fragmentComment) throw new Error("Invalid Forum Magnum comment ID");
    const comments = [pathComment, ...queryComments, fragmentComment].filter((item): item is string => Boolean(item));
    if (comments.some(item => !/^[A-Za-z0-9]+$/.test(item) || item !== comments[0])) throw new Error("Conflicting or invalid Forum Magnum comment IDs");
    const commentId = comments[0];
    return { provider: "forum_magnum", site: forum.site, id: postId,
      canonicalUrl: `${forum.origin}/posts/${postId}/${commentId ? `?commentId=${commentId}` : ""}`,
      ...(commentId ? { commentId } : {}) };
  }
  if (["soundcloud.com", "m.soundcloud.com"].includes(host)) {
    if (url.protocol !== "https:" || url.username || url.password || url.port) throw new Error("SoundCloud URLs must use HTTPS without credentials or custom ports");
    if (url.searchParams.has("secret_token")) throw new Error("SoundCloud private links are not supported; use a public track or playlist URL");
    let kind: "track" | "playlist";
    let id: string;
    const collectionRoutes = new Set(["likes", "reposts", "tracks", "sets", "albums", "followers", "following"]);
    if (parts.length === 2 && !collectionRoutes.has(parts[0]!.toLowerCase())
      && !collectionRoutes.has(parts[1]!.toLowerCase())) {
      kind = "track"; id = parts[1]!;
    } else if (parts.length === 3 && parts[1] === "sets") {
      kind = "playlist"; id = parts[2]!;
    } else {
      throw new Error(`Expected a public SoundCloud track or playlist URL: ${value}`);
    }
    if (!/^[\w:-]+$/.test(id) || id === "sets") throw new Error(`Expected a public SoundCloud track or playlist URL: ${value}`);
    return { provider: "soundcloud", kind, id, canonicalUrl: `https://soundcloud.com/${parts[0]}/${kind === "track" ? id : `sets/${id}`}` };
  }
  if (host === "are.na" && parts[0] === "block") {
    if (url.protocol !== "https:" || url.username || url.password || url.port) throw new Error("Are.na block URLs must use HTTPS without credentials or custom ports");
    const match = /^\/block\/([1-9]\d*)\/?$/.exec(url.pathname);
    if (!match || !Number.isSafeInteger(Number(match[1]))) throw new Error(`Expected an Are.na block URL: ${value}`);
    return { provider: "arena", id: match[1]!, canonicalUrl: `https://www.are.na/block/${match[1]}` };
  }
  if (["tiktok.com", "vm.tiktok.com", "vt.tiktok.com", "instagram.com"].includes(host)) {
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("Social post URLs must use HTTPS without credentials");
    if (host === "instagram.com") {
      const match = /^\/(?:[a-zA-Z0-9_.]+\/)?(p|reel|reels)\/([a-zA-Z0-9_-]+)\/?$/.exec(url.pathname);
      if (!match) throw new Error(`Unsupported Instagram post URL: ${value}`);
      return { provider: "instagram", id: match[2]!, canonicalUrl: `https://www.instagram.com/${match[1] === "p" ? "p" : "reel"}/${match[2]}/` };
    }
    const post = /^\/@([a-zA-Z0-9_.]+)\/(photo|video)\/(\d+)\/?$/.exec(url.pathname);
    if (host === "tiktok.com" && post) return { provider: "tiktok", id: post[3]!, canonicalUrl: `https://www.tiktok.com/@${post[1]}/${post[2]}/${post[3]}` };
    const short = (host === "tiktok.com" ? /^\/t\/([a-zA-Z0-9]+)\/?$/ : /^\/([a-zA-Z0-9]+)\/?$/).exec(url.pathname);
    if (!short) throw new Error(`Unsupported TikTok post URL: ${value}`);
    return { provider: "tiktok", id: short[1]!, canonicalUrl: `https://${host === "tiktok.com" ? "www.tiktok.com/t" : host}/${short[1]}/` };
  }
  if (["reddit.com", "old.reddit.com", "new.reddit.com", "redd.it"].includes(host)) {
    if (url.protocol !== "https:" || url.username || url.password || url.port) throw new Error("Reddit URLs must use HTTPS without credentials or custom ports");
    const short = /^\/r\/[a-zA-Z0-9_]+\/s\/([a-zA-Z0-9]+)\/?$/.exec(url.pathname);
    if (short && host !== "redd.it") return { provider: "reddit", id: short[1]!, short: true, canonicalUrl: `https://www.reddit.com${url.pathname}` };
    const comment = /^\/(?:r\/[a-zA-Z0-9_]+\/)?comments\/([a-z0-9]+)\/[^/]+\/([a-z0-9]+)\/?$/.exec(url.pathname);
    if (comment && host !== "redd.it") return { provider: "reddit", id: comment[1]!, commentId: comment[2]!, canonicalUrl: `https://www.reddit.com/comments/${comment[1]}/comment/${comment[2]}/` };
    const match = (host === "redd.it" ? /^\/([a-z0-9]+)\/?$/ : /^\/(?:(?:r\/[a-zA-Z0-9_]+\/)?comments|gallery)\/([a-z0-9]+)(?:\/[^/]+)?\/?$/).exec(url.pathname);
    if (!match) throw new Error(`Expected a Reddit post URL: ${value}`);
    return { provider: "reddit", id: match[1]!, canonicalUrl: `https://www.reddit.com/comments/${match[1]}/` };
  }
  if (host === "news.ycombinator.com") {
    const id = url.searchParams.get("id");
    if (url.pathname !== "/item" || !id || !/^[1-9]\d*$/.test(id)) {
      throw new Error(`Unsupported Hacker News comment URL: ${value}`);
    }
    return { provider: "hackernews", id, canonicalUrl: `https://news.ycombinator.com/item?id=${id}` };
  }
  if (host === "lobste.rs") {
    const id = /^\/c\/([a-z0-9]+)(?:\.json)?\/?$/.exec(url.pathname)?.[1]
      ?? (/^\/s\/[a-z0-9]+(?:\/[^/]+)?\/?$/.test(url.pathname) ? /^#c_([a-z0-9]+)$/.exec(url.hash)?.[1] : undefined)
      ?? /^\/s\/[a-z0-9]+\/[^/]+\/comments\/([a-z0-9]+)\/?$/.exec(url.pathname)?.[1];
    if (!id) throw new Error(`Expected a Lobsters comment permalink, including #c_ID for story URLs: ${value}`);
    return { provider: "lobsters", id, canonicalUrl: `https://lobste.rs/c/${id}` };
  }
  if (X_HOSTS.has(host)) {
    const statusIndex = parts.indexOf("status");
    const handle = statusIndex > 0 ? parts[statusIndex - 1] : undefined;
    const id = statusIndex >= 0 ? parts[statusIndex + 1] : undefined;
    if (!handle || !id || !/^\d+$/.test(id)) {
      throw new Error(`Unsupported x.com post URL: ${value}`);
    }
    return {
      provider: "x",
      handle: handle.replace(/^@/, ""),
      id,
      canonicalUrl: `https://x.com/${handle.replace(/^@/, "")}/status/${id}`,
    };
  }
  if (host === "delve.town") {
    if (url.protocol !== "https:" || url.username || url.password || url.port) throw new Error("Delvetown URLs must use HTTPS without credentials or custom ports");
    const match = /^\/profile\/([^/]+)\/post\/([a-zA-Z0-9._~:-]+)\/?$/.exec(url.pathname);
    if (!match || [".", ".."].includes(match[2]!)) throw new Error(`Unsupported Delvetown post URL: ${value}`);
    const handle = decodeURIComponent(match[1]!).replace(/^@/, "");
    if (!validDelveActor(handle)) throw new Error("Expected a Delvetown handle or DID");
    return { provider: "delve", handle, id: match[2]!, canonicalUrl: `https://delve.town/profile/${atprotoActorPath(handle)}/post/${match[2]}` };
  }
  if (host === "bsky.app") {
    if (parts[0] !== "profile" || parts[2] !== "post" || !parts[1] || !parts[3]) {
      throw new Error(`Unsupported Bluesky post URL: ${value}`);
    }
    return {
      provider: "bluesky",
      handle: decodeURIComponent(parts[1]).replace(/^@/, ""),
      id: parts[3],
      canonicalUrl: `https://bsky.app/profile/${atprotoActorPath(decodeURIComponent(parts[1]).replace(/^@/, ""))}/post/${parts[3]}`,
    };
  }
  const mastodonId = /^\/@[^/]+\/(\d+)\/?$/.exec(url.pathname)?.[1]
    ?? /^\/(?:(?:ap\/)?users\/[^/]+\/statuses|web\/statuses|statuses)\/(\d+)\/?$/.exec(url.pathname)?.[1];
  if (mastodonId) {
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("Mastodon post URLs must use HTTPS without credentials");
    return { provider: "mastodon", server: url.origin, id: mastodonId, canonicalUrl: `${url.origin}${url.pathname.replace(/\/$/, "")}` };
  }
  throw new Error(`Unsupported social post URL: ${value}`);
}

export function arenaDestination(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (!["are.na", "www.are.na"].includes(url.hostname.toLowerCase())) return undefined;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2 || parts[0] === "block" || parts[0] === "developers") return undefined;
  return parts.at(-1);
}

export function parseArenaBlockUrl(value: string): number {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Expected an Are.na block URL such as https://www.are.na/block/123");
  }
  if (url.protocol !== "https:" || !["are.na", "www.are.na"].includes(url.hostname.toLowerCase())
    || url.username || url.password || url.port || url.search || url.hash) {
    throw new Error("Expected an HTTPS Are.na block URL without query or fragment");
  }
  const match = /^\/block\/(\d+)\/?$/.exec(url.pathname);
  const id = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new Error("Expected an Are.na block URL such as https://www.are.na/block/123");
  }
  return id;
}

export function normalizeArenaDestinations(values: string[]): string[] {
  return [...new Set(values.map((value) => arenaDestination(value) ?? value))];
}

function validDelveActor(value: string): boolean {
  return /^did:plc:[a-z2-7]{24}$/.test(value) || /^did:web:[a-zA-Z0-9.:%_-]+$/.test(value)
    || /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z][a-zA-Z0-9-]*$/.test(value);
}
