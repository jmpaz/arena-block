import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArenaClient, ArenaPublisher, ArenaRequestError, type PublisherConfig } from "../src/arena.ts";
import { composePlan, planHash } from "../src/compose.ts";
import { ArenaBlockStore } from "../src/store.ts";
import type { ResolvedPost } from "../src/types.ts";
import { createCanvas } from "@napi-rs/canvas";

class FakeArenaClient extends ArenaClient {
  creates = 0;
  createPayload: Record<string, unknown> | undefined;
  updatePayload: Record<string, unknown> | undefined;
  description: string | null = "Hello";
  content = "Hello";
  removed: number[] = [];
  state = "available";
  type = "Text";
  destinations = ["block-share-test"];
  connectCalls: string[][] = [];
  channelIdentities = new Map<string, number>();

  constructor() {
    super("unused", "https://arena.invalid");
  }

  override async createBlock(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.creates += 1;
    this.createPayload = payload;
    return { id: 123, state: "processing" };
  }

  override async block(): Promise<Record<string, unknown>> {
    return {
      id: 123,
      state: this.state,
      type: this.type,
      title: "Post by @example",
      content: { markdown: this.content },
      description: this.description === null ? null : { markdown: this.description },
    };
  }

  override async updateBlock(_id: number, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.updatePayload = payload;
    return this.block();
  }

  override async channelIds(destinations: string[]): Promise<number[]> {
    return [...new Set(destinations.map(destination => {
      if (!this.channelIdentities.has(destination)) this.channelIdentities.set(destination, this.channelIdentities.size + 100);
      return this.channelIdentities.get(destination)!;
    }))];
  }

  override async connections(): Promise<Array<{ channelId: number; slug: string }>> {
    return this.destinations.map((slug, index) => ({ channelId: index + 10, slug }));
  }

  override async connectionId(_blockId: number, channel: string): Promise<number | undefined> {
    const index = this.destinations.indexOf(channel);
    return index < 0 ? undefined : index + 20;
  }

  override async connect(_blockId: number, destinations: string[]): Promise<number[]> {
    this.connectCalls.push(destinations);
    this.destinations.push(...destinations);
    return destinations.map((_, index) => index + 20);
  }

  override async removeConnection(id: number): Promise<void> {
    this.removed.push(id);
  }
}

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function plan() {
  const post: ResolvedPost = {
    provider: "x",
    id: "1",
    canonicalUrl: "https://x.com/example/status/1",
    author: { handle: "example" },
    text: "Hello",
    media: [],
  };
  return composePlan([post]);
}

function rehash(value: ReturnType<typeof plan>) {
  const { hash: _, ...snapshot } = value;
  value.hash = planHash(snapshot);
}

async function harness(options: Partial<PublisherConfig> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "arena-block-test-"));
  directories.push(directory);
  const client = new FakeArenaClient();
  const store = new ArenaBlockStore(join(directory, "store.sqlite"));
  const publisher = new ArenaPublisher(client, store, {
    publicBaseUrl: "https://blocks.example.test",
    mediaDirectory: join(directory, "media"),
    verifyTimeoutMs: 100,
    pollIntervalMs: 1,
    ...options,
  });
  return { client, store, publisher, directory };
}

