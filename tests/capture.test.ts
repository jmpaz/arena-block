import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureSource, publicationFields, publicationPayload, webPlan } from "../src/capture.ts";
import { composePlan } from "../src/compose.ts";
import { createService } from "../src/service.ts";
import { ArenaBlockStore } from "../src/store.ts";

test("public media supports metadata probes, partial reads and missing artifacts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arena-media-")); directories.push(directory);
  const mediaDirectory = join(directory, "media");
  const hash = "a".repeat(64);
  await mkdir(join(mediaDirectory, "aa"), { recursive: true });
  await Bun.write(join(mediaDirectory, "aa", `${hash}.mp4`), "0123456789");
  const service = createService({ host: "localhost", port: 8790, publicBaseUrl: "https://engine.example", stateDirectory: directory,
    mediaDirectory, accessToken: "engine-key", arenaToken: "never-used" });
  const url = `https://engine.example/media/${hash}.mp4`;
  try {
    const head = await service.handler(new Request(url, { method: "HEAD" }));
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe("video/mp4");
    expect(head.headers.get("content-length")).toBe("10");
    expect(await head.text()).toBe("");
    for (const [range, content, span] of [["bytes=2-4", "234", "2-4"], ["bytes=8-", "89", "8-9"],
      ["bytes=-3", "789", "7-9"], ["bytes=8-99", "89", "8-9"]]) {
      const response = await service.handler(new Request(url, { headers: { range: range! } }));
      expect(response.status).toBe(206);
      expect(response.headers.get("content-range")).toBe(`bytes ${span}/10`);
      expect(await response.text()).toBe(content!);
    }
    for (const range of ["bytes=10-", "bytes=5-2", "bytes=-0", "bytes=-", "bytes=0-1,3-4", "bytes=999999999999999999999-"]) {
      const response = await service.handler(new Request(url, { headers: { range } }));
      expect(response.status).toBe(416);
      expect(response.headers.get("content-range")).toBe("bytes */10");
    }
    expect((await service.handler(new Request(url.replace(hash, "b".repeat(64)), { method: "HEAD" }))).status).toBe(404);
    expect(await (await service.handler(new Request(url))).text()).toBe("0123456789");
  } finally { service.close(); }
});

test("stored snapshots and uncertain attempts can be inspected only with daemon authorization", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arena-inspection-")); directories.push(directory);
  const value = composePlan([{ provider: "x", id: "1", canonicalUrl: "https://x.com/person/status/1", author: { handle: "person" }, text: "Original snapshot", media: [] }]);
  const store = new ArenaBlockStore(join(directory, "arena-block.sqlite"));
  store.savePlan(value);
  const operationId = crypto.randomUUID();
  store.beginOperation(operationId, value.hash);
  store.reserveCreation({ id: "unknown", planHash: value.hash, destinations: ["first", "second"], status: "creation_unknown", createdAt: new Date().toISOString() }, false, operationId);
  store.close();
  const service = createService({ host: "localhost", port: 8790, publicBaseUrl: "https://engine.example", stateDirectory: directory,
    mediaDirectory: directory, accessToken: "engine-key", arenaToken: "never-used" });
  try {
    for (const path of [`/v1/plans/${value.hash}`, "/v1/publication-attempts/unknown", `/v1/publications?plan=${value.hash}`, `/v1/publication-operations/${operationId}`]) {
      expect((await service.handler(new Request("https://engine.example" + path))).status).toBe(401);
    }
    const read = (path: string) => service.handler(new Request("https://engine.example" + path, { headers: { authorization: "Bearer engine-key" } }));
    expect(await (await read(`/v1/plans/${value.hash}`)).json()).toEqual(value);
    expect(await (await read("/v1/publication-attempts/unknown")).json()).toMatchObject({ status: "creation_unknown", destinations: ["first", "second"] });
    expect((await read("/v1/publication-attempts/missing")).status).toBe(404);
    expect(await (await read(`/v1/publications?plan=${value.hash}`)).json()).toMatchObject({ attempt: { id: "unknown" } });
    expect(await (await read(`/v1/publication-operations/${operationId}`)).json()).toMatchObject({ operationId, attempt: { id: "unknown" } });
    expect((await read(`/v1/publication-operations/${crypto.randomUUID()}`)).status).toBe(404);
    expect((await read("/v1/publications?plan=bad")).status).toBe(400);
  } finally { service.close(); }
});

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

