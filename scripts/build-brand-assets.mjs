// Deterministic exports of the owner's artwork; never redraw the logo.
// Run: node scripts/build-brand-assets.mjs
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = new URL("../", import.meta.url);
const source = new URL("brand/assets/storemink-master.png", root);
const output = new URL("public/brand/20260908/", root);
await mkdir(output, { recursive: true });

// Use alpha bounds, not a colour threshold: the white shop detail is artwork.
const { data, info } = await sharp(await readFile(source))
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });
let left = info.width,
  top = info.height,
  right = -1,
  bottom = -1;
for (let y = 0; y < info.height; y++) {
  for (let x = 0; x < info.width; x++) {
    if (data[(y * info.width + x) * 4 + 3] > 0) {
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
}
if (right < left) throw new Error("The master logo is empty");
const cropped = await sharp(data, { raw: info })
  .extract({ left, top, width: right - left + 1, height: bottom - top + 1 })
  .png()
  .toBuffer();

async function square(size, padding, background = "#00000000") {
  const inner = size - padding * 2;
  const mark = await sharp(cropped)
    .resize(inner, inner, { fit: "contain", background: "#00000000" })
    .png()
    .toBuffer();
  return sharp({
    create: { width: size, height: size, channels: 4, background },
  })
    .composite([{ input: mark, left: padding, top: padding }])
    .png({ compressionLevel: 9, effort: 10 })
    .toBuffer();
}

const logo = await square(512, 12);
const webp = await sharp(await square(256, 6))
  .webp({ lossless: true, effort: 6 })
  .toBuffer();
await writeFile(new URL("storemink-mark.png", output), logo);
await writeFile(new URL("storemink-mark.webp", output), webp);
// Keep previously published URLs working with the new artwork too.
await writeFile(new URL("public/brand/storemink-mark.png", root), logo);
await writeFile(new URL("public/brand/storemink-mark.webp", root), webp);

const icons = [];
for (const size of [16, 32, 48]) {
  // Edge-to-edge at 16px, one-pixel padding at 32/48px: fill the tab without
  // clipping. Direct master-to-target sampling keeps the small detail crisp.
  const png = await square(size, size === 16 ? 0 : 1);
  icons.push({ size, png });
  await writeFile(new URL(`favicon-${size}.png`, output), png);
}
// ICO directory followed by PNG-compressed images (16 / 32 / 48 px).
const directory = Buffer.alloc(6 + 16 * icons.length);
directory.writeUInt16LE(1, 2);
directory.writeUInt16LE(icons.length, 4);
let offset = directory.length;
icons.forEach(({ size, png }, index) => {
  const entry = 6 + index * 16;
  directory[entry] = size;
  directory[entry + 1] = size;
  directory.writeUInt16LE(1, entry + 4);
  directory.writeUInt16LE(32, entry + 6);
  directory.writeUInt32LE(png.length, entry + 8);
  directory.writeUInt32LE(offset, entry + 12);
  offset += png.length;
});
await writeFile(
  new URL("public/favicon.ico", root),
  Buffer.concat([directory, ...icons.map(({ png }) => png)]),
);
await writeFile(new URL("app/icon.png", root), icons[2].png);
// iOS applies its own rounded mask; provide an opaque white canvas and enough
// safe space for the bag's lower corners instead of baking in rounded edges.
const apple = await square(180, 14, "#ffffff");
await writeFile(new URL("app/apple-icon.png", root), apple);
await writeFile(new URL("apple-touch-icon.png", output), apple);
await writeFile(
  new URL("public/icon.svg", root),
  `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><image width="512" height="512" href="data:image/png;base64,${logo.toString("base64")}"/></svg>\n`,
);
console.log(
  `Generated brand assets from ${fileURLToPath(source)} (alpha bounds ${right - left + 1}×${bottom - top + 1}).`,
);