describe("publishing", () => {
  test("accepts null for an empty description but still rejects lost description text", async () => {
    const { client, publisher } = await harness();
    const value = plan();
    value.block.description = "";
    rehash(value);
    client.description = null;
    await expect(publisher.publish({ plan: value, destinations: ["block-share-test"], force: false })).resolves.toMatchObject({ status: "verified" });
    value.block.description = "A caption";
    rehash(value);
    await expect(publisher.publish({ plan: value, destinations: ["block-share-test"], force: true })).rejects.toThrow("description does not match");
  });

  test("reconciles captionless video blocks whose description is null", async () => {
    const { client, store, publisher } = await harness();
    const value = plan();
    value.block.kind = "video";
    value.block.markdown = "";
    rehash(value);
    client.type = "Attachment";
    client.description = null;
    const now = new Date().toISOString();
    store.saveReceipt({
      id: "captionless", planHash: value.hash, blockId: 123,
      blockUrl: "https://www.are.na/block/123", destinations: ["block-share-test"],
      connectionIds: [], status: "publishing", createdAt: now, updatedAt: now,
    });
    await expect(publisher.publish({ plan: value, destinations: ["block-share-test"], force: false })).resolves.toMatchObject({ status: "verified" });
    expect(client.creates).toBe(0);
  });
  test("creates URL-only text as text, then restores its exact content", async () => {
    const { client, publisher } = await harness();
    const value = plan();
    value.block.markdown = "https://example.com/article";
    rehash(value);
    client.content = value.block.markdown;
    await publisher.publish({ plan: value, destinations: ["block-share-test"], force: false });
    expect(client.createPayload?.value).toBe(`arena-block text ${value.hash}`);
    expect(client.createPayload?.description).toBe(`arena-block description ${value.hash}`);
    expect(client.updatePayload?.content).toBe(value.block.markdown);
  });
  test("creates, updates, and verifies text descriptions separately from content", async () => {
    const { client, publisher } = await harness();
    const value = plan();
    value.block.description = "Posted at: 2024-01-01T00:00:00.000Z";
    rehash(value);
    client.description = value.block.description;
    await publisher.publish({ plan: value, destinations: ["block-share-test"], force: false });
    expect(client.createPayload?.description).toBe(`arena-block description ${value.hash}`);
    expect(client.createPayload?.value).toBe(`arena-block text ${value.hash}`);
    expect(client.createPayload?.original_source_url).toBe(value.block.canonicalSource);
    expect(client.updatePayload?.description).toBe(value.block.description);
    expect(client.updatePayload?.content).toBe("Hello");
  });

  test("fails verification when Are.na loses the text description", async () => {
    const { publisher } = await harness();
    const value = plan();
    value.block.description = "Posted at: 2024-01-01T00:00:00.000Z";
    rehash(value);
    await expect(publisher.publish({ plan: value, destinations: ["block-share-test"], force: false })).rejects.toThrow("description does not match");
  });

  test("reuses a verified block and connects only missing destinations", async () => {
    const { client, publisher } = await harness();
    const first = await publisher.publish({ plan: plan(), destinations: ["block-share-test"], force: false });
    const second = await publisher.publish({ plan: plan(), destinations: ["block-share-test", "another"], force: false });
    expect(first.blockId).toBe(123);
    expect(second.destinations).toEqual(["block-share-test", "another"]);
    expect(client.creates).toBe(1);
    expect(client.createPayload?.channel_ids).toEqual([100]);
    expect(client.createPayload?.channels).toBeUndefined();
  });

  test("keeps failed processing inspectable and resumes the known block", async () => {
    const { client, publisher, store } = await harness();
    client.state = "failed";
    await expect(publisher.publish({ plan: plan(), destinations: ["block-share-test"], force: false })).rejects.toThrow("processing failed");
    const failed = store.latestReceiptForPlan(plan().hash)!;
    expect(failed).toMatchObject({ status: "needs_attention", stage: "processing", blockId: 123 });
    expect(client.removed).toEqual([]);
    await expect(publisher.publish({ plan: plan(), destinations: ["block-share-test"], force: false })).rejects.toThrow("processing failed");
    client.state = "available";
    expect((await publisher.publish({ plan: plan(), destinations: ["block-share-test"], force: false })).id).toBe(failed.id);
    expect(client.creates).toBe(1);
  });

  test("keeps connections and media state when verification fails", async () => {
    const { client, publisher } = await harness();
    client.type = "Link";
    await expect(publisher.publish({ plan: plan(), destinations: ["block-share-test"], force: false })).rejects.toThrow("Expected Text block");
    expect(client.removed).toEqual([]);
    client.type = "Text";
    await publisher.publish({ plan: plan(), destinations: ["block-share-test"], force: false });
    expect(client.creates).toBe(1);
  });

  test("reconciles a valid connection after interrupted verification", async () => {
    const { client, store, publisher } = await harness();
    const value = plan();
    const now = new Date().toISOString();
    store.savePlan(value);
    store.saveReceipt({
      id: "interrupted",
      planHash: value.hash,
      blockId: 123,
      blockUrl: "https://www.are.na/block/123",
      destinations: ["block-share-test"],
      connectionIds: [],
      status: "rolled_back",
      createdAt: now,
      updatedAt: now,
      error: "verification parser failed",
    });

    const receipt = await publisher.publish({ plan: value, destinations: ["block-share-test"], force: false });

    expect(receipt.status).toBe("verified");
    expect(receipt.connectionIds).toEqual([20]);
    expect(client.creates).toBe(0);
  });
});

