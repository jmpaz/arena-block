import { describe, expect, test } from "bun:test";
import { ArenaClient } from "../src/arena.ts";
import { ArenaBlockClient } from "../src/client.ts";
import { createService } from "../src/service.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

class ReadOnlyArenaClient extends ArenaClient {
  reads = 0;

  constructor() {
    super("unused", "https://arena.test");
  }

  override async block(id: number): Promise<Record<string, unknown>> {
    this.reads += 1;
    return { id, type: "Text", title: "Stored block", metadata: { arena_block_plan: "abc123" } };
  }

  override async connectionChannels(): Promise<Record<string, unknown>[]> {
    this.reads += 1;
    return [{ id: 9002, title: "Inbox", slug: "example-user/inbox" }];
  }

  override async channelPlacement(): Promise<Record<string, unknown>> {
    this.reads += 1;
    return { connection: { id: 913 } };
  }

  override async connection(): Promise<Record<string, unknown>> {
    this.reads += 1;
    return {
      id: 913,
      position: 4622,
      connected_at: "2026-10-06T20:50:32Z",
      connected_by: { id: 8, name: "Example Pazmino" },
      metadata: { ab_schema: 2, ac_schema: 3 },
    };
  }
}

describe("authenticated metadata read endpoint", () => {
  test("round-trips the block URL through the CLI client and exposes no mutation path", async () => {
    const arena = new ReadOnlyArenaClient();
    const directory = await mkdtemp(join(tmpdir(), "arena-metadata-service-"));
    const service = createService({
      host: "127.0.0.1",
      port: 8790,
      publicBaseUrl: "https://blocks.example.test",
      stateDirectory: directory,
      mediaDirectory: directory,
      accessToken: "engine-token",
      arenaToken: "unused",
    }, { client: arena });
    try {
      const client = new ArenaBlockClient("https://blocks.example.test", "engine-token", async (input, init) =>
        service.handler(new Request(input, init)));
      const result = await client.blockMetadata("https://www.are.na/block/9003");
      expect(result.block).toMatchObject({
        id: 9003,
        title: "Stored block",
        metadata: { state: "present", value: { arena_block_plan: "abc123" } },
      });
      expect(result.placements[0]).toMatchObject({
        channel: { id: 9002, title: "Inbox" },
        connectionId: 913,
        connection: {
          connectedBy: { name: "Example Pazmino" },
          position: 4622,
          metadata: { state: "present", value: { ab_schema: 2, ac_schema: 3 } },
        },
      });
      expect(arena.reads).toBe(4);

      const unauthorized = await service.handler(new Request(
        "https://blocks.example.test/v1/blocks/9003/metadata",
      ));
      expect(unauthorized.status).toBe(401);
      await unauthorized.text();
      expect(arena.reads).toBe(4);
    } finally {
      await service.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
