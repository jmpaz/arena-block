import { expect, test } from "bun:test";
import { createDocument } from "@mixmark-io/domino";
import { createHash } from "node:crypto";
import { createContext, runInContext } from "node:vm";
import { readSubstackPage } from "../packages/core/substack-page.ts";
import { normalizeSubstackCapture } from "../packages/core/substack-record.ts";
import { resolveCapture } from "../extension/src/core.ts";
import { blockPlanSchema } from "../packages/core/types.ts";
import { selectedPostMediaPolicy } from "../src/cli-media.ts";
import { composePlan } from "../packages/core/compose.ts";

const rootURL = "https://substack.com/@henrikkarlsson/note/c-313838934";
const quoteURL = "https://substack.com/@sindhusprasad/note/c-313830666";
const html = await Bun.file(new URL("./fixtures/substack-mixed-root.html", import.meta.url)).text();
const quoteHTML = await Bun.file(new URL("./fixtures/substack-mixed-quote.html", import.meta.url)).text();
const api = await Bun.file(new URL("./fixtures/substack-mixed-root.json", import.meta.url)).json();
const quoteText = api.item.comment.attachments[1].comment.body;
const title = api.item.comment.attachments[0].post.title;

function sources(options: { json?: any; root?: string; quote?: string; unavailable?: boolean } = {}) {
  const calls: string[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.credentials).toBe("omit");
    const url = String(input); calls.push(url);
    if (url === "https://substack.com/api/v1/reader/comment/313838934") return Response.json(options.json ?? api);
    if (url === rootURL) return new Response(options.root ?? html, { headers: { "content-type": "text/html" } });
    if (url === quoteURL) return new Response(options.quote ?? quoteHTML, { status: options.unavailable ? 404 : 200, headers: { "content-type": "text/html" } });
    throw new Error("Unexpected source acquisition: " + url);
  }) as typeof fetch;
  return { fetcher, calls };
}

test("actual article plus comment attachment retains complete writing, card attribution and quoted Note", async () => {
  const { fetcher, calls } = sources();
  const plan = await resolveCapture({ primary: [rootURL + "?utm_source=chatgpt.com"], extras: [], policy: { threadExpansion: "off" } }, undefined, fetcher);
  const source = plan.sources[0]!;
  expect(source.text).toContain("So on the question");
  expect(source.text).toContain("both approaches have their strengths.");
  const normalized = source.text.replace(/\s+/g, "");
  for (const paragraph of api.item.comment.body_json.content) for (const part of paragraph.content) {
    expect(normalized).toContain(part.text.replace(/\s+/g, ""));
  }
  expect(source.text).toContain(`[${title}]`);
  expect(source.text).toContain("by Henrik Karlsson");
  expect(source.text).not.toContain(quoteText);
  expect(source.quote).toMatchObject({ id: "313830666", author: { handle: "sindhusprasad", name: "Sindhu Shivaprasad" }, text: quoteText });
  expect(plan.block.markdown).toContain(quoteText);
  expect(plan.block.canonicalSource).toBe(rootURL);
  expect(plan.sources).toHaveLength(1);
  expect(plan.block.selectedMedia).toEqual([]);
  expect(calls).toEqual([rootURL, "https://substack.com/api/v1/reader/comment/313838934", quoteURL]);
  expect(blockPlanSchema.parse(plan)).toEqual(plan);
  expect(source.substackCapture!.note.attachmentEvidence!.attachments.map(a => a.kind)).toEqual(["article"]);
  expect(source.substackCapture!.note.quote!.expanded!.body.html).toContain("What changed");
});

