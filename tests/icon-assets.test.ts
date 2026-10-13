import { expect, test } from "bun:test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { extensionIconSizes, generateIcons } from "../scripts/generate-icons.ts";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

test("committed icon assets reproduce from the shared vector source", async () => {
  await generateIcons(root, true);
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
    expect(pixel(760, 760)).toEqual(appearance === "light" ? [17, 17, 17, 255]
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
