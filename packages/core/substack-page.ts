/** Self-contained: shared by ordinary public-page reads and user-invoked browser/Safari reads. */
export async function readSubstackPage(expectedUrl?: string, environment?: {
  document?: Document; url: string; parseHTML: (html: string) => Document; fetcher: typeof fetch;
  method?: "public-html" | "browser-dom"; maxDepth?: number; signal?: AbortSignal;
}): Promise<unknown> {
  const maxBytes = 2 * 1024 * 1024, maxDepth = environment?.maxDepth ?? 8;
  const start = environment?.url ?? location.href;
  function identity(value: string) {
    const url = new URL(value, start);
    const match = /^\/(?:(@[a-zA-Z0-9_]+|profile\/[1-9]\d*(?:-[a-zA-Z0-9_-]+)?)\/)?note\/c-([1-9]\d*)\/?$/.exec(url.pathname);
    if (url.protocol !== "https:" || url.hostname !== "substack.com" || url.username || url.password || url.port || !match) throw new Error("Expected a public Substack Note permalink");
    return { id: match[2]!, url: `https://substack.com/${match[1] ? `${match[1]}/` : ""}note/c-${match[2]}` };
  }
  const selected = identity(start);
  if (expectedUrl && identity(expectedUrl).id !== selected.id) throw new Error("The Substack tab changed; choose its current Note again");
  const controller = new AbortController();
  const abort = () => controller.abort();
  environment?.signal?.addEventListener("abort", abort, { once: true });
  if (environment?.signal?.aborted) controller.abort();
  const timer = setTimeout(abort, 20_000);
  const fetcher = environment?.fetcher ?? fetch;
  const parseHTML = environment?.parseHTML ?? ((html: string) => new DOMParser().parseFromString(html, "text/html"));
  const all = <T extends Element>(items: NodeListOf<T> | HTMLCollectionOf<T>): T[] => Array.from(items);
  function bytes(text: string): number { let count = 0; for (const c of text) { const p = c.codePointAt(0)!; count += p < 128 ? 1 : p < 2048 ? 2 : p < 65536 ? 3 : 4; } return count; }
  function noteId(value: string | null) { try { return identity(value ?? "").id; } catch { return undefined; } }
  function safeURL(value: string | null, base: string): string | undefined {
    if (!value) return undefined;
    try { const u = new URL(value ?? "", base); return u.protocol === "https:" && !u.username && !u.password && !u.port ? u.href : undefined; } catch { return undefined; }
  }
  function ancestor(node: Element, part: string): Element | undefined {
    for (let e: Element | null = node; e; e = e.parentElement) if (e.className?.includes(part)) return e;
    return undefined;
  }
  let received = 0;
  async function load(url: string): Promise<Document> {
    const canonical = identity(url).url;
    const response = await fetcher(canonical, { credentials: "omit", redirect: "error", signal: controller.signal, headers: { accept: "text/html" } });
    if (!response.ok) throw new Error(`Substack public page returned HTTP ${response.status}; no authenticated fallback was attempted`);
    if (!response.headers.get("content-type")?.includes("text/html")) throw new Error("Substack public page did not return HTML");
    if (response.url && identity(response.url).id !== identity(canonical).id) throw new Error("Substack returned a different source");
    if (Number(response.headers.get("content-length")) > maxBytes) throw new Error("Substack page exceeds 2 MiB");
    let text: string;
    if (response.body?.getReader) {
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
      try { while (true) { const { value, done } = await reader.read(); if (done) break; length += value.byteLength; received += value.byteLength; if (length > maxBytes || received > 4 * maxBytes) { controller.abort(); throw new Error("Substack page acquisition exceeds its byte bound"); } chunks.push(value); } }
      finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
      const raw = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.length; }
      text = new TextDecoder().decode(raw);
    } else { text = await response.text(); received += bytes(text); if (bytes(text) > maxBytes || received > 4 * maxBytes) throw new Error("Substack page acquisition exceeds its byte bound"); }
    return parseHTML(text);
  }
  const seen = new Set<string>();
  async function extract(doc: Document, url: string, depth: number): Promise<any> {
    if (controller.signal.aborted) throw new Error("Substack acquisition cancelled");
    const target = identity(url); seen.add(target.id);
    const roots = all(doc.querySelectorAll('[class*="feedPermalinkUnit-"]')).filter(root => all(root.querySelectorAll("a[title]")).some(a => noteId(a.getAttribute("href")) === target.id && !ancestor(a, "commentContainer-")));
    if (roots.length !== 1) throw new Error("Substack public Note body is unavailable or the page structure changed");
    const root = roots[0]!;
    const bodies = all(root.querySelectorAll('[class*="feedCommentBody-"] .ProseMirror')).filter(body => !ancestor(body, "commentContainer-"));
    if (bodies.length !== 1) throw new Error("Substack selected Note has no unambiguous full body");
    const body = bodies[0]!;
    if (all(root.querySelectorAll("button")).some(b => /^(?:show|read|see) more$/i.test(b.textContent?.trim() ?? ""))) throw new Error("Substack Note is a collapsed preview; expand it before capture");
    const time = all(root.querySelectorAll("a[title]")).find(a => noteId(a.getAttribute("href")) === target.id)!;
    const canonical = identity(time.getAttribute("href")!).url;
    const actor = new URL(canonical).pathname.replace(/\/note\/c-\d+$/, "");
    const authorLinks = all(root.querySelectorAll("a")).filter(a => { const u = safeURL(a.getAttribute("href"), canonical); return u && new URL(u).pathname === actor && !!a.textContent?.trim(); });
    const name = authorLinks.find(a => !a.textContent?.startsWith("@"))?.textContent?.trim();
    const handle = actor.startsWith("/@") ? actor.slice(2) : authorLinks.find(a => a.textContent?.startsWith("@"))?.textContent?.trim().slice(1);
    if (!name || !handle) throw new Error("Substack Note author is unavailable");
    const structured = all(doc.querySelectorAll('script[type="application/ld+json"]')).flatMap(script => {
      try { const value = JSON.parse(script.textContent ?? ""); return Array.isArray(value) ? value : [value]; } catch { return []; }
    }).find(value => value?.["@type"] === "SocialMediaPosting" && value.identifier === `c-${target.id}` && noteId(value.url) === target.id);
    const normalize = (value: string) => value.replace(/\s+/g, "");
    const quoted = (element: Element) => !!ancestor(element, "elevatedTheme-") || !!ancestor(element, "commentContainer-");
    const embeddedURLs = all(root.querySelectorAll("iframe")).filter(frame => !quoted(frame)).flatMap(iframe => {
      const raw = safeURL(iframe.getAttribute("src"), canonical); if (!raw) return [];
      const u = new URL(raw); return /^(?:www\.)?youtube(?:-nocookie)?\.com$/.test(u.hostname) && /^\/embed\/[A-Za-z0-9_-]+$/.test(u.pathname) ? [`https://www.youtube.com/watch?v=${u.pathname.split("/").pop()}`] : [];
    });
    const ownText = normalize(body.textContent ?? "");
    if (structured && (typeof structured.text !== "string" || ![ownText, ownText + normalize(embeddedURLs.join(""))].includes(normalize(structured.text)))) throw new Error("Substack body and public structured text disagree; complete capture cannot be established");
    if (bytes(body.innerHTML) > 500_000) throw new Error("Substack Note body exceeds its bound");
    const links: any[] = [], media: any[] = [];
    const bodyCopy = body.cloneNode(true) as Element;
    function projectImage(image: Element, remove: boolean) {
      let enclosing: Element | undefined;
      for (let parent = image.parentElement; parent && parent !== root; parent = parent.parentElement) { if (parent.tagName === "A") { enclosing = parent; break; } }
      const direct = safeURL(enclosing?.getAttribute("href") ?? image.getAttribute("data-original"), canonical);
      const preview = safeURL(image.getAttribute("src"), canonical);
      let original = direct;
      if (!original && preview) {
        const fetched = new URL(preview);
        if (fetched.hostname === "substackcdn.com" && fetched.pathname.startsWith("/image/fetch/")) {
          try { const observed = safeURL(decodeURIComponent(fetched.pathname.split("/").pop()!), canonical);
            if (observed && new URL(observed).hostname === "substack-post-media.s3.amazonaws.com") original = observed;
          } catch { /* No original was observed. */ }
        }
      }
      const href = original ?? preview;
      if (!href) throw new Error("Substack image has no usable public source");
      if (original && /\.(?:png|jpe?g|webp)(?:[?#]|$)/i.test(original)) media.push({ kind: "image", url: original, alt: image.getAttribute("alt") ?? "" });
      else links.push({ kind: "image", role: "preview", url: preview ?? href });
      if (remove) {
        const node = image.parentElement?.tagName === "PICTURE" ? image.parentElement : image;
        if (node !== image && node.textContent?.trim()) node.parentNode?.replaceChild(doc.createTextNode(node.textContent), node);
        else node.parentNode?.removeChild(node);
      }
    }
    for (const image of all(bodyCopy.querySelectorAll("img"))) projectImage(image, true);
    if (bodyCopy.querySelector("video,audio,iframe,object,embed,picture")) throw new Error("Substack body includes media whose complete source has not been established");
    const header = root.children[0];
    for (const image of all(root.querySelectorAll("img")).filter(image => !quoted(image) && !body.contains(image) && !header?.contains(image))) projectImage(image, false);
    if (all(root.querySelectorAll("video,audio,object,embed")).some(item => !quoted(item) && !body.contains(item))) throw new Error("Substack attachment type has no verified complete source");
    const quoteURLs = [...new Set(all(root.querySelectorAll("a[title]")).flatMap(a => {
      const href = a.getAttribute("href"); return noteId(href) && noteId(href) !== target.id ? [identity(href!).url] : [];
    }))];
    if (quoteURLs.length > 1) throw new Error("Substack returned multiple ambiguous quoted Notes");
    const quotePreview = all(root.querySelectorAll(".ProseMirror")).filter(item => item !== body);
    if (quotePreview.length > 1) throw new Error("Substack quoted preview is ambiguous");
    if (!quoteURLs.length && (quotePreview.length || root.querySelector('[class*="elevatedTheme-"]'))) throw new Error("Substack quoted article or attachment card needs a separately supported source projection");
    const note: any = { acquisition: { method: environment?.method ?? "browser-dom", observedAt: new Date().toISOString() }, url: canonical, author: { handle, name, profileUrl: `https://substack.com${actor}` },
      body: { status: "complete", html: bodyCopy.innerHTML }, publishedLabel: time.getAttribute("title"), links,
      ...(typeof structured?.datePublished === "string" && /(?:Z|[+-]\d{2}:\d{2})$/.test(structured.datePublished) && Number.isFinite(Date.parse(structured.datePublished)) ? { postedAt: new Date(structured.datePublished).toISOString() } : {}), ...(media.length ? { media } : {}) };
    if (quoteURLs[0]) {
      const quotedURL = quoteURLs[0];
      note.quote = { url: quotedURL, previewHtml: quotePreview[0]?.innerHTML ?? "" };
      if (seen.has(identity(quotedURL).id)) note.quote.status = "cycle";
      else if (depth >= maxDepth) note.quote.status = "depth_limit";
      else { try { note.quote.expanded = await extract(await load(quotedURL), quotedURL, depth + 1); }
        catch (error) { if (controller.signal.aborted) throw error; note.quote.status = "unavailable"; } }
    }
    for (const iframe of all(root.querySelectorAll("iframe")).filter(frame => !quoted(frame))) {
      const src = safeURL(iframe.getAttribute("src"), canonical); if (!src) throw new Error("Substack embedded player has no public source");
      const u = new URL(src); const youtube = /^(?:www\.)?youtube(?:-nocookie)?\.com$/.test(u.hostname) && /^\/embed\/[A-Za-z0-9_-]+$/.test(u.pathname);
      if (!youtube) throw new Error("Substack embedded media type is not supported");
      links.push({ kind: "video", role: "linked", url: `https://www.youtube.com/watch?v=${u.pathname.split("/").pop()}` });
    }
    if (links.length > 100 || media.length > 100) throw new Error("Too many Substack media references");
    return note;
  }
  try {
    const initial = environment ? environment.document ?? await load(start) : document;
    const note = await extract(initial, start, 0);
    if (!environment && identity(location.href).id !== selected.id) throw new Error("The Substack tab changed during capture");
    const capture = { schema: "arena-block/substack-browser-capture", version: 1, sourceUrl: note.url, observedAt: new Date().toISOString(), method: environment?.method ?? "browser-dom", note };
    if (bytes(JSON.stringify(capture)) > maxBytes) throw new Error("Substack capture exceeds 2 MiB");
    return capture;
  } finally { clearTimeout(timer); environment?.signal?.removeEventListener("abort", abort); }
}