test("native video plus a comment quote retains both originals and CLI quote-media defaults", async () => {
  const videoHTML = await Bun.file(new URL("./fixtures/substack-video-note-public.html", import.meta.url)).text();
  const json = await Bun.file(new URL("./fixtures/substack-video-note-public.json", import.meta.url)).json();
  const comment = json.item.comment;
  const videoURL = `https://substack.com/@${comment.handle}/note/c-${comment.id}`;
  const root = createDocument(videoHTML), original = createDocument(html);
  const card = Array.from(original.querySelector('[class*="feedPermalinkUnit-"]')!.children).find(e => e.textContent?.includes("Sindhu Shivaprasad"))!;
  root.querySelector('[class*="feedPermalinkUnit-"]')!.appendChild(root.importNode(card, true));
  comment.attachments.push(structuredClone(api.item.comment.attachments[1]));
  const image = "https://substack-post-media.s3.amazonaws.com/public/images/11111111-1111-4111-8111-111111111111_640x480.png";
  comment.attachments.at(-1).comment.attachments = [{ id: "22222222-2222-4222-8222-222222222222", type: "image", imageUrl: image }];
  const quoted = createDocument(quoteHTML), picture = quoted.createElement("img");
  picture.setAttribute("src", image); picture.setAttribute("data-original", image);
  quoted.querySelector('[class*="feedPermalinkUnit-"]')!.appendChild(picture);
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.credentials).toBe("omit");
    if (String(input) === videoURL) return new Response(root.documentElement.outerHTML, { headers: { "content-type": "text/html" } });
    if (String(input) === `https://substack.com/api/v1/reader/comment/${comment.id}`) return Response.json(json);
    if (String(input) === quoteURL) return new Response(quoted.documentElement.outerHTML, { headers: { "content-type": "text/html" } });
    throw new Error("Unrelated thread acquisition: " + input);
  }) as typeof fetch;
  const plan = await resolveCapture({ primary: [videoURL], extras: [], policy: { threadExpansion: "off" } }, undefined, fetcher);
  expect(plan.sources[0]!.media).toHaveLength(1);
  expect(plan.sources[0]!.media[0]!.kind).toBe("video");
  expect(plan.sources[0]!.quote!.media[0]!.url).toBe(image);
  expect(plan.block.markdown).toContain(quoteText);
  const all = selectedPostMediaPolicy(plan.sources, { ...plan.policy, media: "all" });
  expect(composePlan(plan.sources, all).block.selectedMedia).toEqual(["1.1"]);
  const quotes = selectedPostMediaPolicy(plan.sources, { ...plan.policy, media: "all" }, true);
  expect(composePlan(plan.sources, quotes).block.selectedMedia).toEqual(["1.1", "1.2"]);
  expect(composePlan(plan.sources, { ...quotes, quoteDepth: 0 }).block.selectedMedia).toEqual(["1.1"]);
});

test("known quoted attachments cannot disappear from a complete text-only expansion", async () => {
  const image = { id: "22222222-2222-4222-8222-222222222222", type: "image",
    imageUrl: "https://substack-post-media.s3.amazonaws.com/public/images/11111111-1111-4111-8111-111111111111_640x480.png", imageWidth: 640, imageHeight: 480 };
  const video = (await Bun.file(new URL("./fixtures/substack-video-note-public.json", import.meta.url)).json()).item.comment.attachments[0];
  const article = structuredClone(api.item.comment.attachments[0]);
  const link = { id: "33333333-3333-4333-8333-333333333333", type: "link",
    linkMetadata: { url: "https://example.com/essay", title: "Linked essay", description: "A known preview" } };
  for (const attachments of [[image], [null], [{ ...image, type: "unknown" }], [image, image], [video], [article], [link], [api.item.comment.attachments[1]]]) {
    const json = structuredClone(api); json.item.comment.attachments[1].comment.attachments = attachments;
    const { fetcher } = sources({ json });
    await expect(resolveCapture({ primary: [rootURL], extras: [], policy: {} }, undefined, fetcher)).rejects.toThrow();
    const omitted = sources({ json });
    const bounded = await resolveCapture({ primary: [rootURL], extras: [], policy: { quoteDepth: 0 } }, undefined, omitted.fetcher);
    expect(bounded.block.markdown).toContain(title);
    expect(bounded.block.markdown).not.toContain(quoteText);
    expect(omitted.calls).not.toContain(quoteURL);
  }
});

test("full quoted native video evidence is reconciled and remains quote-only media", async () => {
  const videoHTML = await Bun.file(new URL("./fixtures/substack-video-note-public.html", import.meta.url)).text();
  const videoAPI = await Bun.file(new URL("./fixtures/substack-video-note-public.json", import.meta.url)).json();
  const comment = videoAPI.item.comment, videoURL = `https://substack.com/@${comment.handle}/note/c-${comment.id}`;
  const root = createDocument(html), quoted = createDocument(videoHTML);
  const parent = root.querySelector('[class*="feedPermalinkUnit-"]')!;
  Array.from(parent.children).find(e => e.textContent?.includes("Sindhu Shivaprasad"))!.remove();
  const container = root.createElement("div"); container.className = "elevatedTheme-fixture commentContainer-fixture";
  container.appendChild(root.importNode(quoted.querySelector('[class*="feedPermalinkUnit-"]')!, true)); parent.appendChild(container);
  const json = structuredClone(api);
  json.item.comment.attachments[1].comment = { ...comment, user: { id: comment.user_id, name: comment.name, handle: comment.handle } };
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.credentials).toBe("omit");
    if (String(input) === rootURL) return new Response(root.documentElement.outerHTML, { headers: { "content-type": "text/html" } });
    if (String(input) === "https://substack.com/api/v1/reader/comment/313838934") return Response.json(json);
    if (String(input) === videoURL) return new Response(videoHTML, { headers: { "content-type": "text/html" } });
    if (String(input) === `https://substack.com/api/v1/reader/comment/${comment.id}`) return Response.json(videoAPI);
    throw new Error("Unrelated quote acquisition: " + input);
  }) as typeof fetch;
  const plan = await resolveCapture({ primary: [rootURL], extras: [], policy: {} }, undefined, fetcher);
  expect(plan.sources[0]!.quote!.media[0]!.kind).toBe("video");
  expect(plan.block.selectedMedia).toEqual([]);
  expect(composePlan(plan.sources, selectedPostMediaPolicy(plan.sources, { ...plan.policy, media: "all" }, true)).block.selectedMedia).toEqual(["1.1"]);
});