test("generic links stay links, while recognized invalid social URLs fail", () => {
  expect(captureSource("https://example.com/article?a=1#part")).toEqual({ kind: "url", url: "https://example.com/article?a=1#part" });
  expect(captureSource("https://twitter.com/person/status/123?s=20")).toEqual({ kind: "social", url: "https://x.com/person/status/123" });
  expect(() => captureSource("https://x.com/person")).toThrow();
  expect(() => captureSource("file:///etc/passwd")).toThrow();
  expect(() => captureSource("https://user:password@example.com")).toThrow();
  expect(() => captureSource("at://person/app.other/123")).toThrow();
});

test("text creation defers URL-leading prose while retaining attribution and exact content", () => {
  const text = "https://example.com/article writes about collecting field notes.";
  const plan = composePlan([{ provider: "x", id: "123", canonicalUrl: "https://x.com/person/status/123", author: { handle: "person" }, text, media: [] }]);
  const payload = publicationPayload(plan, "https://engine.example", undefined, [1, 1, 2]);
  expect(payload.value).toBe(`arena-block text ${plan.hash}`);
  expect(payload.description).toBe(`arena-block description ${plan.hash}`);
  expect(payload.channel_ids).toEqual([1, 2]);
  expect(payload.original_source_url).toBe(plan.block.canonicalSource);
  expect(publicationFields(plan).content).toBe(text);
});

test("link creation leaves authored descriptions for the update while preserving its destination", () => {
  const plan = webPlan({ url: "https://example.com/article", description: "https://example.com/reference describes this article." });
  const payload = publicationPayload(plan, "https://engine.example", undefined, [1]);
  expect(payload.value).toBe(plan.block.canonicalSource);
  expect(payload.description).toBe(`arena-block description ${plan.hash}`);
  expect(publicationFields(plan).description).toBe(plan.block.description);
});

test("capture preparation is authenticated and never publishes using the daemon account", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arena-capture-")); directories.push(directory);
  const service = createService({ host: "localhost", port: 8790, publicBaseUrl: "https://engine.example", stateDirectory: directory, mediaDirectory: join(directory, "media"), accessToken: "engine-key", arenaToken: "never-used" });
  const request = (path: string, body: unknown, authenticated = true) => new Request(`https://engine.example${path}`, { method: "POST", headers: { "content-type": "application/json", ...(authenticated ? { authorization: "Bearer engine-key" } : {}) }, body: JSON.stringify(body) });
  try {
    expect((await service.handler(request("/v1/capture/preview", { url: "https://example.com" }, false))).status).toBe(401);
    expect(await (await service.handler(request("/v1/capture/preview", { url: "https://example.com" }))).json()).toEqual({ kind: "url", url: "https://example.com/" });
    const plan = composePlan([{ provider: "x", id: "1", canonicalUrl: "https://x.com/person/status/1", author: { handle: "person" }, text: "A paragraph.\n\nAnother paragraph.", media: [] }]);
    const response = await service.handler(request("/v1/capture/prepare", plan));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.payload.channel_ids).toBeUndefined();
    expect(result.payload.value).toBe(`arena-block text ${plan.hash}`);
    expect(result.update.content).toBe(plan.block.markdown);
  } finally { service.close(); }
});

