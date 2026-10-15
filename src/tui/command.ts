import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ArenaBlockClient } from "../client.ts";
import { parseArenaBlockUrl } from "../url.ts";
import { readSnapshot, startFixtureDaemon, type FixtureDaemon } from "./fixture-daemon.ts";
import type { HeldBlock, Mode } from "./model.ts";
import { runPicker, type Emit } from "./picker.ts";

export type PickOptions = {
  emit?: Emit;
  copy?: boolean;
  block?: string;
  fixture?: string;
  height?: string;
  mode?: Mode;
  preview?: string;
};

function recentsPath(environment = process.env): string {
  return join(environment.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "arena-block", "tui-recents.json");
}

function readRecents(accountId: number): number[] {
  const path = recentsPath();
  if (!existsSync(path)) return [];
  const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, number[]>;
  return value[String(accountId)] ?? [];
}

/** Enters the picker from the CLI and returns the exit code; the chosen destinations go to stdout. */
export async function pickCommand(options: PickOptions): Promise<number> {
  let daemon: FixtureDaemon | undefined;
  let client: ArenaBlockClient;
  let block: HeldBlock | undefined;
  let recents: number[] = [];
  let me: string | undefined;
  if (options.fixture) {
    const snapshot = readSnapshot(options.fixture);
    daemon = startFixtureDaemon(snapshot);
    client = new ArenaBlockClient(daemon.endpoint, daemon.token);
    block = snapshot.held;
    recents = snapshot.recents;
    me = snapshot.me;
  } else {
    const token = process.env.ARENA_BLOCK_ACCESS_TOKEN;
    if (!token) throw new Error("ARENA_BLOCK_ACCESS_TOKEN is required, or pass --fixture <snapshot.json>");
    client = new ArenaBlockClient(process.env.ARENA_BLOCK_ENDPOINT ?? "http://127.0.0.1:8790", token);
    const index = await client.channelIndex();
    recents = readRecents(index.accountId);
    if (options.block) {
      const preview = await client.existingBlock(parseArenaBlockUrl(options.block));
      block = { title: preview.title, source: "are.na", kind: preview.type, blockId: preview.blockId, url: preview.blockUrl, alreadyIn: [] };
    }
  }
  try {
    const result = await runPicker({
      client, block, recents, me, emit: options.emit, copy: options.copy, mode: options.mode,
      height: options.height ? Number(options.height) : undefined,
      previewWidth: options.preview === "off" ? 0 : options.preview ? Number(options.preview) : undefined,
    });
    if (result.emitted) process.stdout.write(result.emitted);
    return result.accepted ? 0 : 1;
  } finally {
    daemon?.stop();
  }
}