test("nested known quote attachments propagate through plain quoted Notes without silent loss", async () => {
  const nestedURL = quoteURL.replace("313830666", "413830666");
  const imageURL = "https://substack-post-media.s3.amazonaws.com/public/images/11111111-1111-4111-8111-111111111111_640x480.png";
  const nestedAttachment = structuredClone(api.item.comment.attachments[1]);
  nestedAttachment.id = "44444444-4444-4444-8444-444444444444";
  nestedAttachment.comment.id = 413830666;
  nestedAttachment.comment.attachments = [{ id: "22222222-2222-4222-8222-222222222222", type: "image", imageUrl: imageURL, imageWidth: 640, imageHeight: 480 }];
  const json = structuredClone(api); json.item.comment.attachments[1].comment.attachments = [nestedAttachment];
  const outer = createDocument(quoteHTML), nested = outer.createElement("div");
  nested.className = "commentContainer-fixture elevatedTheme-fixture";
  const anchor = outer.createElement("a"); anchor.href = nestedURL; anchor.title = "Aug 13, 2026"; anchor.textContent = "Aug 13";
  nested.appendChild(anchor);
  const preview = outer.createElement("div"); preview.className = "ProseMirror"; preview.textContent = quoteText; nested.appendChild(preview);
  outer.querySelector('[class*="feedPermalinkUnit-"]')!.appendChild(nested);
  for (const includeImage of [false, true]) {
    const leaf = createDocument(quoteHTML.replaceAll("313830666", "413830666"));
    if (includeImage) {
      const image = leaf.createElement("img"); image.setAttribute("src", imageURL); image.setAttribute("data-original", imageURL);
      leaf.querySelector('[class*="feedPermalinkUnit-"]')!.appendChild(image);
    }
    const base = sources({ json, quote: outer.documentElement.outerHTML }), calls: string[] = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(String(input));
      if (String(input) === nestedURL) return new Response(leaf.documentElement.outerHTML, { headers: { "content-type": "text/html" } });
      return base.fetcher(input, init);
    }) as typeof fetch;
    const read = resolveCapture({ primary: [rootURL], extras: [], policy: { quoteDepth: 2 } }, undefined, fetcher);
    if (includeImage) {
      const plan = await read;
      expect(plan.sources[0]!.quote!.quote!.media[0]).toMatchObject({ url: imageURL, width: 640, height: 480 });
      expect(plan.block.selectedMedia).toEqual([]);
    } else await expect(read).rejects.toThrow("image attachments");
    expect(calls).toContain(nestedURL);
  }
});

test("mixed quoted Note evidence rejects changed or duplicate attachment identities and authors", async () => {
  const changes = [
    (c: any) => c.attachments[1].comment.id++,
    (c: any) => c.attachments[1].comment.user_id++,
    (c: any) => c.attachments[1].comment.user.id++,
    (c: any) => c.attachments[1].comment.user.handle = "otherauthor",
    (c: any) => c.attachments[1].comment.user.name = "Other Author",
    (c: any) => c.attachments[1].comment.body = "Changed quote",
    (c: any) => c.attachments[1].comment.type = "comment",
    (c: any) => c.attachments[1].comment.post_id = 12,
    (c: any) => c.attachments[1].post = { id: 12 },
    (c: any) => delete c.attachments[1].id,
    (c: any) => c.attachments[1].id = "",
    (c: any) => c.attachments[1].id = "unverified",
    (c: any) => c.attachments.push(structuredClone(c.attachments[1])),
    (c: any) => c.attachments[1].id = c.attachments[0].id,
  ];
  for (const change of changes) {
    const json = structuredClone(api); change(json.item.comment);
    const { fetcher } = sources({ json });
    await expect(readSubstackPage(rootURL, { url: rootURL, parseHTML: createDocument, fetcher })).rejects.toThrow();
  }
});