describe("Are.na v3 client", () => {
  test("a stalled network request times out and caller cancellation reaches fetch", async () => {
    const aborted: string[] = [];
    const client = new ArenaClient("unused", "https://arena.invalid", (_input, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => { aborted.push(init!.signal!.reason.name); reject(init!.signal!.reason); }, { once: true });
    }), 10);
    await expect(client.block(123)).rejects.toMatchObject({ name: "TimeoutError" });
    const controller = new AbortController();
    const read = client.block(123, controller.signal); controller.abort();
    await expect(read).rejects.toMatchObject({ name: "AbortError" });
    expect(aborted).toEqual(["TimeoutError", "AbortError"]);
  });
  test("resolves channel slugs before connecting blocks", async () => {
    const requests: Array<{ method: string; path: string; body?: unknown }> = [];
    const client = new ArenaClient("token", "https://arena.test", async (input, init) => {
      const request = {
        method: init?.method ?? "GET",
        path: new URL(String(input)).pathname,
        ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }),
      };
      requests.push(request);
      if (request.path === "/channels/first") return Response.json({ data: { id: 10 } });
      if (request.path === "/channels/second") return Response.json({ data: { id: 11 } });
      return Response.json({ data: [{ id: 42 }] });
    });

    expect(await client.connect(123, ["first", "second"])).toEqual([42]);
    expect(requests).toEqual([
      { method: "GET", path: "/channels/first" },
      { method: "GET", path: "/channels/second" },
      {
        method: "POST",
        path: "/connections",
        body: {
          connectable_id: 123,
          connectable_type: "Block",
          channel_ids: [10, 11],
        },
      },
    ]);
  });
});