test("native ingest exposes escaped OG cover and original-source redirect without account access", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arena-ingest-")); directories.push(directory);
  const service = createService({ host: "localhost", port: 8790, publicBaseUrl: "https://engine.example", stateDirectory: directory, mediaDirectory: join(directory, "media"), accessToken: "engine-key", arenaToken: "never-used" });
  try {
    const source = 'https://example.com/?a=1&b=</script><script>alert("x")</script>';
    const cover = "https://s3.amazonaws.com/arena_images-temp/cover.jpg";
    const title = 'An <image> & "title"';
    const response = await service.handler(new Request(`https://engine.example/ingest-native/${Buffer.from(JSON.stringify({ source, cover, title })).toString("base64url")}`));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const body = await response.text();
    expect(body).toContain('<meta property="og:image" content="https://s3.amazonaws.com/arena_images-temp/cover.jpg">');
    expect(body).toContain('An &lt;image&gt; &amp; &quot;title&quot;');
    expect(body).not.toContain('<script>alert(');
    expect(body).toContain('location.replace("https://example.com/?a=1&b=\\u003c/script>');
    expect(body).toContain('rel="canonical" href="https://example.com/?a=1&amp;b=&lt;/script&gt;');
  } finally { service.close(); }
});

test("native ingest rejects invalid source and cover URLs before rendering", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arena-ingest-")); directories.push(directory);
  const service = createService({ host: "localhost", port: 8790, publicBaseUrl: "https://engine.example", stateDirectory: directory, mediaDirectory: join(directory, "media"), accessToken: "engine-key", arenaToken: "never-used" });
  const valid = { source: "https://example.com/post", cover: "https://s3.amazonaws.com/arena_images-temp/cover.jpg", title: "Title" };
  const invalid = [
    { source: "" }, { source: "http://example.com" }, { source: "javascript:alert(1)" }, { source: "https://user:pass@example.com" },
    { source: "https://example.com/" + "x".repeat(8192) }, { title: "x".repeat(513) }, { cover: "not a URL" },
    { cover: "https://s3.amazonaws.com.evil.test/arena_images-temp/cover.jpg" }, { cover: "https://s3.amazonaws.com:444/arena_images-temp/cover.jpg" },
    { cover: "https://user:pass@s3.amazonaws.com/arena_images-temp/cover.jpg" }, { cover: "https://s3.amazonaws.com/other/cover.jpg" },
    { cover: "https://s3.amazonaws.com/arena_images-temp/" }, { cover: "https://s3.amazonaws.com/arena_images-temp/../other/cover.jpg" },
    { cover: "https://s3.amazonaws.com/arena_images-temp/" + "x".repeat(2048) },
  ];
  try {
    for (const fields of invalid) {
      const response = await service.handler(new Request(`https://engine.example/ingest-native/${Buffer.from(JSON.stringify({ ...valid, ...fields })).toString("base64url")}`));
      expect(response.status).toBe(400);
      expect(await response.text()).toBe("Invalid capture link");
    }
  } finally { service.close(); }
});

test("opaque native ingest path avoids Are.na file-extension detection in URL queries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arena-ingest-")); directories.push(directory);
  const service = createService({ host: "localhost", port: 8790, publicBaseUrl: "https://engine.example", stateDirectory: directory, mediaDirectory: join(directory, "media"), accessToken: "engine-key", arenaToken: "never-used" });
  const content = { source: "https://x.com/jack/status/20", cover: "https://s3.amazonaws.com/arena_images-temp/cover.jpg", title: "A title. With punctuation." };
  try {
    const path = "/ingest-native/" + Buffer.from(JSON.stringify(content)).toString("base64url");
    expect(path).not.toContain(".");
    expect(path).not.toContain("?");
    const response = await service.handler(new Request("https://engine.example" + path));
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('content="https://s3.amazonaws.com/arena_images-temp/cover.jpg"');
    expect(html).toContain('location.replace("https://x.com/jack/status/20")');
    for (const token of ["bad%21", "a".repeat(16385), Buffer.from("null").toString("base64url"), Buffer.from('{"source":42,"cover":"x"}').toString("base64url")]) {
      expect((await service.handler(new Request("https://engine.example/ingest-native/" + token))).status).toBe(400);
    }
  } finally { service.close(); }
});
