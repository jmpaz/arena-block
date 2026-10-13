import { createCanvas, loadImage } from "@napi-rs/canvas";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

export const extensionIconSizes = [16, 32, 48, 64, 128] as const;
export const extensionIcons = Object.fromEntries(extensionIconSizes.map(size => [size, `icons/icon-${size}.png`]));

type Appearance = "light" | "dark" | "tinted" | "extension" | "tab";

function pngChunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type), data]);
  const chunk = Buffer.alloc(body.length + 8);
  chunk.writeUInt32BE(data.length, 0);
  body.copy(chunk, 4);
  chunk.writeUInt32BE(Bun.hash.crc32(body), chunk.length - 4);
  return chunk;
}

function encodeOpaquePNG(pixels: Uint8ClampedArray, size: number, grayscale: boolean): Buffer {
  const channels = grayscale ? 1 : 3;
  const stride = size * channels + 1;
  const rows = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const source = (y * size + x) * 4;
      const target = y * stride + 1 + x * channels;
      if (pixels[source + 3] !== 255) throw new Error("Opaque icon contains transparency");
      rows[target] = pixels[source]!;
      if (!grayscale) {
        rows[target + 1] = pixels[source + 1]!;
        rows[target + 2] = pixels[source + 2]!;
      }
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = grayscale ? 0 : 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("sRGB", Buffer.from([0])),
    pngChunk("IDAT", deflateSync(rows, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export async function renderIcon(svg: string, size: number, appearance: Appearance): Promise<Buffer> {
  const canvas = createCanvas(size, size);
  const context = canvas.getContext("2d");
  if (appearance === "light" || appearance === "tinted") {
    context.fillStyle = appearance === "tinted" ? "#000000" : "#FFFFFF";
    context.fillRect(0, 0, size, size);
  } else if (appearance === "extension") {
    context.fillStyle = "#FFFFFF";
    context.beginPath();
    context.roundRect(0, 0, size, size, size / 8);
    context.fill();
  }
  const rasterSize = appearance === "tab" ? 512 : size;
  let scaled = svg.replace('width="100" height="100"', `width="${rasterSize}" height="${rasterSize}"`);
  if (appearance !== "extension" && appearance !== "tab") {
    scaled = scaled.replace('<g color=', '<g transform="translate(8 8) scale(.84)" color=');
  }
  if (appearance === "dark" || appearance === "tinted") {
    scaled = scaled.replace('color="#111111"', `color="${appearance === "dark" ? "#E6E6E6" : "#FFFFFF"}"`);
  }
  const image = await loadImage(Buffer.from(scaled));
  if (image.width !== rasterSize || image.height !== rasterSize) throw new Error("Mark must use a 100 by 100 SVG canvas");
  if (appearance === "tab") {
    const sample = createCanvas(rasterSize, rasterSize).getContext("2d");
    sample.drawImage(image, 0, 0);
    const pixels = sample.getImageData(0, 0, rasterSize, rasterSize).data;
    let left = rasterSize, top = rasterSize, right = -1, bottom = -1;
    for (let y = 0; y < rasterSize; y++) {
      for (let x = 0; x < rasterSize; x++) {
        if (pixels[(y * rasterSize + x) * 4 + 3] === 0) continue;
        left = Math.min(left, x); right = Math.max(right, x);
        top = Math.min(top, y); bottom = Math.max(bottom, y);
      }
    }
    if (right < left) throw new Error("Tab mark is empty");
    const width = right - left + 1, height = bottom - top + 1;
    const scale = size * (22 / 24) / Math.max(width, height);
    context.drawImage(image, left, top, width, height,
      (size - width * scale) / 2, (size - height * scale) / 2, width * scale, height * scale);
  } else { context.drawImage(image, 0, 0); }
  return appearance === "light" || appearance === "tinted"
    ? encodeOpaquePNG(context.getImageData(0, 0, size, size).data, size, appearance === "tinted")
    : canvas.encodeSync("png");
}

export async function iconFiles(root: string): Promise<Map<string, Buffer>> {
  const svg = await readFile(join(root, "assets/mark.svg"), "utf8");
  const files = new Map<string, Buffer>();
  for (const size of extensionIconSizes) {
    files.set(`assets/extension/icon-${size}.png`, await renderIcon(svg, size, "extension"));
  }
  const catalog = "ios/App/Assets.xcassets";
  const appIcon = `${catalog}/AppIcon.appiconset`;
  const json = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + "\n");
  const info = { author: "xcode", version: 1 };
  files.set(`${catalog}/Contents.json`, json({ info }));
  files.set(`${appIcon}/Contents.json`, json({
    images: ["light", "dark", "tinted"].map(appearance => ({
      filename: `icon-${appearance}.png`, idiom: "universal", platform: "ios", size: "1024x1024",
      ...(appearance === "light" ? {} : { appearances: [{ appearance: "luminosity", value: appearance }] }),
    })), info,
  }));
  for (const appearance of ["light", "dark", "tinted"] as const) {
    files.set(`${appIcon}/icon-${appearance}.png`, await renderIcon(svg, 1024, appearance));
  }
  const tabCatalog = "ios/Sources/CaptureUI/Resources/Assets.xcassets";
  const tabImage = `${tabCatalog}/CaptureTab.imageset`;
  files.set(`${tabCatalog}/Contents.json`, json({ info }));
  files.set(`${tabImage}/Contents.json`, json({
    images: [1, 2, 3].map(scale => ({ filename: `capture-tab-${scale}x.png`, idiom: "universal", scale: `${scale}x` })),
    info, properties: { "template-rendering-intent": "template" },
  }));
  for (const scale of [1, 2, 3]) {
    files.set(`${tabImage}/capture-tab-${scale}x.png`, await renderIcon(svg, 24 * scale, "tab"));
  }
  return files;
}

export async function generateIcons(root: string, check = false): Promise<void> {
  for (const [path, bytes] of await iconFiles(root)) {
    const target = join(root, path);
    if (check) {
      let existing: Buffer | undefined;
      try { existing = await readFile(target); } catch {}
      if (!existing?.equals(bytes)) throw new Error(`Regenerate icon asset: ${path}`);
    } else {
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, bytes);
    }
  }
}

if (import.meta.main) {
  const check = process.argv.includes("--check");
  await generateIcons(join(import.meta.dir, ".."), check);
  console.log(check ? "Icon assets match the shared SVG" : "Generated icon assets from the shared SVG");
}
