/** Only called inside the fresh, credentialless WebView owned by the acquisition adapter. */
export function readRedditPublicPage(expectedUrl: string, options?: { inspectOnly?: boolean }): unknown {
  function identity(value: string) {
    const url = new URL(value, location.href);
    if (url.protocol !== "https:" || url.username || url.password || url.port || !["www.reddit.com", "reddit.com", "old.reddit.com", "new.reddit.com"].includes(url.hostname)) throw new Error("Expected a public Reddit source");
    const found = /^\/(?:r\/[\w]+\/)?comments\/([a-z0-9]+)(?:\/[^/]+(?:\/([a-z0-9]+))?)?\/?$/.exec(url.pathname);
    if (!found) throw new Error("Open the full Reddit source before reading it");
    return { post: found[1]!, comment: found[2] };
  }
  const expected = identity(expectedUrl), actual = identity(location.href);
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error("The Reddit public page changed source identity");
  const pageText = document.body?.innerText ?? document.body?.textContent ?? "";
  const roots = Array.from(document.querySelectorAll(`shreddit-post[id="t3_${expected.post}"],shreddit-post[post-id="t3_${expected.post}"]`));
  if ((!roots.length && /verify you are human|blocked by network security|whoa there, pardner|access denied|please log in to continue|you must be logged in/i.test(pageText)) || document.querySelector('form[action*="challenge"],iframe[src*="challenge-platform"],#challenge-form')) throw new Error("Reddit public page requires access verification; no interaction was attempted");
  if (roots.length !== 1) throw new Error("The exact Reddit post is not ready");
  const root = roots[0]!;
  const attr = (node: Element, key: string) => { const value = node.getAttribute(key)?.trim(); if (!value) throw new Error(`Reddit public source omitted ${key}`); return value; };
  const postedAt = (raw: string) => { const date = new Date(raw); if (!Number.isFinite(date.valueOf())) throw new Error("Reddit public source omitted its exact timestamp"); return date.toISOString(); };
  if (options?.inspectOnly) {
    attr(root, "post-title"); attr(root, "author");
    if (expected.comment && !document.querySelector(`shreddit-comment[thingid="t1_${expected.comment}"]`)) throw new Error("The selected Reddit comment is not ready");
    return { sourceUrl: location.href, postId: expected.post };
  }
  const postType = attr(root, "post-type");
  if (!root.hasAttribute("show-full-content") || /removed|deleted|quarantin/i.test(root.getAttribute("moderation-verdict") ?? "")) throw new Error("Reddit public post is incomplete or unavailable");
  if (!expected.comment && (!["text", "self", "image", "multi_media", "link"].includes(postType) || root.querySelector("shreddit-post,shreddit-gallery,shreddit-player,video,audio,iframe,object,embed") || root.getAttribute("crosspost-root-id"))) throw new Error("Reddit public post includes an unsupported media/cross-post type");
  function image(value: string) {
    const url = new URL(value.replaceAll("&amp;", "&"), location.href);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash || !["i.redd.it", "preview.redd.it", "cf.preview.redd.it"].includes(url.hostname)) throw new Error("Reddit public image has no verified Reddit source");
    const match = /^\/([a-z0-9]+)\.(?:png|jpe?g|webp)$/i.exec(url.pathname) ?? /-v0-([a-z0-9]+)\.(?:png|jpe?g|webp)$/i.exec(url.pathname);
    if (!match) throw new Error("Reddit public image identity is unavailable");
    return { id: match[1]!, url: url.href, sourceRole: url.hostname === "i.redd.it" ? "original" : "preview" };
  }
  function body(node: Element | null, placement: boolean) {
    if (!node) return { body: { status: "complete", html: "" }, media: [] as any[] };
    if (node.querySelector("script,style,picture,video,audio,iframe,object,embed,math,svg,canvas") || Array.from(node.querySelectorAll("button")).some(b => /show|more|expand/i.test(b.textContent ?? ""))) throw new Error("Reddit public writing is collapsed or includes unsupported media");
    const media: any[] = [], seen = new Set<string>();
    for (const item of Array.from(node.querySelectorAll("img"))) {
      const source = image(attr(item, "src"));
      if (!seen.has(source.id)) { seen.add(source.id); media.push({ ...source, kind: "image", alt: item.getAttribute("alt") ?? "", ...(placement ? { sourcePlacement: "body" } : {}) }); }
    }
    // Keep authored HTML as data; remove site styling/behavior attributes only.
    const copy = node.cloneNode(true) as Element;
    for (const item of [copy, ...Array.from(copy.querySelectorAll("*"))]) for (const attribute of Array.from(item.attributes)) if (!["href", "src", "alt", "title", "colspan", "rowspan"].includes(attribute.name)) item.removeAttribute(attribute.name);
    const html = copy.innerHTML;
    if (html.length > 500_000 || media.length > 100) throw new Error("Reddit public writing exceeds its bound");
    return { body: { status: "complete", html }, media };
  }
  const selectedBody = root.querySelector(`[id="t3_${expected.post}-post-rtjson-content"]`);
  if (!expected.comment && ["text", "self", "multi_media"].includes(postType) && !selectedBody) throw new Error("Reddit public post omitted its complete authored body");
  const content = expected.comment ? { body: { status: "context-only", html: "" }, media: [] as any[] } : body(selectedBody, true);
  if (!expected.comment && postType !== "link") {
    const attachment = root.querySelector('[slot="post-media-container"]');
    for (const media of body(attachment, false).media) if (!content.media.some(item => item.id === media.id)) content.media.push(media);
  }
  const post: any = { id: expected.post, title: attr(root, "post-title"), author: attr(root, "author"), permalink: attr(root, "permalink"),
    postedAt: postedAt(attr(root, "created-timestamp")), postType, ...content, evidence: { root: "shreddit-post", fullContent: true } };
  if (postType === "link" && !expected.comment) { const href = attr(root, "content-href"); const url = new URL(href); if (url.protocol !== "https:" || url.username || url.password || url.port) throw new Error("Unsafe Reddit link source"); post.externalUrl = url.href; }
  let comment: any;
  if (expected.comment) {
    const nodes = Array.from(document.querySelectorAll(`shreddit-comment[thingid="t1_${expected.comment}"]`));
    if (nodes.length !== 1) throw new Error("The selected Reddit comment is not ready");
    const node = nodes[0]!;
    if (attr(node, "postid") !== `t3_${expected.post}`) throw new Error("Reddit public comment has a different parent");
    const bodyId = `t1_${expected.comment}-post-rtjson-content`;
    const bodies = Array.from(node.querySelectorAll(`[id="${bodyId}"]`)).filter(item => item.closest("shreddit-comment") === node);
    if (bodies.length !== 1 || !bodies[0]!.textContent?.trim() || /^\s*\[(?:removed|deleted)\]\s*$/.test(bodies[0]!.textContent ?? "")) throw new Error("Reddit selected comment has no complete public body");
    comment = { id: expected.comment, postId: expected.post, author: attr(node, "author"), permalink: attr(node, "permalink"), postedAt: postedAt(attr(node, "created")),
      ...body(bodies[0]!, true), evidence: { root: "shreddit-comment", bodyId } };
    // Parent metadata supplies the title, never parent writing or attachments.
    post.body = { status: "context-only", html: "" }; post.media = []; post.evidence.fullContent = false; delete post.externalUrl;
  }
  return { schema: "arena-block/reddit-public-page-capture", version: 1, transport: "ephemeral-public-webview", sourceUrl: location.href, observedAt: new Date().toISOString(), post, ...(comment ? { comment } : {}) };
}
