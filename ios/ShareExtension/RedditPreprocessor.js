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

  // ios/scripts/reddit-preprocessor.ts
  globalThis.ExtensionPreprocessingJS = {
    run(arguments_) {
      if (!["www.reddit.com", "reddit.com", "old.reddit.com", "new.reddit.com"].includes(location.hostname)) {
        arguments_.completionFunction({});
        return;
      }
      readRedditPage().then((value) => arguments_.completionFunction({ redditCapture: JSON.stringify(value) }), (error) => arguments_.completionFunction({ redditError: error instanceof Error ? error.message : String(error) }));
    }
  };
})();
