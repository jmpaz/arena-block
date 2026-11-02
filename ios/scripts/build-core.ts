import { join } from "node:path";
const root = join(import.meta.dir, "../..");
const result = await Bun.build({
  entrypoints: [join(root, "packages/core/native-entry.ts")],
  outdir: join(root, "ios/Sources/CaptureRuntime/Resources"),
  naming: "capture-core.js",
  target: "browser",
  format: "iife",
  minify: true,
  plugins: [{ name: "native-platform", setup(build) {
    build.onResolve({ filter: /^node:crypto$/ }, args => ({ path: args.path, namespace: "native-hash" }));
    build.onLoad({ filter: /.*/, namespace: "native-hash" }, () => ({
      contents: `export function createHash(algorithm) { if (algorithm !== 'sha256') throw new Error('Unsupported hash'); let value=''; return {update(text){value+=text;return this},digest(format){if(format!=='hex')throw new Error('Unsupported encoding');return globalThis.nativeSHA256(value)}} }`,
      loader: "js",
    }));
    build.onResolve({ filter: /^@mixmark-io\/domino$/ }, () => ({ path: join(root, "node_modules/@mixmark-io/domino/lib/index.js") }));
    build.onResolve({ filter: /^turndown$/ }, () => ({ path: join(root, "node_modules/turndown/lib/turndown.cjs.js"), namespace: "native-turndown" }));
    build.onLoad({ filter: /.*/, namespace: "native-turndown" }, async args => ({ contents: await Bun.file(args.path).text(), loader: "js", resolveDir: join(root, "node_modules/turndown/lib") }));
  } }],
});
if (!result.success) throw new Error(result.logs.join("\n"));
console.log(`Bundled shared capture core (${result.outputs[0]!.size} bytes)`);

const redditReader = await Bun.build({
  entrypoints: [join(root, "ios/scripts/reddit-preprocessor.ts")],
  outdir: join(root, "ios/ShareExtension"), naming: "RedditPreprocessor.js",
  target: "browser", format: "iife", minify: false,
});
if (!redditReader.success) throw new Error(redditReader.logs.join("\n"));