test("missing, unavailable or mismatched quote containers cannot silently remove a known comment attachment", async () => {
  const doc = createDocument(html);
  const card = Array.from(doc.querySelector('[class*="feedPermalinkUnit-"]')!.children).find(e => e.textContent?.includes("Sindhu Shivaprasad"))!;
  card.remove();
  for (const options of [{ root: doc.documentElement.outerHTML }, { unavailable: true },
    { quote: quoteHTML.replace("What changed about it/ you", "Invented source text") },
    { quote: quoteHTML.replaceAll('"identifier":9764589', '"identifier":1').replaceAll('"identifier":"9764589"', '"identifier":"1"') }]) {
    const { fetcher } = sources(options);
    await expect(readSubstackPage(rootURL, { url: rootURL, parseHTML: createDocument, fetcher })).rejects.toThrow();
  }
});

test("explicit quote omission and depth bounds retain root and card without traversing the quote", async () => {
  for (const policy of [{ quoteDepth: 0 }, { quote: "omit" as const }]) {
    const { fetcher, calls } = sources();
    const plan = await resolveCapture({ primary: [rootURL], extras: [], policy }, undefined, fetcher);
    expect(plan.block.markdown).toContain(title);
    expect(plan.block.markdown).not.toContain(quoteText);
    expect(calls).not.toContain(quoteURL);
    expect(plan.sources[0]!.substackCapture!.note.quote!.status).toBe("depth_limit");
  }
});

test("a numeric-profile quote route binds the same author identity without losing its source", async () => {
  const profileURL = "https://substack.com/profile/9764589-sindhu/note/c-313830666";
  const aliased = html.replaceAll(quoteURL, profileURL).replaceAll(new URL(quoteURL).pathname, new URL(profileURL).pathname), base = sources();
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === rootURL) return new Response(aliased, { headers: { "content-type": "text/html" } });
    return base.fetcher(String(input) === profileURL ? quoteURL : input, init);
  }) as typeof fetch;
  const record = normalizeSubstackCapture(await readSubstackPage(rootURL, { url: rootURL, parseHTML: createDocument, fetcher }));
  expect(record.note.quote!.url).toBe(profileURL);
  expect(record.note.quote!.expanded!.author.handle).toBe("sindhusprasad");
  const wrong = aliased.replaceAll("/profile/9764589-sindhu/", "/profile/1-sindhu/");
  await expect(readSubstackPage(rootURL, { url: rootURL, document: createDocument(wrong), parseHTML: createDocument, fetcher })).rejects.toThrow();
});

test("serialized browser reader and native capture render the same mixed attachment result", async () => {
  const { fetcher } = sources();
  const browser = createContext({ document: createDocument(html), location: { href: rootURL }, URL, TextDecoder, AbortController,
    setTimeout, clearTimeout, fetch: fetcher, DOMParser: class { parseFromString(value: string) { return createDocument(value); } } });
  const record = normalizeSubstackCapture(await runInContext(`(${readSubstackPage.toString()})()`, browser));
  expect(record.note.quote!.expanded!.body.html).toContain("What changed");
  let finish!: (value: any) => void;
  const complete = new Promise<any>(resolve => finish = resolve);
  const native = createContext({ nativeSHA256: (value: string) => createHash("sha256").update(value).digest("hex"),
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms).unref(), clearTimeout, nativeCancelHTTP: () => {},
    nativeHTTP: (id: number, value: string) => { const request = JSON.parse(value); void fetcher(request.url, { credentials: "omit" }).then(async response =>
      native.captureHTTPComplete(id, JSON.stringify({ status: response.status, url: request.url, headers: { "content-type": response.headers.get("content-type") }, body: await response.text() }))); },
    nativeResolveComplete: (_id: string, result: string | null, error: string | null) => finish({ result, error }) });
  runInContext(await Bun.file(new URL("../ios/Sources/CaptureRuntime/Resources/capture-core.js", import.meta.url)).text(), native);
  native.captureResolve("mixed", JSON.stringify([rootURL]), JSON.stringify({ threadExpansion: "off" }));
  const output = await complete;
  expect(output.error).toBeNull();
  const expected = await resolveCapture({ primary: [rootURL], extras: [], policy: { threadExpansion: "off" } }, undefined, fetcher);
  expect(JSON.parse(output.result).plan.block).toEqual(expected.block);
});
