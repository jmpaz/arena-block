import { ArenaBlockClient } from "./client.ts";
import { loadUserConfig } from "./config.ts";
import { createPickerApp } from "./picker-server.ts";

/** Start a private local presentation for the existing owner daemon. */
export async function startPicker(environment = process.env) {
  const token = environment.ARENA_BLOCK_ACCESS_TOKEN;
  if (!token) throw new Error("ARENA_BLOCK_ACCESS_TOKEN is required for the desktop picker");
  const endpoint = environment.ARENA_BLOCK_ENDPOINT ?? "http://127.0.0.1:8790";
  const config = await loadUserConfig(undefined, environment);
  const daemon = new ArenaBlockClient(endpoint, token);
  await daemon.assertSaveProfile(config, "cli");
  const portText = environment.ARENA_BLOCK_PICKER_PORT ?? "8791";
  if (!/^[1-9][0-9]{0,4}$/.test(portText) || Number(portText) > 65535) throw new Error("Invalid picker port");
  const app = createPickerApp(config, daemon);
  const server = Bun.serve({ hostname: "127.0.0.1", port: Number(portText), idleTimeout: 180,
    maxRequestBodySize: 4 * 1024 * 1024, fetch: app.handler });
  const address = `http://127.0.0.1:${server.port}/#session=${app.secret}`;
  process.stdout.write(`Open this private local picker URL:\n${address}\n`);
  return server;
}

if (import.meta.main) startPicker().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
