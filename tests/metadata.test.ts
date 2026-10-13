import { describe, expect, test } from "bun:test";
import { ArenaClient } from "../src/arena.ts";
import { formatArenaBlockMetadata, readArenaBlockMetadata } from "../src/metadata.ts";
import { parseArenaBlockUrl } from "../src/url.ts";

class ReadClient extends ArenaClient {
  lookups: string[] = [];

  constructor(private readonly records: {
    channels?: Record<string, unknown>[];
    connections?: Record<number, Record<string, unknown> | Error>;
  } = {}) {
    super("unused", "https://arena.test");
  }

  override async block(id: number): Promise<Record<string, unknown>> {
    return {
      id,
      type: "Link",
      title: "Saved source\u001b[31m",
      visibility: "private",
      source: { url: "https://example.test/source" },
      user: { id: 8, name: "Example\u001b[31m", slug: "example-user" },
      metadata: { arena_block_version: 2 },
      created_at: "2026-10-06T12:00:00Z",
    };
  }

  override async connectionChannels(): Promise<Record<string, unknown>[]> {
    return this.records.channels ?? [];
  }

  override async channelPlacement(channel: number): Promise<Record<string, unknown> | undefined> {
    this.lookups.push(String(channel));
    const id = channel === 9002 ? 41 : channel === 9001 ? 42 : undefined;
    return id === undefined ? undefined : { connection: { id } };
  }

  override async connection(id: number): Promise<Record<string, unknown>> {
    const value = this.records.connections?.[id] ?? {};
    if (value instanceof Error) throw value;
    return value;
  }
}

describe("Are.na block metadata read", () => {
  test("channel connection discovery consumes complete cursor pages and rejects missing pagination evidence", async () => {
    const pages: number[] = [];
    const fixture = (invalid: boolean) => new ArenaClient("fixture", "https://arena.test", async (input) => {
      const url = new URL(String(input));
      const page = Number(url.searchParams.get("page"));
      pages.push(page);
      return Response.json({ data: [{ id: page, title: `Channel ${page}` }],
        meta: { current_page: invalid && page === 2 ? 1 : page, total_pages: 2,
          has_more_pages: page === 1, next_page: page === 1 ? 2 : null } });
    });
    expect((await fixture(false).connectionChannels(99)).map(row => row.id)).toEqual([1, 2]);
    expect(pages).toEqual([1, 2]);
    await expect(fixture(true).connectionChannels(99)).rejects.toThrow("pagination evidence");
  });

  test("accepts canonical Are.na block URLs and rejects ambiguous references", () => {
    expect(parseArenaBlockUrl("https://www.are.na/block/9003")).toBe(9003);
    expect(parseArenaBlockUrl("https://are.na/block/9003/")).toBe(9003);
    expect(() => parseArenaBlockUrl("https://are.na/example-user/inbox")).toThrow("block URL");
    expect(() => parseArenaBlockUrl("https://www.are.na/block/9003?foo=bar")).toThrow("without query or fragment");
    expect(() => parseArenaBlockUrl("http://www.are.na/block/9003")).toThrow("HTTPS");
  });

  test("returns block metadata separately from every same-named channel placement", async () => {
    const client = new ReadClient({
      channels: [
        { id: 9002, title: "Inbox\nInjected", slug: "example-user/inbox-fixture" },
        { id: 9001, title: "Inbox", slug: "example-user/remote-inbox" },
      ],
      connections: {
        41: {
          id: 41,
          position: 4622,
          pinned: false,
          connected_at: "2026-10-06T20:50:32Z",
          connected_by: { id: 8, name: "Example\u001b[31m", slug: "example-user" },
          metadata: { ab_schema: 2, ac_schema: 3, note: "# saved\n![remote](https://example.test/image.png)\n<img src=\"https://example.test/image.png\">" },
        },
        // An older connection can exist without a metadata field.
        42: { id: 42, position: 8, connected_at: "2025-01-01T00:00:00Z" },
      },
    });

    const result = await readArenaBlockMetadata(client, "https://www.are.na/block/9003");

    expect(client.lookups).toEqual(["9002", "9001"]);
    expect(result.block.metadata).toEqual({ state: "present", value: { arena_block_version: 2 } });
    expect(result.placements.map((placement) => placement.channel.id)).toEqual([9002, 9001]);
    expect(result.placements[0]?.connection?.metadata).toEqual({
      state: "present",
      value: { ab_schema: 2, ac_schema: 3, note: "# saved\n![remote](https://example.test/image.png)\n<img src=\"https://example.test/image.png\">" },
    });
    expect(result.placements[0]?.connection?.connectedBy?.name).toBe("Example\u001b[31m");
    expect(result.placements[0]?.connection?.position).toBe(4622);
    expect(result.placements[1]?.connection?.metadata).toEqual({ state: "missing" });
    expect(result.completeness).toBe("complete");

    const human = formatArenaBlockMetadata(result);
    expect(human).toContain("Block metadata (");
    expect(human).toContain("Connection metadata (3 fields)");
    expect(human).toContain("channel 9002");
    expect(human).toContain("channel 9001");
    expect(human).toContain('`"# saved\\n![remote]');
    expect(human).toContain("<img src=");
    expect(human).toContain("Connected by: `\"Example\\u001b[31m\"`");
    expect(human).toContain("Saved source\\u001b[31m");
    expect(human).toContain("Inbox\\nInjected");
    expect(human).not.toContain("\u001b");
    expect(human).toContain("Connection metadata: not returned");
  }, 15_000);

  test("keeps a placement in a partial result when its connection is inaccessible", async () => {
    const client = new ReadClient({
      channels: [{ id: 9002, title: "Inbox", slug: "example-user/inbox" }],
      connections: { 41: new Error("Are.na GET /connections/41 returned 403: private response detail") },
    });
    const result = await readArenaBlockMetadata(client, "https://www.are.na/block/51123813");
    expect(result.completeness).toBe("partial");
    expect(result.placements).toHaveLength(1);
    expect(result.placements[0]).toMatchObject({
      channel: { id: 9002, title: "Inbox" },
      connectionId: 41,
      readState: "connection_detail_unavailable",
      error: { kind: "api", status: 403 },
    });
    expect(JSON.stringify(result)).not.toContain("private response detail");
  });

  test("marks a missing connection reference instead of dropping the channel", async () => {
    const client = new ReadClient({ channels: [{ title: "Inbox", slug: "example-user/inbox" }] });
    const result = await readArenaBlockMetadata(client, "https://www.are.na/block/51123813");
    expect(result.completeness).toBe("partial");
    expect(result.placements).toEqual([
      { channel: { title: "Inbox", slug: "example-user/inbox" }, readState: "connection_reference_missing" },
    ]);
  });

  test("a connection detail identity mismatch remains partial instead of borrowing metadata", async () => {
    const client = new ReadClient({
      channels: [{ id: 9002, title: "Inbox" }],
      connections: { 41: { id: 42, metadata: { ab_schema: 2 } } },
    });
    const result = await readArenaBlockMetadata(client, "https://www.are.na/block/9003");
    expect(result.completeness).toBe("partial");
    expect(result.placements[0]).toEqual({ channel: { id: 9002, title: "Inbox" },
      connectionId: 41, readState: "connection_detail_unavailable" });
    expect(JSON.stringify(result)).not.toContain("ab_schema");
  });
});