describe("publication recovery", () => {
  const request = () => ({ plan: plan(), destinations: ["block-share-test"], force: false });

  test("an edit with an old hash cannot overwrite an approved snapshot", async () => {
    const { client, publisher, store } = await harness();
    const original = plan(); store.savePlan(original);
    const edited = structuredClone(original); edited.block.markdown = "Different writing";
    await expect(publisher.publish({ ...request(), plan: edited })).rejects.toThrow("hash does not match");
    expect(store.plan(original.hash)?.plan).toEqual(original);
    expect(client.creates).toBe(0);
  });

  test("resume addresses the chosen receipt even when a later force-created receipt exists", async () => {
    const { client, publisher, store } = await harness();
    client.state = "failed";
    await expect(publisher.publish(request())).rejects.toThrow("processing failed");
    const interrupted = store.latestReceiptForPlan(plan().hash)!;
    store.saveReceipt({ ...interrupted, id: "later-force-create", blockId: 124, status: "verified", stage: undefined, updatedAt: "2099-01-01T00:00:00.000Z" });
    client.state = "available";
    const resumed = await publisher.resume(interrupted.id, ["block-share-test"]);
    expect(resumed).toMatchObject({ id: interrupted.id, blockId: 123, status: "verified" });
    expect(store.receipt("later-force-create")?.blockId).toBe(124);
    expect(client.creates).toBe(1);
  });

  test("two service instances reserve only one block creation for the same snapshot", async () => {
    const { client, publisher, directory } = await harness();
    const secondStore = new ArenaBlockStore(join(directory, "store.sqlite"));
    const second = new ArenaPublisher(client, secondStore, { mediaDirectory: directory, publicBaseUrl: "https://blocks.test" });
    const create = client.createBlock.bind(client);
    client.createBlock = async payload => { await new Promise(resolve => setTimeout(resolve, 10)); return create(payload); };
    try {
      const results = await Promise.allSettled([publisher.publish(request()), second.publish(request())]);
      expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find(result => result.status === "rejected") as PromiseRejectedResult;
      expect(rejected.reason.attempt.status).toBe("creating");
      expect(client.creates).toBe(1);
    } finally { secondStore.close(); }
  });

  test("cancelling a processing wait persists new requested destinations", async () => {
    const { client, publisher, store } = await harness({ pollIntervalMs: 1000 });
    client.state = "processing";
    const controller = new AbortController();
    const pending = publisher.publish({ ...request(), destinations: ["first", "second"] }, controller.signal);
    setTimeout(() => controller.abort(new Error("Stopped waiting")), 10);
    await expect(pending).rejects.toThrow("Stopped waiting");
    expect(store.latestReceiptForPlan(plan().hash)).toMatchObject({ status: "needs_attention", pendingDestinations: ["first", "second"] });
    expect(client.creates).toBe(1);
  });

  test("concurrent duplicate requests retain both callers' destinations", async () => {
    const { client, publisher } = await harness();
    const [first, second] = await Promise.all([
      publisher.publish(request()), publisher.publish({ ...request(), destinations: ["another"] }),
    ]);
    expect(first.blockId).toBe(second.blockId);
    expect(client.creates).toBe(1);
    expect(second.destinations).toEqual(["block-share-test", "another"]);
    expect(second.connectionIds).toEqual([20, 21]);
  });

  test("a processing timeout survives a service restart without another create", async () => {
    const { client, publisher, store, directory } = await harness({ verifyTimeoutMs: 5 });
    client.state = "processing";
    await expect(publisher.publish(request())).rejects.toThrow("Timed out");
    const receipt = store.latestReceiptForPlan(plan().hash)!;
    store.close();
    const reopened = new ArenaBlockStore(join(directory, "store.sqlite"));
    const resumed = new ArenaPublisher(client, reopened, { mediaDirectory: directory, publicBaseUrl: "https://blocks.test" });
    client.state = "available";
    expect((await resumed.publish(request())).id).toBe(receipt.id);
    expect(client.creates).toBe(1);
    expect(client.removed).toEqual([]);
    reopened.close();
  });

  test.each([429, 503])("transient processing read %i retries without a write", async status => {
    const { client, publisher } = await harness();
    const read = client.block.bind(client);
    let reads = 0;
    client.block = async () => { if (++reads === 1) throw new ArenaRequestError("Temporary outage", status); return read(); };
    expect((await publisher.publish(request())).status).toBe("verified");
    expect(client.creates).toBe(1);
    expect(reads).toBeGreaterThan(1);
  });

  test("transient network errors recover, but revoked authorization is surfaced", async () => {
    const { client, publisher } = await harness();
    const read = client.block.bind(client);
    let first = true;
    client.block = async () => { if (first) { first = false; throw new TypeError("Network unavailable"); } return read(); };
    await publisher.publish(request());
    client.block = async () => { throw new ArenaRequestError("Forbidden", 403); };
    await expect(publisher.publish({ ...request(), force: true })).rejects.toThrow("Forbidden");
    expect(client.removed).toEqual([]);
  });

  test("cancel before create has no remote side effect", async () => {
    const { client, publisher, store } = await harness();
    const controller = new AbortController(); controller.abort(new Error("Cancelled"));
    await expect(publisher.publish(request(), controller.signal)).rejects.toThrow("Cancelled");
    expect(client.creates).toBe(0);
    expect(store.latestReceiptForPlan(plan().hash)).toBeUndefined();
  });

  test("cancel after accepted create retains its ID and can resume", async () => {
    const { client, publisher, store } = await harness();
    const controller = new AbortController();
    const create = client.createBlock.bind(client);
    client.createBlock = async payload => { const value = await create(payload); controller.abort(new Error("Cancelled")); return value; };
    await expect(publisher.publish(request(), controller.signal)).rejects.toThrow("Cancelled");
    expect(store.latestReceiptForPlan(plan().hash)).toMatchObject({ blockId: 123, status: "needs_attention" });
    await publisher.publish(request());
    expect(client.creates).toBe(1);
  });

  test("cancelling a queued duplicate does not cancel the first request", async () => {
    const { client, publisher } = await harness();
    const controller = new AbortController();
    const first = publisher.publish(request());
    const second = publisher.publish(request(), controller.signal);
    controller.abort(new Error("Cancelled"));
    expect((await first).status).toBe("verified");
    await expect(second).rejects.toThrow("Cancelled");
    expect(client.creates).toBe(1);
  });

  test("unknown create response is reserved durably and never automatically repeated", async () => {
    const { client, publisher, store, directory } = await harness();
    client.createBlock = async () => { client.creates++; throw new TypeError("Response lost after acceptance"); };
    await expect(publisher.publish(request())).rejects.toThrow("outcome is unknown");
    const attempt = store.unresolvedCreation(plan().hash)!;
    expect(attempt.status).toBe("creation_unknown");
    expect(attempt.destinations).toEqual(["block-share-test"]);
    store.close();
    const reopened = new ArenaBlockStore(join(directory, "store.sqlite"));
    const resumed = new ArenaPublisher(client, reopened, { mediaDirectory: directory, publicBaseUrl: "https://blocks.test" });
    await expect(resumed.publish(request())).rejects.toThrow("may already have reached");
    expect(client.creates).toBe(1);
    reopened.close();
  });

  test("a process lost after reserving a create cannot post again", async () => {
    const { client, publisher, store } = await harness();
    store.saveCreation({ id: "interrupted", planHash: plan().hash, destinations: ["block-share-test"], status: "creating", createdAt: new Date().toISOString() });
    await expect(publisher.publish(request())).rejects.toThrow("may already have reached");
    expect(client.creates).toBe(0);
  });

  test("partial connections are checked before retry and unrequested removals stay removed", async () => {
    const { client, publisher, store } = await harness();
    await publisher.publish(request());
    client.destinations = ["unrequested"];
    const connect = client.connect.bind(client);
    let first = true;
    client.connect = async (id, targets) => {
      if (first) { first = false; await connect(id, targets.slice(0, 1)); throw new TypeError("Response lost"); }
      return connect(id, targets);
    };
    const targets = ["another", "third"];
    await expect(publisher.publish({ ...request(), destinations: targets })).rejects.toThrow("Response lost");
    expect(store.receiptForPlan(plan().hash)?.pendingDestinations).toEqual(targets);
    const next = await publisher.publish({ ...request(), destinations: targets });
    expect(client.connectCalls).toEqual([["another"], ["third"]]);
    expect(next.destinations).toEqual(targets);
    expect(client.destinations).toEqual(["unrequested", "another", "third"]);
    expect(client.creates).toBe(1);
    expect(next.pendingDestinations).toBeUndefined();
  });

  test("render failure is safely retryable before any creation reservation", async () => {
    const { client, publisher, store } = await harness({ render: async () => { throw new Error("Second media item unavailable"); } });
    await expect(publisher.publish(request())).rejects.toThrow("Second media item");
    expect(client.creates).toBe(0);
    expect(store.unresolvedCreation(plan().hash)).toBeUndefined();
  });

  test("a missing selected attachment cannot silently publish the remaining image", async () => {
    const { client, publisher, store } = await harness();
    const value = composePlan([{ ...plan().sources[0]!, media: [{ ref: "1.1", kind: "image", url: "https://fixture.invalid/image.png", alt: "", width: 320, height: 320 }] }]);
    value.block.selectedMedia.push("1.2"); rehash(value);
    await expect(publisher.publish({ ...request(), plan: value })).rejects.toThrow("Selected media is missing");
    expect(client.creates).toBe(0);
    expect(store.unresolvedCreation(value.hash)).toBeUndefined();
  });

  test("a partially decodable image set fails before publication instead of dropping an item", async () => {
    const { client, publisher, store } = await harness();
    const canvas = createCanvas(320, 320);
    const png = (await canvas.encode("png")).toString("base64");
    const value = composePlan([{ ...plan().sources[0]!, media: [
      { ref: "1.1", kind: "image", url: `data:image/png;base64,${png}`, alt: "", width: 320, height: 320 },
      { ref: "1.2", kind: "image", url: "data:image/png;base64,aW52YWxpZA==", alt: "", width: 320, height: 320 },
    ] }], { media: "all" });
    await expect(publisher.publish({ ...request(), plan: value })).rejects.toThrow();
    expect(client.creates).toBe(0);
    expect(store.unresolvedCreation(value.hash)).toBeUndefined();
  });

  test("a rendered artifact remains available after verification and a subsequent failed save", async () => {
    let artifact = "";
    const { client, publisher } = await harness({ render: async (_plan, directory) => {
      artifact = join(directory, "shared.mp4"); await Bun.write(artifact, "fixture bytes");
      return { hash: "a".repeat(64), path: artifact, extension: "mp4", mimeType: "video/mp4", size: 13 };
    } });
    const value = plan(); value.block.kind = "video"; value.block.markdown = ""; rehash(value);
    client.type = "Attachment"; client.description = null;
    const saved = await publisher.publish({ plan: value, destinations: ["block-share-test"], force: false });
    expect(saved.mediaArtifact).toMatchObject({ mimeType: "video/mp4", size: 13, url: `https://blocks.example.test/media/${"a".repeat(64)}.mp4` });
    expect(await Bun.file(artifact).exists()).toBe(true);
    client.state = "failed";
    await expect(publisher.publish({ plan: value, destinations: ["block-share-test"], force: true })).rejects.toThrow("processing failed");
    expect(await Bun.file(artifact).text()).toBe("fixture bytes");
  });
});
