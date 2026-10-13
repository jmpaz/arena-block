import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createService } from "../src/service.ts";
import { buildInfo, buildInfoSchema } from "../src/version.ts";

test("reports the serving build through an authenticated endpoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arena-version-"));
  const service = createService({
    host: "127.0.0.1", port: 0, publicBaseUrl: "http://localhost", stateDirectory: directory,
    mediaDirectory: join(directory, "media"), accessToken: "client-token", arenaToken: "unused",
  });
  try {
    expect((await service.handler(new Request("http://localhost/v1/version"))).status).toBe(401);
    const response = await service.handler(new Request("http://localhost/v1/version", {
      headers: { authorization: "Bearer client-token" },
    }));
    expect(response.status).toBe(200);
    expect(buildInfoSchema.parse(await response.json())).toEqual(buildInfo());
  } finally {
    service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI version reports a build identity without daemon credentials", () => {
  const result = Bun.spawnSync(["bun", "run", "src/cli.ts", "version"], { env: { ...process.env, ARENA_BLOCK_ACCESS_TOKEN: "" } });
  expect(result.exitCode).toBe(0);
  expect(buildInfoSchema.parse(JSON.parse(result.stdout.toString()).client)).toEqual(buildInfo());
});
