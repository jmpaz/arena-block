import { readFileSync } from "node:fs";
import { z } from "zod";
import { channelRecordSchema } from "../channel-index.ts";
import { ChannelRanker } from "./rank.ts";

export const snapshotSchema = z.object({
  accountId: z.number().int().positive(),
  channels: z.array(channelRecordSchema.extend({ updatedAt: z.string().nullable().optional(), children: z.array(z.number().int()).optional() })).max(3000),
  me: z.string().optional(),
  recents: z.array(z.number().int()).default([]),
  block: z.object({ title: z.string(), source: z.string(), kind: z.string(), blockId: z.number().int().positive().optional(),
    url: z.string().optional(), connectedTo: z.array(z.number().int()).default([]) }).optional(),
  updatedAt: z.string().default(""),
  completeAt: z.string().nullable().default(null),
}).passthrough();
export type Snapshot = z.infer<typeof snapshotSchema>;

export function readSnapshot(path: string): Snapshot {
  return snapshotSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

export type SnapshotDaemon = { endpoint: string; token: string; refused: string[]; stop(): void };

/**
 * Serves a saved channel snapshot over the read routes of the arena-block daemon protocol.
 * Every write route answers 405, and the refused requests are kept so a caller can show them.
 */
export function startSnapshotDaemon(snapshot: Snapshot, token = crypto.randomUUID()): SnapshotDaemon {
  const refused: string[] = [];
  const ranker = new ChannelRanker(snapshot.channels);
  const json = (value: unknown, status = 200) => Response.json(value, { status });
  const all = snapshot.channels.map(({ updatedAt: _, children: __, ...channel }) => channel);
  const mine = (c: { owner: { name: string } }) => snapshot.me === undefined || c.owner.name === snapshot.me;
  const records = all.filter(mine);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (request.headers.get("authorization") !== `Bearer ${token}`) return json({ error: "Unauthorized" }, 401);
      if (request.method !== "GET") {
        refused.push(`${request.method} ${url.pathname}`);
        return json({ error: "This snapshot daemon is read-only" }, 405);
      }
      if (url.pathname === "/v1/version") return json({ version: "snapshot", sourceId: "snapshot", planCapabilities: [] });
      if (url.pathname === "/v1/channel-index") {
        return json({ accountId: snapshot.accountId, channels: records, updatedAt: snapshot.updatedAt, completeAt: snapshot.completeAt });
      }
      if (url.pathname === "/v1/channels") {
        const page = Number(url.searchParams.get("page") ?? "1");
        const slice = records.slice((page - 1) * 30, page * 30);
        return json({ accountId: snapshot.accountId, channels: slice, nextPage: page * 30 < records.length ? page + 1 : null });
      }
      if (url.pathname === "/v1/channel-nesting") {
        const parents = Object.fromEntries(snapshot.channels.filter(c => c.children?.length).map(c => [String(c.id), c.children!]));
        return json({ accountId: snapshot.accountId, parents, channels: all.filter(c => !mine(c)) });
      }
      if (url.pathname === "/v1/channel-search") {
        const query = url.searchParams.get("query") ?? "";
        const found = ranker.rank(query).map(m => all.find(r => r.id === m.channel.id)!);
        return json({ accountId: snapshot.accountId, channels: found.slice(0, 30), nextPage: null });
      }
      const existing = url.pathname.match(/^\/v1\/existing-blocks\/(\d+)$/);
      if (existing && snapshot.block?.blockId === Number(existing[1])) {
        return json({ blockId: snapshot.block.blockId, blockUrl: `https://www.are.na/block/${snapshot.block.blockId}`,
          title: snapshot.block.title, type: snapshot.block.kind, state: "available" });
      }
      return json({ error: "Not found" }, 404);
    },
  });
  return { endpoint: `http://127.0.0.1:${server.port}`, token, refused, stop: () => server.stop(true) };
}
