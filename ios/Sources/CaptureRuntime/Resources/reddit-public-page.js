(() => {
  // packages/core/reddit-browser-reader.ts
  async function readRedditPage(expectedUrl) {
    const maxBytes = 2 * 1024 * 1024;
    function identity(value) {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password || url.port || !["www.reddit.com", "reddit.com", "old.reddit.com", "new.reddit.com"].includes(url.hostname))
        throw new Error("Open a Reddit post or selected comment in this tab");
      const match = /^\/(?:r\/[a-zA-Z0-9_]+\/)?comments\/([a-z0-9]+)(?:\/([^/]+)(?:\/([a-z0-9]+))?)?\/?$/.exec(url.pathname);
      const gallery = /^\/gallery\/([a-z0-9]+)\/?$/.exec(url.pathname);
      if (!match && !gallery)
        throw new Error("Open the full Reddit post or comment link before reading it");
      return { post: match?.[1] ?? gallery?.[1], comment: match?.[3] };
    }
    const page = identity(location.href);
    if (expectedUrl && JSON.stringify(identity(expectedUrl)) !== JSON.stringify(page))
      throw new Error("The Reddit tab changed; choose its current source again");
    function pick(value, fields) {
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Reddit returned an incomplete record");
      return Object.fromEntries(fields.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
    }
    function mediaMetadata(value) {
      if (value == null)
        return value;
      const entries = Object.entries(value);
      if (entries.length > 100)
        throw new Error("Too many Reddit media records");
      return Object.fromEntries(entries.map(([key, item]) => [key, {
        ...pick(item, ["status", "e"]),
        ...item.s ? { s: pick(item.s, ["u", "gif", "mp4", "x", "y"]) } : {}
      }]));
    }
    function postRecord(value, depth = 0, contextOnly = false) {
      if (depth > 4)
        throw new Error("Reddit cross-post nesting is too deep");
      if (!["public", "restricted"].includes(value?.subreddit_type) || value?.quarantine || value?.quarantined)
        throw new Error("Only public, non-quarantined Reddit records can leave this page");
      if (!contextOnly && (value.removed_by_category || ["[removed]", "[deleted]"].includes(value.selftext)))
        throw new Error("Reddit marks this post removed or deleted; no capture was returned");
      for (const field of contextOnly ? [] : ["secure_media", "media"])
        if (value[field] && !value[field].reddit_video && Object.keys(value[field]).length)
          throw new Error("This Reddit embedded media type cannot be captured completely");
      const post = pick(value, ["id", "title", "author", "permalink", "selftext", "created_utc", "removed_by_category", "subreddit_type", "quarantined", "quarantine", "url", "is_self", "post_hint"]);
      if (contextOnly)
        return post;
      if (value.preview)
        post.preview = { images: (value.preview.images ?? []).slice(0, 100).map((item) => ({ id: item.id, source: pick(item.source, ["width", "height"]) })) };
      if (value.gallery_data) {
        if (!Array.isArray(value.gallery_data.items) || value.gallery_data.items.length > 100)
          throw new Error("Invalid Reddit gallery");
        post.gallery_data = { items: value.gallery_data.items.map((item) => pick(item, ["media_id", "caption", "is_deleted"])) };
      }
      if (value.media_metadata)
        post.media_metadata = mediaMetadata(value.media_metadata);
      for (const field of ["secure_media", "media"])
        if (value[field]?.reddit_video)
          post[field] = {
            reddit_video: pick(value[field].reddit_video, ["hls_url", "fallback_url", "has_audio", "width", "height"])
          };
      if (value.crosspost_parent_list) {
        if (value.crosspost_parent_list.length > 1)
          throw new Error("Unexpected Reddit cross-post records");
        post.crosspost_parent_list = value.crosspost_parent_list.map((item) => postRecord(item, depth + 1));
      }
      return post;
    }
    const controller = new AbortController;
    const timer = setTimeout(() => controller.abort(), 15000);
    let consumed = 0;
    async function get(path) {
      const response = await fetch(new URL(path, location.origin), { credentials: "same-origin", redirect: "error", signal: controller.signal, headers: { accept: "application/json" } });
      if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
        throw new Error(`Reddit browser read returned HTTP ${response.status} without usable JSON. No fallback was attempted.`);
      }
      const reader = response.body?.getReader();
      if (!reader)
        throw new Error("Reddit returned no record body");
      const chunks = [];
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done)
            break;
          consumed += value.byteLength;
          if (consumed > maxBytes) {
            controller.abort();
            throw new Error("Reddit browser response exceeds 2 MiB");
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      return JSON.parse(new TextDecoder().decode(bytes));
    }
    function record(listing, kind, id) {
      const children = listing?.data?.children;
      if (!Array.isArray(children) || children.length !== 1 || children[0]?.kind !== kind || children[0]?.data?.id !== id)
        throw new Error("Reddit returned a different or unavailable record");
      return children[0].data;
    }
    try {
      let post, comment;
      if (page.comment) {
        const value = record(await get(`/api/info.json?id=t1_${page.comment}&raw_json=1`), "t1", page.comment);
        if (value.removed || value.removed_by_category || ["[removed]", "[deleted]"].includes(value.body?.trim()) || value.author === "[deleted]")
          throw new Error("Reddit marks this comment removed or deleted; no capture was returned");
        if (value.link_id !== `t3_${page.post}`)
          throw new Error("Reddit returned a different comment parent");
        comment = pick(value, ["id", "link_id", "author", "body", "permalink", "created_utc", "removed", "removed_by_category"]);
        if (value.media_metadata)
          comment.media_metadata = mediaMetadata(value.media_metadata);
        if (value.media != null)
          throw new Error("Reddit comment has an unsupported media container");
        post = postRecord(record(await get(`/api/info.json?id=t3_${page.post}&raw_json=1`), "t3", page.post), 0, true);
      } else {
        const listings = await get(`/comments/${page.post}.json?raw_json=1&limit=1`);
        post = postRecord(record(listings?.[0], "t3", page.post));
      }
      return {
        schema: "arena-block/reddit-browser-capture",
        version: 1,
        sourceUrl: `https://www.reddit.com/comments/${page.post}/${page.comment ? `comment/${page.comment}/` : ""}`,
        observedAt: new Date().toISOString(),
        post,
        ...comment ? { comment } : {}
      };
    } finally {
      clearTimeout(timer);
    }
  }

  // packages/core/reddit-public-page-reader.ts
  function readRedditPublicPage(expectedUrl, options) {
    function identity(value) {
      const url = new URL(value, location.href);
      if (url.protocol !== "https:" || url.username || url.password || url.port || !["www.reddit.com", "reddit.com", "old.reddit.com", "new.reddit.com"].includes(url.hostname))
        throw new Error("Expected a public Reddit source");
      const found = /^\/(?:r\/[\w]+\/)?comments\/([a-z0-9]+)(?:\/[^/]+(?:\/([a-z0-9]+))?)?\/?$/.exec(url.pathname);
      if (!found)
        throw new Error("Open the full Reddit source before reading it");
      return { post: found[1], comment: found[2] };
    }
    const expected = identity(expectedUrl), actual = identity(location.href);
    if (JSON.stringify(expected) !== JSON.stringify(actual))
      throw new Error("The Reddit public page changed source identity");
    const pageText = document.body?.innerText ?? document.body?.textContent ?? "";
    const roots = Array.from(document.querySelectorAll(`shreddit-post[id="t3_${expected.post}"],shreddit-post[post-id="t3_${expected.post}"]`));
    if (!roots.length && /verify you are human|blocked by network security|whoa there, pardner|access denied|please log in to continue|you must be logged in/i.test(pageText) || document.querySelector('form[action*="challenge"],iframe[src*="challenge-platform"],#challenge-form'))
      throw new Error("Reddit public page requires access verification; no interaction was attempted");
    if (roots.length !== 1)
      throw new Error("The exact Reddit post is not ready");
    const root = roots[0];
    const attr = (node, key) => {
      const value = node.getAttribute(key)?.trim();
      if (!value)
        throw new Error(`Reddit public source omitted ${key}`);
      return value;
    };
    const postedAt = (raw) => {
      const date = new Date(raw);
      if (!Number.isFinite(date.valueOf()))
        throw new Error("Reddit public source omitted its exact timestamp");
      return date.toISOString();
    };
    if (options?.inspectOnly) {
      attr(root, "post-title");
      attr(root, "author");
      if (expected.comment && !document.querySelector(`shreddit-comment[thingid="t1_${expected.comment}"]`))
        throw new Error("The selected Reddit comment is not ready");
      return { sourceUrl: location.href, postId: expected.post };
    }
    const postType = attr(root, "post-type");
    if (!root.hasAttribute("show-full-content") || /removed|deleted|quarantin/i.test(root.getAttribute("moderation-verdict") ?? ""))
      throw new Error("Reddit public post is incomplete or unavailable");
    if (!expected.comment && (!["text", "self", "image", "multi_media", "link"].includes(postType) || root.querySelector("shreddit-post,shreddit-gallery,shreddit-player,video,audio,iframe,object,embed") || root.getAttribute("crosspost-root-id")))
      throw new Error("Reddit public post includes an unsupported media/cross-post type");
    function image(value) {
      const url = new URL(value.replaceAll("&amp;", "&"), location.href);
      if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash || !["i.redd.it", "preview.redd.it", "cf.preview.redd.it"].includes(url.hostname))
        throw new Error("Reddit public image has no verified Reddit source");
      const match = /^\/([a-z0-9]+)\.(?:png|jpe?g|webp)$/i.exec(url.pathname) ?? /-v0-([a-z0-9]+)\.(?:png|jpe?g|webp)$/i.exec(url.pathname);
      if (!match)
        throw new Error("Reddit public image identity is unavailable");
      return { id: match[1], url: url.href, sourceRole: url.hostname === "i.redd.it" ? "original" : "preview" };
    }
    function body(node, placement) {
      if (!node)
        return { body: { status: "complete", html: "" }, media: [] };
      if (node.querySelector("script,style,picture,video,audio,iframe,object,embed,math,svg,canvas") || Array.from(node.querySelectorAll("button")).some((b) => /show|more|expand/i.test(b.textContent ?? "")))
        throw new Error("Reddit public writing is collapsed or includes unsupported media");
      const media = [], seen = new Set;
      for (const item of Array.from(node.querySelectorAll("img"))) {
        const source = image(attr(item, "src"));
        if (!seen.has(source.id)) {
          seen.add(source.id);
          media.push({ ...source, kind: "image", alt: item.getAttribute("alt") ?? "", ...placement ? { sourcePlacement: "body" } : {} });
        }
      }
      const copy = node.cloneNode(true);
      for (const item of [copy, ...Array.from(copy.querySelectorAll("*"))])
        for (const attribute of Array.from(item.attributes))
          if (!["href", "src", "alt", "title", "colspan", "rowspan"].includes(attribute.name))
            item.removeAttribute(attribute.name);
      const html = copy.innerHTML;
      if (html.length > 500000 || media.length > 100)
        throw new Error("Reddit public writing exceeds its bound");
      return { body: { status: "complete", html }, media };
    }
    const selectedBody = root.querySelector(`[id="t3_${expected.post}-post-rtjson-content"]`);
    if (!expected.comment && ["text", "self", "multi_media"].includes(postType) && !selectedBody)
      throw new Error("Reddit public post omitted its complete authored body");
    const content = expected.comment ? { body: { status: "context-only", html: "" }, media: [] } : body(selectedBody, true);
    if (!expected.comment && postType !== "link") {
      const attachment = root.querySelector('[slot="post-media-container"]');
      for (const media of body(attachment, false).media)
        if (!content.media.some((item) => item.id === media.id))
          content.media.push(media);
    }
    const post = {
      id: expected.post,
      title: attr(root, "post-title"),
      author: attr(root, "author"),
      permalink: attr(root, "permalink"),
      postedAt: postedAt(attr(root, "created-timestamp")),
      postType,
      ...content,
      evidence: { root: "shreddit-post", fullContent: true }
    };
    if (postType === "link" && !expected.comment) {
      const href = attr(root, "content-href");
      const url = new URL(href);
      if (url.protocol !== "https:" || url.username || url.password || url.port)
        throw new Error("Unsafe Reddit link source");
      post.externalUrl = url.href;
    }
    let comment;
    if (expected.comment) {
      const nodes = Array.from(document.querySelectorAll(`shreddit-comment[thingid="t1_${expected.comment}"]`));
      if (nodes.length !== 1)
        throw new Error("The selected Reddit comment is not ready");
      const node = nodes[0];
      if (attr(node, "postid") !== `t3_${expected.post}`)
        throw new Error("Reddit public comment has a different parent");
      const bodyId = `t1_${expected.comment}-post-rtjson-content`;
      const bodies = Array.from(node.querySelectorAll(`[id="${bodyId}"]`)).filter((item) => item.closest("shreddit-comment") === node);
      if (bodies.length !== 1 || !bodies[0].textContent?.trim() || /^\s*\[(?:removed|deleted)\]\s*$/.test(bodies[0].textContent ?? ""))
        throw new Error("Reddit selected comment has no complete public body");
      comment = {
        id: expected.comment,
        postId: expected.post,
        author: attr(node, "author"),
        permalink: attr(node, "permalink"),
        postedAt: postedAt(attr(node, "created")),
        ...body(bodies[0], true),
        evidence: { root: "shreddit-comment", bodyId }
      };
      post.body = { status: "context-only", html: "" };
      post.media = [];
      post.evidence.fullContent = false;
      delete post.externalUrl;
    }
    return { schema: "arena-block/reddit-public-page-capture", version: 1, transport: "ephemeral-public-webview", sourceUrl: location.href, observedAt: new Date().toISOString(), post, ...comment ? { comment } : {} };
  }

  // ios/scripts/reddit-public-page.ts
  globalThis.arenaAcquireRedditPublicPage = async (expected) => {
    try {
      readRedditPublicPage(expected, { inspectOnly: true });
      try {
        return { ok: true, capture: await readRedditPage(expected) };
      } catch (error) {
        if (!/Reddit browser read returned HTTP 403 without usable JSON/.test(String(error)))
          throw error;
        return { ok: true, capture: readRedditPublicPage(expected) };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, pending: /is not ready/.test(message), error: message };
    }
  };
})();
