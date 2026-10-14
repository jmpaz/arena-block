import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import metadata from "../package.json";

export const buildInfoSchema = z.object({
  version: z.string(),
  revision: z.string().nullable(),
  sourceId: z.string(),
  platform: z.string(),
  schemaVersion: z.literal(1),
  packagePath: z.string().nullable(),
  planCapabilities: z.array(z.string()).max(32).optional(),
});

export function buildInfo(): z.infer<typeof buildInfoSchema> {
  const packaged = new URL("../build-info.json", import.meta.url);
  if (existsSync(packaged)) return buildInfoSchema.parse({
    ...JSON.parse(readFileSync(packaged, "utf8")),
    planCapabilities: ["atproto-post-records-v1", "delve-posts-v1", "bluesky-thread-coverage-v1", "forum-magnum-posts-v1", "expanded-source-count-32-v1"],
    packagePath: fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/, ""),
  });
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  const git = (args: string[]) => {
    if (!Bun.which("git")) return undefined;
    const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "ignore" });
    return result.exitCode === 0 ? result.stdout.toString().trim() : undefined;
  };
  const revision = git(["rev-parse", "HEAD"]) ?? null;
  const dirty = git(["status", "--porcelain"]) !== "";
  return {
    version: metadata.version,
    revision,
    sourceId: `checkout:${revision ?? "unknown"}${dirty ? ":dirty" : ""}`,
    platform: `${process.platform}-${process.arch}`,
    schemaVersion: 1,
    packagePath: null,
    planCapabilities: ["atproto-post-records-v1", "delve-posts-v1", "bluesky-thread-coverage-v1", "forum-magnum-posts-v1", "expanded-source-count-32-v1"],
  };
}
