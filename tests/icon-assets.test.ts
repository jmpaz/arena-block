import { expect, test } from "bun:test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { extensionIconSizes, generateIcons, matchingIconPixels } from "../scripts/generate-icons.ts";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

test("committed icon assets reproduce from the shared vector source", async () => {
  await generateIcons(root, true);
});

test("native icon comparison allows bounded rounding and rejects changed artwork", () => {
  const pixels = (...values: number[]) => new Uint8ClampedArray(values);
  expect(matchingIconPixels(pixels(17, 17, 17, 255), pixels(19, 19, 19, 255))).toBe(true);
  expect(matchingIconPixels(pixels(230, 230, 230, 128), pixels(231, 231, 231, 129))).toBe(true);
  expect(matchingIconPixels(pixels(255, 0, 0, 0), pixels(0, 255, 255, 0))).toBe(true);
  expect(matchingIconPixels(pixels(17, 17, 17, 255), pixels(20, 20, 20, 255))).toBe(false);
  expect(matchingIconPixels(pixels(17, 17, 17, 255), pixels(17, 17, 17, 253))).toBe(false);
  expect(matchingIconPixels(pixels(0, 0, 0, 255, 0, 0, 0, 0), pixels(0, 0, 0, 0, 0, 0, 0, 255))).toBe(false);
  expect(matchingIconPixels(pixels(0, 0, 0, 255), pixels(0, 0, 0, 255, 0, 0, 0, 0))).toBe(false);
});

test("iOS inputs preserve the mark and provide valid appearance pixels", async () => {
  const catalog = join(root, "ios/App/Assets.xcassets/AppIcon.appiconset");
  const contents = await Bun.file(join(catalog, "Contents.json")).json();
  expect(contents.images.map((image: { appearances?: { value: string }[] }) => image.appearances?.[0]?.value ?? "light"))
    .toEqual(["light", "dark", "tinted"]);
  for (const appearance of ["light", "dark", "tinted"]) {
    const bytes = Buffer.from(await Bun.file(join(catalog, `icon-${appearance}.png`)).arrayBuffer());
    expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(bytes[25]).toBe(appearance === "light" ? 2 : appearance === "dark" ? 6 : 0);
    const image = await loadImage(bytes);
    expect([image.width, image.height]).toEqual([1024, 1024]);
    const context = createCanvas(1024, 1024).getContext("2d");
    context.drawImage(image, 0, 0);
    const pixel = (x: number, y: number) => [...context.getImageData(x, y, 1, 1).data];
    expect(pixel(710, 670)).toEqual(appearance === "light" ? [17, 17, 17, 255]
      : appearance === "dark" ? [230, 230, 230, 255] : [255, 255, 255, 255]);
    expect(pixel(102, 102)).toEqual(appearance === "light" ? [255, 255, 255, 255]
      : appearance === "dark" ? [0, 0, 0, 0] : [0, 0, 0, 255]);
    expect(pixel(890, 760)).toEqual(appearance === "light" ? [255, 255, 255, 255]
      : appearance === "dark" ? [0, 0, 0, 0] : [0, 0, 0, 255]);
  }
});

test("browser PNGs provide exact dimensions and a white backing", async () => {
  for (const size of extensionIconSizes) {
    const image = await loadImage(join(root, `assets/extension/icon-${size}.png`));
    expect([image.width, image.height]).toEqual([size, size]);
    const context = createCanvas(size, size).getContext("2d");
    context.drawImage(image, 0, 0);
    expect([...context.getImageData(Math.floor(size / 2), 0, 1, 1).data]).toEqual([255, 255, 255, 255]);
    expect([...context.getImageData(0, 0, 1, 1).data][3]).toBeLessThan(255);
  }
});

test("Capture tab assets provide a transparent template at each display scale", async () => {
  const path = join(root, "ios/Sources/CaptureUI/Resources/Assets.xcassets/CaptureTab.imageset");
  const catalog = await Bun.file(join(path, "Contents.json")).json();
  expect(catalog.properties["template-rendering-intent"]).toBe("template");
  for (const scale of [1, 2, 3]) {
    const size = 24 * scale;
    const image = await loadImage(join(path, `capture-tab-${scale}x.png`));
    expect([image.width, image.height]).toEqual([size, size]);
    const context = createCanvas(size, size).getContext("2d");
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, size, size).data;
    expect([...context.getImageData(0, 0, 1, 1).data][3]).toBe(0);
    expect([...context.getImageData(size - 1, size - 1, 1, 1).data][3]).toBe(0);
    const rows = Array.from({ length: size }, (_, y) =>
      Array.from({ length: size }, (_, x) => pixels[(y * size + x) * 4 + 3]!).some(alpha => alpha > 127));
    const columns = Array.from({ length: size }, (_, x) =>
      Array.from({ length: size }, (_, y) => pixels[(y * size + x) * 4 + 3]!).some(alpha => alpha > 127));
    const inkDimensions = [rows.filter(Boolean).length, columns.filter(Boolean).length];
    expect(Math.max(...inkDimensions)).toBeGreaterThanOrEqual(20 * scale);
    expect(Math.max(...inkDimensions)).toBeLessThanOrEqual(22 * scale);
    expect(Math.min(...inkDimensions)).toBeGreaterThanOrEqual(16 * scale);
  }
});
