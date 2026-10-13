import { expect, test } from "bun:test";
import { createMcpSession } from "../src/mcp.ts";
import { userConfigSchema } from "../src/config.ts";
import { composePlan } from "../src/compose.ts";

const config = userConfigSchema.parse({ remoteInbox: { channel: "90001" }, credentialProfiles: { shared: { arenaTokenEnv: "ARENA_WRITE_ACCESS_TOKEN" }, assistant: { arenaTokenEnv: "ARENA_ASSISTANT_TOKEN", expectedAccountId: 700 } }, clients: { mcpLocal: "assistant", mcpRemote: "assistant" } });
const plan = composePlan([{ provider: "x", id: "1", canonicalUrl: "https://x.com/example/status/1", author: { handle: "example" }, text: "Complete original", media: [] }]);
async function session(origin: "mcp-local" | "mcp-remote" = "mcp-local") {
  const dispatch = createMcpSession(config, origin);
  const init = await dispatch({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "fixture", version: "1" } } });
  await dispatch({ jsonrpc: "2.0", method: "notifications/initialized" });
  return { dispatch, init };
}
test("initialization, discovery and preparation expose no publication capability", async () => {
  const { dispatch, init } = await session();
  expect((init?.result as any).protocolVersion).toBe("2025-11-25");
  const listed = await dispatch({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  expect((listed?.result as any).tools.map((t: any) => t.name)).toEqual(["arena_block_preview_save", "arena_block_policy"]);
  expect(JSON.stringify(listed)).not.toContain("arena_block_publish");
  expect((listed?.result as any).tools.every((t: any) => t.annotations.readOnlyHint)).toBe(true);
});
test("MCP initiator and transport stay distinct from configured, unverified account identity", async () => {
  const { dispatch } = await session();
  const response = await dispatch({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "arena_block_preview_save", arguments: { plan, agent: { label: "declared assistant", workflowId: "capture:test" } } } });
  const result = (response?.result as any).structuredContent;
  expect(result.snapshot.origin).toBe("mcp-local");
  expect(result.snapshot.initiator).toMatchObject({ kind: "agent", identityBasis: "declared", label: "declared assistant" });
  expect(result.snapshot.authentication).toEqual({ credentialProfile: "assistant", expectedAccountId: 700, authenticatedAccountVerified: false });
  expect(result.snapshot.routing.destinations).toEqual(["90001"]);
  expect(JSON.stringify(response)).not.toContain("ARENA_ASSISTANT_TOKEN");
  expect(JSON.parse((response?.result as any).content[0].text)).toEqual(result);
});
test("trusted transport configuration selects remote origin; user arguments cannot impersonate CLI", async () => {
  const { dispatch } = await session("mcp-remote");
  const call = (args: unknown) => dispatch({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "arena_block_preview_save", arguments: args } });
  expect((((await call({ plan }))?.result as any).structuredContent).snapshot.origin).toBe("mcp-remote");
  expect(((await call({ plan, origin: "cli" }))?.result as any).isError).toBe(true);
  expect(((await call({ plan, agent: { kind: "human" } }))?.result as any).isError).toBe(true);
  expect(((await call({ plan, token: "private-value" }))?.result as any).content[0].text).not.toContain("private-value");
});
test("unknown methods/tools, malformed calls and premature requests yield protocol errors", async () => {
  const dispatch = createMcpSession(config);
  expect(((await dispatch({ jsonrpc: "2.0", id: 1, method: "tools/list" }))?.error as any).code).toBe(-32000);
  expect(((await dispatch([]))?.error as any).code).toBe(-32600);
  const ready = (await session()).dispatch;
  expect(((await ready({ jsonrpc: "2.0", id: 2, method: "publish" }))?.error as any).code).toBe(-32601);
  expect(((await ready({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "arena_block_publish" } }))?.error as any).code).toBe(-32602);
});
test("ordinary clients may attach MCP request metadata without changing save identity", async () => {
  const { dispatch } = await session();
  const response = await dispatch({ jsonrpc: "2.0", id: 7, method: "tools/call", params: {
    name: "arena_block_preview_save", arguments: { plan },
    _meta: { progressToken: 3, threadId: "client-thread", origin: "cli", credentialProfile: "shared", label: "untrusted metadata" },
  } });
  const snapshot = (response?.result as any).structuredContent.snapshot;
  expect(snapshot.origin).toBe("mcp-local");
  expect(snapshot.authentication.credentialProfile).toBe("assistant");
  expect(snapshot.client.name).toBe("fixture");
  expect(snapshot.initiator.label).not.toBe("untrusted metadata");
  expect(JSON.stringify(snapshot)).not.toContain("client-thread");
  const call = (metadata: unknown) => dispatch({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "arena_block_policy", arguments: {}, _meta: metadata } });
  expect(((await call({ progressToken: "progress-8" }))?.result as any).isError).toBe(false);
  expect(((await call("not an object"))?.error as any).code).toBe(-32602);
  expect(((await call(null))?.error as any).code).toBe(-32602);
});
test("preparation failure is an MCP tool error without source content or credentials in its message", async () => {
  const { dispatch } = await session(); const edited = structuredClone(plan); edited.block.title = "private content";
  const response = await dispatch({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "arena_block_preview_save", arguments: { plan: edited } } });
  expect((response?.result as any).isError).toBe(true);
  expect(JSON.stringify(response)).not.toContain("private content");
});

test("metadata read joins the existing MCP catalog without changing publication policy", async () => {
  const url = "https://www.are.na/block/9003";
  const calls: string[] = [];
  const metadata = { schemaVersion: 1 as const,
    block: { id: 9003, url, title: "Saved source", metadata: { state: "empty" as const, value: {} } },
    placements: [{ channel: { id: 9002, title: "Inbox" }, readState: "complete" as const,
      connectionId: 41, connection: { id: 41, metadata: { state: "present" as const, value: { ab_schema: 2 } } } }],
    completeness: "complete" as const };
  const dispatch = createMcpSession(config, "mcp-local", { metadataReader: { blockMetadata: async (blockUrl) => { calls.push(blockUrl); return metadata; } } });
  await dispatch({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "fixture", version: "1" } } });
  await dispatch({ jsonrpc: "2.0", method: "notifications/initialized" });
  const listed = await dispatch({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  expect((listed?.result as any).tools.map((tool: any) => tool.name)).toEqual(["arena_block_preview_save", "arena_block_policy", "read_arena_block_metadata"]);
  const response = await dispatch({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "read_arena_block_metadata", arguments: { block_url: url } } });
  expect(calls).toEqual([url]);
  expect((response?.result as any).structuredContent).toEqual(metadata);
  expect((response?.result as any).content[0].text).toStartWith('`"Saved source"`');
  expect((response?.result as any).content[0].text).toContain('`"Inbox"` (channel 9002)');
  expect(((await dispatch({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "read_arena_block_metadata", arguments: { block_url: url, origin: "cli" } } }))?.result as any).isError).toBe(true);
  expect(calls).toHaveLength(1);
});
