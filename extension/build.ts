import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createPublicKey } from "node:crypto";
import { extensionIcons, generateIcons } from "../scripts/generate-icons.ts";

const root = join(import.meta.dir, "..");
const output = join(import.meta.dir, "dist");
const chromePublicKey = process.env.ARENA_BLOCK_CHROME_PUBLIC_KEY?.trim();
const substackTabReading = process.env.ARENA_BLOCK_SUBSTACK_TAB_READING ?? "true";
if (!["true", "false"].includes(substackTabReading))
  throw new Error("ARENA_BLOCK_SUBSTACK_TAB_READING must be true or false");
if (chromePublicKey && (
  chromePublicKey.length % 4 !== 0 ||
  !/^[A-Za-z0-9+/]+={0,2}$/.test(chromePublicKey) ||
  Buffer.from(chromePublicKey, "base64").toString("base64") !== chromePublicKey
)) throw new Error("ARENA_BLOCK_CHROME_PUBLIC_KEY must be a single-line base64 public key");
if (chromePublicKey) {
  try {
    createPublicKey({ key: Buffer.from(chromePublicKey, "base64"), format: "der", type: "spki" });
  } catch {
    throw new Error("ARENA_BLOCK_CHROME_PUBLIC_KEY must contain a DER public key, not private signing material");
  }
}
const shared = {
  name: "Arena Block",
  description: "Compose and save sources to Are.na",
  version: "0.1.0",
  manifest_version: 3,
  icons: extensionIcons,
  action: { default_title: "Capture to Are.na", default_popup: "editor.html", default_icon: extensionIcons },
  permissions: ["activeTab", "storage", "identity"],
  optional_permissions: ["nativeMessaging", ...(substackTabReading === "true" ? ["scripting"] : [])],
  optional_host_permissions: ["https://*/*"],
};

await generateIcons(root);
await rm(output, { recursive: true, force: true });
for (const browser of ["chrome", "firefox"] as const) {
  const directory = join(output, browser);
  await mkdir(directory, { recursive: true });
  await cp(join(root, "assets/extension"), join(directory, "icons"), { recursive: true });
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "src/editor.ts"), join(import.meta.dir, "src/background.ts")],
    outdir: directory,
    target: "browser",
    format: "iife",
    minify: false,
    plugins: [{ name: "browser-hash", setup(build) {
      build.onResolve({ filter: /^node:crypto$/ }, () => ({ path: join(import.meta.dir, "src/sha256-node.ts") }));
    } }],
  });
  if (!result.success) throw new Error(result.logs.join("\n"));
  await cp(join(import.meta.dir, "src/editor.html"), join(directory, "editor.html"));
  await cp(join(import.meta.dir, "src/editor.css"), join(directory, "editor.css"));
  await writeFile(join(directory, "oauth-client.json"), JSON.stringify({ clientId: process.env.ARENA_BLOCK_OAUTH_CLIENT_ID ?? "" }) + "\n");
  const manifest = {
    ...shared,
    ...(browser === "chrome" && chromePublicKey ? { key: chromePublicKey } : {}),
    background: browser === "chrome"
      ? { service_worker: "background.js" }
      : { scripts: ["background.js"] },
    ...(browser === "firefox" ? { browser_specific_settings: { gecko: { id: "arena-block@fjpaz.net", strict_min_version: "130.0" } } } : {}),
  };
  await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
}
console.log(`Built Chrome and Firefox extensions in ${output}`);
