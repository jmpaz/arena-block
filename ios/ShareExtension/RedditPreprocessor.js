(() => {
  // packages/core/substack-page.ts
  async function readSubstackPage(expectedUrl, environment) {
    const maxBytes = 2 * 1024 * 1024, maxDepth = environment?.maxDepth ?? 8;
    const start = environment?.url ?? location.href;
    function identity(value) {
      const url = new URL(value, start);
      const match = /^\/(?:(@[a-zA-Z0-9_]+|profile\/[1-9]\d*(?:-[a-zA-Z0-9_-]+)?)\/)?note\/c-([1-9]\d*)\/?$/.exec(url.pathname);
      if (url.protocol !== "https:" || url.hostname !== "substack.com" || url.username || url.password || url.port || !match)
        throw new Error("Expected a public Substack Note permalink");
      return { id: match[2], url: `https://substack.com/${match[1] ? `${match[1]}/` : ""}note/c-${match[2]}` };
    }
    const selected = identity(start);
    if (expectedUrl && identity(expectedUrl).id !== selected.id)
      throw new Error("The Substack tab changed; choose its current Note again");
    const controller = new AbortController;
    const abort = () => controller.abort();
    environment?.signal?.addEventListener("abort", abort, { once: true });
    if (environment?.signal?.aborted)
      controller.abort();
    const timer = setTimeout(abort, 20000);
    const fetcher = environment?.fetcher ?? fetch;
    const parseHTML = environment?.parseHTML ?? ((html) => new DOMParser().parseFromString(html, "text/html"));
    const all = (items) => Array.from(items);
    function bytes(text) {
      let count = 0;
      for (const c of text) {
        const p = c.codePointAt(0);
        count += p < 128 ? 1 : p < 2048 ? 2 : p < 65536 ? 3 : 4;
      }
      return count;
    }
    function noteId(value) {
      try {
        return identity(value ?? "").id;
      } catch {
        return;
      }
    }
    function safeURL(value, base) {
      if (!value)
        return;
      try {
        const u = new URL(value ?? "", base);
        return u.protocol === "https:" && !u.username && !u.password && !u.port ? u.href : undefined;
      } catch {
        return;
      }
    }
    function ancestor(node, part) {
      for (let e = node;e; e = e.parentElement)
        if (e.className?.includes(part))
          return e;
      return;
    }
    let received = 0;
    async function load(url) {
      const canonical = identity(url).url;
      let address = canonical, response;
      for (let redirects = 0;redirects <= 3; redirects++) {
        response = await fetcher(address, { credentials: "omit", redirect: "manual", signal: controller.signal, headers: { accept: "text/html" } });
        if (![301, 302, 303, 307, 308].includes(response.status))
          break;
        const location2 = response.headers.get("location");
        response.body?.cancel().catch(() => {});
        if (!location2 || redirects === 3)
          throw new Error("Substack Note redirect could not be verified within its bound");
        const destination = identity(new URL(location2, address).href);
        if (destination.id !== identity(canonical).id)
          throw new Error("Substack redirect changed the requested Note identity");
        address = destination.url;
      }
      if (!response)
        throw new Error("Substack public page returned no response");
      if (!response.ok)
        throw new Error(`Substack public page returned HTTP ${response.status}; no authenticated fallback was attempted`);
      if (!response.headers.get("content-type")?.includes("text/html"))
        throw new Error("Substack public page did not return HTML");
      if (response.url && identity(response.url).id !== identity(canonical).id)
        throw new Error("Substack returned a different source");
      if (Number(response.headers.get("content-length")) > maxBytes)
        throw new Error("Substack page exceeds 2 MiB");
      let text;
      if (response.body?.getReader) {
        const reader = response.body.getReader(), chunks = [];
        let length = 0;
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done)
              break;
            length += value.byteLength;
            received += value.byteLength;
            if (length > maxBytes || received > 4 * maxBytes) {
              controller.abort();
              throw new Error("Substack page acquisition exceeds its byte bound");
            }
            chunks.push(value);
          }
        } finally {
          reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        const raw = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          raw.set(chunk, offset);
          offset += chunk.length;
        }
        text = new TextDecoder().decode(raw);
      } else {
        text = await response.text();
        received += bytes(text);
        if (bytes(text) > maxBytes || received > 4 * maxBytes)
          throw new Error("Substack page acquisition exceeds its byte bound");
      }
      return parseHTML(text);
    }
    const seen = new Set;
    async function attachments(id, handle) {
      const endpoint = `https://substack.com/api/v1/reader/comment/${id}`;
      const response = await fetcher(endpoint, { credentials: "omit", redirect: "error", signal: controller.signal, headers: { accept: "application/json" } });
      if (!response.ok || !response.headers.get("content-type")?.includes("application/json") || response.url && response.url !== endpoint)
        throw new Error("Substack attachment evidence is not available from its public Note endpoint");
      if (Number(response.headers.get("content-length")) > maxBytes)
        throw new Error("Substack attachments exceed 2 MiB");
      let text = "";
      if (response.body?.getReader) {
        const reader = response.body.getReader(), decoder = new TextDecoder;
        let length = 0;
        try {
          while (true) {
            const part = await reader.read();
            if (part.done)
              break;
            length += part.value.byteLength;
            received += part.value.byteLength;
            if (length > maxBytes || received > 4 * maxBytes)
              throw new Error("Substack attachment acquisition exceeds its byte bound");
            text += decoder.decode(part.value, { stream: true });
          }
          text += decoder.decode();
        } finally {
          reader.cancel().catch(() => {});
        }
      } else {
        text = await response.text();
        received += bytes(text);
        if (bytes(text) > maxBytes || received > 4 * maxBytes)
          throw new Error("Substack attachment acquisition exceeds its byte bound");
      }
      const comment = JSON.parse(text)?.item?.comment;
      if (!comment || String(comment.id) !== id || comment.handle?.toLowerCase() !== handle.toLowerCase() || comment.type !== "feed" || comment.post_id !== null || typeof comment.body !== "string" || !Array.isArray(comment.attachments) || comment.attachments.length > 100)
        throw new Error("Substack attachment metadata disagrees with the selected Note");
      const projected = comment.attachments.map((a) => {
        if (a.type === "video") {
          const u = a.mediaUpload;
          if (!u || a.media_upload_id !== u.id || u.media_type !== "video" || u.is_free_preview)
            throw new Error("Substack native Note video is not a verified full original");
          return { kind: "video", id: a.id, userId: a.user_id, commentId: a.comment_id, upload: { id: u.id, userId: u.user_id, state: u.state, postId: u.post_id, publicationId: u.publication_id, durationSeconds: u.duration, width: u.width, height: u.height, thumbnailId: u.thumbnail_id ?? 1 } };
        }
        if (a.type === "post") {
          const { post: p, postSelection: s } = a;
          if (!p || a.mediaClip || a.clipInfo || a.postImageSelection || p.publication_id !== a.publication?.id || !Array.isArray(p.publishedBylines))
            throw new Error("Substack article card has unsupported or inconsistent source evidence");
          return {
            kind: "article",
            id: a.id,
            postId: p.id,
            publicationId: p.publication_id,
            url: p.canonical_url,
            title: p.title,
            previewText: p.subtitle ?? "",
            authors: p.publishedBylines.map((b) => ({ id: b.id, name: b.name, handle: b.handle ?? null })),
            ...s ? { selection: { id: s.id, postId: s.post_id, startParagraph: s.start_paragraph, endParagraph: s.end_paragraph, startOffset: s.start_offset, endOffset: s.end_offset, text: s.text, isAutoSelection: s.is_auto_selection } } : {}
          };
        }
        throw new Error(`Substack Note attachment ${a.type} has no complete supported projection`);
      });
      return { method: "public-api", observedAt: new Date().toISOString(), commentId: comment.id, userId: comment.user_id, handle: comment.handle, bodyText: comment.body, attachments: projected };
    }
    async function extract(doc, url, depth) {
      if (controller.signal.aborted)
        throw new Error("Substack acquisition cancelled");
      const target = identity(url);
      seen.add(target.id);
      const roots = all(doc.querySelectorAll('[class*="feedPermalinkUnit-"]')).filter((root2) => all(root2.querySelectorAll("a[title]")).some((a) => noteId(a.getAttribute("href")) === target.id && !ancestor(a, "commentContainer-")));
      if (roots.length !== 1)
        throw new Error("Substack public Note body is unavailable or the page structure changed");
      const root = roots[0];
      const bodies = all(root.querySelectorAll('[class*="feedCommentBody-"] .ProseMirror')).filter((body2) => !ancestor(body2, "commentContainer-"));
      if (bodies.length !== 1)
        throw new Error("Substack selected Note has no unambiguous full body");
      const body = bodies[0];
      if (all(root.querySelectorAll("button")).some((b) => /^(?:show|read|see) more$/i.test(b.textContent?.trim() ?? "")))
        throw new Error("Substack Note is a collapsed preview; expand it before capture");
      const time = all(root.querySelectorAll("a[title]")).find((a) => noteId(a.getAttribute("href")) === target.id);
      const canonical = identity(time.getAttribute("href")).url;
      const actor = new URL(canonical).pathname.replace(/\/note\/c-\d+$/, "");
      const authorLinks = all(root.querySelectorAll("a")).filter((a) => {
        const u = safeURL(a.getAttribute("href"), canonical);
        return u && new URL(u).pathname === actor && !!a.textContent?.trim();
      });
      const name = authorLinks.find((a) => !a.textContent?.startsWith("@"))?.textContent?.trim();
      const handle = actor.startsWith("/@") ? actor.slice(2) : authorLinks.find((a) => a.textContent?.startsWith("@"))?.textContent?.trim().slice(1);
      if (!name || !handle)
        throw new Error("Substack Note author is unavailable");
      const structured = all(doc.querySelectorAll('script[type="application/ld+json"]')).flatMap((script) => {
        try {
          const value = JSON.parse(script.textContent ?? "");
          return Array.isArray(value) ? value : [value];
        } catch {
          return [];
        }
      }).find((value) => value?.["@type"] === "SocialMediaPosting" && value.identifier === `c-${target.id}` && noteId(value.url) === target.id);
      const normalize = (value) => value.replace(/\s+/g, "");
      const quoted = (element) => !!ancestor(element, "elevatedTheme-") || !!ancestor(element, "commentContainer-");
      const quoteURLs = [...new Set(all(root.querySelectorAll("a[title]")).flatMap((a) => {
        const href = a.getAttribute("href");
        return noteId(href) && noteId(href) !== target.id ? [identity(href).url] : [];
      }))];
      const playerNodes = all(root.querySelectorAll('video,[aria-label="Video player"],[class*="videoPlayerContainer-"]')).filter((item) => !quoted(item) && !body.contains(item));
      const cardNodes = Array.from(root.children).filter((e) => e !== root.children[0] && !e.contains(body) && !all(e.querySelectorAll("a[title]")).some((a) => {
        const id = noteId(a.getAttribute("href"));
        return id && id !== target.id;
      }) && [e, ...all(e.querySelectorAll("a"))].some((a) => {
        const address = safeURL(a.getAttribute("href"), canonical);
        return address && /^\/p\/[^/]+\/?$/.test(new URL(address).pathname);
      }));
      const articleCards = cardNodes.filter((item) => !cardNodes.some((other) => other !== item && other.contains(item)));
      const ownPlayers = playerNodes.filter((item) => !playerNodes.some((other) => other !== item && other.contains(item)) && !articleCards.some((card) => card.contains(item)));
      const hasArticleCard = articleCards.length > 0;
      const attachmentEvidence = ownPlayers.length || hasArticleCard ? await attachments(target.id, handle) : undefined;
      if (attachmentEvidence && (!attachmentEvidence.attachments.length || ownPlayers.length && !attachmentEvidence.attachments.some((a) => a.kind === "video") || hasArticleCard && !attachmentEvidence.attachments.some((a) => a.kind === "article")))
        throw new Error("Substack attachment metadata does not cover its visible player or article card");
      if (attachmentEvidence) {
        const videos = attachmentEvidence.attachments.filter((a) => a.kind === "video"), articles = attachmentEvidence.attachments.filter((a) => a.kind === "article");
        if (videos.length !== ownPlayers.length || articles.length !== articleCards.length || ownPlayers.some((player) => !videos.some((a) => player.outerHTML.includes(a.upload.id))))
          throw new Error("Substack attachment snapshots disagree with the selected public containers");
        for (const card of articleCards) {
          const links2 = [card, ...all(card.querySelectorAll("a"))].flatMap((e) => {
            const u = safeURL(e.getAttribute("href"), canonical);
            return u ? [new URL(u)] : [];
          });
          const article = articles.find((a) => links2.some((u) => {
            const expected = new URL(a.url);
            return u.hostname.replace(/^www\./, "") === expected.hostname.replace(/^www\./, "") && u.pathname === expected.pathname;
          }));
          if (!article || !normalize(card.textContent ?? "").includes(normalize(article.title)) && !normalize(card.textContent ?? "").includes(normalize(article.selection?.text ?? "\x00")))
            throw new Error("Substack article card identity or displayed preview disagrees with its source metadata");
        }
      }
      const embeddedURLs = all(root.querySelectorAll("iframe")).filter((frame) => !quoted(frame)).flatMap((iframe) => {
        const raw = safeURL(iframe.getAttribute("src"), canonical);
        if (!raw)
          return [];
        const u = new URL(raw);
        return /^(?:www\.)?youtube(?:-nocookie)?\.com$/.test(u.hostname) && /^\/embed\/[A-Za-z0-9_-]+$/.test(u.pathname) ? [`https://www.youtube.com/watch?v=${u.pathname.split("/").pop()}`] : [];
      });
      const ownText = normalize(body.textContent ?? "");
      const mentions = all(body.querySelectorAll('[class*="node-substack_mention"]')).map((e) => e.textContent ?? "").filter(Boolean);
      const cardURLs = attachmentEvidence?.attachments.filter((a) => a.kind === "article").map((a) => a.url) ?? [];
      const comparable = (value) => {
        for (const mention of mentions)
          value = value.split(`@${mention}`).join(mention);
        for (const address of cardURLs)
          value = value.split(address).join("");
        return normalize(value);
      };
      if (attachmentEvidence && comparable(attachmentEvidence.bodyText) !== comparable(body.textContent ?? ""))
        throw new Error("Substack attachment snapshot changed the authored Note body");
      if (structured && (typeof structured.text !== "string" || ![comparable(body.textContent ?? ""), comparable((body.textContent ?? "") + embeddedURLs.join(""))].includes(comparable(structured.text))))
        throw new Error("Substack body and public structured text disagree; complete capture cannot be established");
      if (bytes(body.innerHTML) > 500000)
        throw new Error("Substack Note body exceeds its bound");
      const links = [], media = [];
      const bodyCopy = body.cloneNode(true);
      function projectImage(image, remove) {
        let enclosing;
        for (let parent = image.parentElement;parent && parent !== root; parent = parent.parentElement) {
          if (parent.tagName === "A") {
            enclosing = parent;
            break;
          }
        }
        const direct = safeURL(enclosing?.getAttribute("href") ?? image.getAttribute("data-original"), canonical);
        const preview = safeURL(image.getAttribute("src"), canonical);
        let original = direct;
        if (!original && preview) {
          const fetched = new URL(preview);
          if (fetched.hostname === "substackcdn.com" && fetched.pathname.startsWith("/image/fetch/")) {
            try {
              const observed = safeURL(decodeURIComponent(fetched.pathname.split("/").pop()), canonical);
              if (observed && new URL(observed).hostname === "substack-post-media.s3.amazonaws.com")
                original = observed;
            } catch {}
          }
        }
        const href = original ?? preview;
        if (!href)
          throw new Error("Substack image has no usable public source");
        if (original && /\.(?:png|jpe?g|webp)(?:[?#]|$)/i.test(original))
          media.push({ kind: "image", url: original, alt: image.getAttribute("alt") ?? "" });
        else
          links.push({ kind: "image", role: "preview", url: preview ?? href });
        if (remove) {
          const node = image.parentElement?.tagName === "PICTURE" ? image.parentElement : image;
          if (node !== image && node.textContent?.trim())
            node.parentNode?.replaceChild(doc.createTextNode(node.textContent), node);
          else
            node.parentNode?.removeChild(node);
        }
      }
      for (const image of all(bodyCopy.querySelectorAll("img")))
        projectImage(image, true);
      if (bodyCopy.querySelector("video,audio,iframe,object,embed,picture"))
        throw new Error("Substack body includes media whose complete source has not been established");
      const header = root.children[0];
      for (const image of all(root.querySelectorAll("img")).filter((image2) => !quoted(image2) && !body.contains(image2) && !header?.contains(image2) && !ancestor(image2, "videoPlayerContainer-") && !articleCards.some((card) => card.contains(image2))))
        projectImage(image, false);
      if (all(root.querySelectorAll("audio,object,embed")).some((item) => !quoted(item) && !body.contains(item)) || !attachmentEvidence && all(root.querySelectorAll("video")).some((item) => !quoted(item) && !body.contains(item)))
        throw new Error("Substack attachment type has no verified complete source");
      if (quoteURLs.length > 1)
        throw new Error("Substack returned multiple ambiguous quoted Notes");
      const quotePreview = all(root.querySelectorAll(".ProseMirror")).filter((item) => item !== body);
      if (quoteURLs.length && quotePreview.length > 1)
        throw new Error("Substack quoted preview is ambiguous");
      if (!quoteURLs.length && !attachmentEvidence && (quotePreview.length || root.querySelector('[class*="elevatedTheme-"]')))
        throw new Error("Substack quoted article or attachment card needs a separately supported source projection");
      const note = {
        acquisition: { method: environment?.method ?? "browser-dom", observedAt: new Date().toISOString() },
        url: canonical,
        author: { handle, name, profileUrl: `https://substack.com${actor}` },
        body: { status: "complete", html: bodyCopy.innerHTML },
        publishedLabel: time.getAttribute("title"),
        links,
        ...attachmentEvidence ? { attachmentEvidence } : {},
        ...typeof structured?.datePublished === "string" && /(?:Z|[+-]\d{2}:\d{2})$/.test(structured.datePublished) && Number.isFinite(Date.parse(structured.datePublished)) ? { postedAt: new Date(structured.datePublished).toISOString() } : {},
        ...media.length ? { media } : {}
      };
      if (quoteURLs[0]) {
        const quotedURL = quoteURLs[0];
        note.quote = { url: quotedURL, previewHtml: quotePreview[0]?.innerHTML ?? "" };
        if (seen.has(identity(quotedURL).id))
          note.quote.status = "cycle";
        else if (depth >= maxDepth)
          note.quote.status = "depth_limit";
        else {
          try {
            note.quote.expanded = await extract(await load(quotedURL), quotedURL, depth + 1);
          } catch (error) {
            if (controller.signal.aborted)
              throw error;
            note.quote.status = "unavailable";
          }
        }
      }
      for (const iframe of all(root.querySelectorAll("iframe")).filter((frame) => !quoted(frame))) {
        const src = safeURL(iframe.getAttribute("src"), canonical);
        if (!src)
          throw new Error("Substack embedded player has no public source");
        const u = new URL(src);
        const youtube = /^(?:www\.)?youtube(?:-nocookie)?\.com$/.test(u.hostname) && /^\/embed\/[A-Za-z0-9_-]+$/.test(u.pathname);
        if (!youtube)
          throw new Error("Substack embedded media type is not supported");
        links.push({ kind: "video", role: "linked", url: `https://www.youtube.com/watch?v=${u.pathname.split("/").pop()}` });
      }
      if (links.length > 100 || media.length > 100)
        throw new Error("Too many Substack media references");
      return note;
    }
    try {
      const initial = environment ? environment.document ?? await load(start) : document;
      const note = await extract(initial, start, 0);
      if (!environment && identity(location.href).id !== selected.id)
        throw new Error("The Substack tab changed during capture");
      const capture = { schema: "arena-block/substack-browser-capture", version: 1, sourceUrl: note.url, observedAt: new Date().toISOString(), method: environment?.method ?? "browser-dom", note };
      if (bytes(JSON.stringify(capture)) > maxBytes)
        throw new Error("Substack capture exceeds 2 MiB");
      return capture;
    } finally {
      clearTimeout(timer);
      environment?.signal?.removeEventListener("abort", abort);
    }
  }

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
      if (location.hostname === "substack.com" && /\/note\/c-\d+/.test(location.pathname)) {
        readSubstackPage().then((value) => arguments_.completionFunction({ substackCapture: JSON.stringify(value) }), (error) => arguments_.completionFunction({ substackError: error instanceof Error ? error.message : String(error) }));
        return;
      }
      if (!["www.reddit.com", "reddit.com", "old.reddit.com", "new.reddit.com"].includes(location.hostname)) {
        arguments_.completionFunction({ sourceUrl: location.href });
        return;
      }
      readRedditPage().then((value) => arguments_.completionFunction({ redditCapture: JSON.stringify(value) }), (error) => {
        const message = error instanceof Error ? error.message : String(error);
        arguments_.completionFunction(/Reddit browser read returned HTTP 403 without usable JSON/.test(message) ? { redditSourceUrl: location.href } : { redditError: message });
      });
    }
  };
})();
