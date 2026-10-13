import { expect } from "bun:test";
import { mergedMetadata, type Metadata } from "../../src/connection-metadata.ts";

export class MockApi {
  calls: Array<{ method: string; path: string; body?: any }> = [];
  blocks = new Map<number, Record<string, any>>();
  rows: Array<{ channel: number; block: number; connection: { id: number; metadata: Metadata; connected_by: { id: number } | null } }> = [];
  privateChannels = new Set([901]);
  ownerId?: number;
  account = 47; visibility = "private"; writable = true; complete = true; inboxComplete = true; blockConnectionsComplete = true;
  loseCreate = false; loseConnect = false; loseUpdate = false; omitInbox = false; failProcessing = false; transientRead = false;
  cancelCreate?: AbortController;
  channelMetadata: Metadata = {};
  placementPage = new Map<number, number>();
  onBlockConnectionRead?: () => void;
  failContentsFor?: number;
  channelId(target: string) { return target === "active" ? 902 : target === "later" ? 903 : Number(target); }
  creates() { return this.calls.filter(call => call.method === "POST" && call.path === "/blocks").length; }
  connects() { return this.calls.filter(call => call.method === "POST" && call.path === "/connections").length; }
  puts() { return this.calls.filter(call => call.method === "PUT" && call.path.startsWith("/connections/")).length; }
  add(block: number, channel: number, metadata: Metadata = {}) {
    const connection = { id: this.rows.length + 700, metadata: structuredClone(metadata), connected_by: { id: this.account } };
    this.rows.push({ channel, block, connection }); return connection;
  }
  fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    expect(init?.redirect).toBe("error");
    const url = new URL(String(input)), path = url.pathname.replace(/^\/v3/, ""), method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    this.calls.push({ method, path, body });
    const reply = (data: any) => Response.json({ data });
    if (path === "/me") return reply({ id: this.account });
    if (path === "/channels" && method === "POST") { this.channelMetadata = body.metadata; return reply({ id: 901, visibility: "private", owner: { id: this.account, type: "User" } }); }
    const channel = path.match(/^\/channels\/([^/]+)$/);
    if (channel) { const channelId = this.channelId(channel[1]!); return reply({ id: channelId, title: "arena-block test", slug: "arena-block-test", metadata: this.channelMetadata, counts: { collaborators: 0, blocks: this.rows.length }, visibility: this.privateChannels.has(channelId) ? this.visibility : "public", owner: { id: this.ownerId ?? this.account, type: "User", slug: "fixture_account" }, can: { add_to: this.writable } }); }
    const contents = path.match(/^\/channels\/([^/]+)\/contents$/);
    if (contents) {
      const page = Number(url.searchParams.get("page"));
      const channelId = this.channelId(contents[1]!);
      if (channelId === this.failContentsFor) return Response.json({ error: "Fixture channel lookup failure" }, { status: 400 });
      const complete = this.complete && (channelId !== 901 || this.inboxComplete);
      const placementPage = this.placementPage.get(channelId) ?? 1;
      const totalPages = complete ? placementPage : Math.max(4, placementPage);
      return Response.json({ data: page === placementPage ? this.rows.filter(row => row.channel === channelId).map(row => ({ id: row.block, type: "Text", connection: row.connection })) : [],
        meta: { current_page: page, total_pages: totalPages, has_more_pages: !complete || page < totalPages, next_page: !complete || page < totalPages ? page + 1 : null } });
    }
    if (method === "POST" && path === "/blocks") {
      const blockId = this.blocks.size + 10000;
      this.blocks.set(blockId, { id: blockId, type: "Text", state: "available", visibility: "private", user: { id: this.account }, title: body.title, content: { markdown: body.value }, description: body.description ? { markdown: body.description } : null });
      for (const target of body.channels ?? body.channel_ids?.map((id: number) => ({ id })) ?? []) if (!(this.omitInbox && target.id === 901)) this.add(blockId, target.id, target.metadata);
      if (this.cancelCreate) { this.cancelCreate.abort(new Error("Fixture cancellation")); throw new Error("Fixture cancellation"); }
      if (this.loseCreate) { this.loseCreate = false; throw new Error("Create response lost"); }
      return reply({ id: blockId, state: "processing" });
    }
    const block = path.match(/^\/blocks\/(\d+)$/);
    if (block) {
      if (this.transientRead && method === "GET") { this.transientRead = false; return Response.json({ error: "Slow network fixture" }, { status: 503 }); }
      const value = this.blocks.get(Number(block[1]))!;
      if (method === "PUT") { value.title = body.title; value.content = { markdown: body.content }; value.description = body.description ? { markdown: body.description } : null; }
      return reply({ ...value, state: this.failProcessing ? "failed" : value.state });
    }
    const placements = path.match(/^\/blocks\/(\d+)\/connections$/);
    if (placements) {
      this.onBlockConnectionRead?.();
      const page = Number(url.searchParams.get("page") ?? 1);
      return Response.json({ data: page === 1 ? this.rows.filter(row => row.block === Number(placements[1])).map(row => ({ id: row.channel, slug: row.channel === 902 ? "active" : row.channel === 903 ? "later" : String(row.channel) })) : [],
        meta: { current_page: page, total_pages: this.blockConnectionsComplete ? 1 : 2, has_more_pages: !this.blockConnectionsComplete, next_page: this.blockConnectionsComplete ? null : page + 1 } });
    }
    if (method === "POST" && path === "/connections") {
      const connected = (body.channels ?? body.channel_ids?.map((id: number) => ({ id })) ?? []).map((target: any) => this.add(body.connectable_id, target.id, target.metadata));
      if (this.loseConnect) { this.loseConnect = false; throw new Error("Connect response lost"); }
      return reply(connected.reverse()); // Response order cannot identify channels.
    }
    const connection = path.match(/^\/connections\/(\d+)$/);
    if (connection) {
      const value = this.rows.find(row => row.connection.id === Number(connection[1]))!.connection;
      if (method === "PUT") {
        value.metadata = mergedMetadata(value.metadata, body.metadata);
        if (this.loseUpdate) { this.loseUpdate = false; throw new Error("Metadata response lost"); }
      }
      return reply(value); // Official resource has no connectable_id or channel_id.
    }
    throw new Error(`Unexpected fixture request: ${method} ${path}`);
  };
}
