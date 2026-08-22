#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Build a theme's bundled imagery from authored source art.
//
// Themes ship ONE hero and two 2x2 product contact sheets (see
// docs/theme-assets.md for the prompts). This turns those three files into the
// ten WebP assets under public/themes/{id}/ that lib/themes/themes.test.ts
// asserts on: correct format, >= 800px wide, <= 500 KiB, and a preview that is
// 4:3 to a 0.01 tolerance, >= 600px tall and <= 250 KiB.
//
// It exists because those constraints are easy to miss by hand and the failure
// is a red CI on someone else's branch. Quality is stepped DOWN automatically
// until a file fits its cap, so a heavier-than-expected source degrades rather
// than failing the build.
//
// Usage:
//   node scripts/build-theme-assets.mjs --theme vitrine \
//     --hero ~/art/hero.png --sheet-a ~/art/sheet-a.png --sheet-b ~/art/sheet-b.png
//   node scripts/build-theme-assets.mjs --theme vitrine ... --dry-run
// ---------------------------------------------------------------------------
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import sharp from "sharp";

// Tolerate a closed stdout (`… | head`), which otherwise throws EPIPE from the
// first console.log after the reader exits and buries the real output.
process.stdout.on("error", (e) => {
  if (e.code === "EPIPE") process.exit(0);
  throw e;
});

// Quadrant order is READING order: top-left, top-right, bottom-left,
// bottom-right — the order the source prompts list the products in.
const QUADRANTS = ["tl", "tr", "bl", "br"];

const THEMES = {
  vitrine: {
    // Products are SQUARE here, not the 4:3 Studio/Ritual use: Vitrine renders
    // cards at 1:1, so a 4:3 source would be centre-cropped through the toe.
    product: { width: 1000, height: 1000, quality: 80 },
    hero: { width: 1440, height: 1080, quality: 82 },
    preview: { width: 1200, height: 900, quality: 76, maxBytes: 250 * 1024 },
    sheetA: ["sneaker", "loafer", "heel", "boot"],
    sheetB: ["tote", "crossbody", "belt", "sunglasses"],
  },
};

const MAX_BYTES = 500 * 1024;
const MIN_WIDTH = 800;

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

/** Encode, stepping quality down until it fits the cap. Returns the buffer. */
async function encode(pipeline, { quality, maxBytes }) {
  let q = quality;
  for (;;) {
    const buf = await pipeline.clone().webp({ quality: q }).toBuffer();
    if (buf.length <= maxBytes || q <= 40) return { buf, quality: q };
    q -= 6;
  }
}

async function emit(out, name, pipeline, spec, dryRun) {
  const cap = spec.maxBytes ?? MAX_BYTES;
  const { buf, quality } = await encode(pipeline, {
    quality: spec.quality,
    maxBytes: cap,
  });
  const meta = await sharp(buf).metadata();
  const kib = (buf.length / 1024).toFixed(1);
  const problems = [];
  if (meta.width < MIN_WIDTH)
    problems.push(`width ${meta.width} < ${MIN_WIDTH}`);
  if (buf.length > cap)
    problems.push(`${kib} KiB > ${(cap / 1024).toFixed(0)} KiB`);
  if (!dryRun) await writeFile(join(out, `${name}.webp`), buf);
  const status = problems.length ? `FAIL (${problems.join("; ")})` : "ok";
  console.log(
    `  ${name.padEnd(12)} ${String(meta.width).padStart(4)}x${String(meta.height).padEnd(4)} ` +
      `q${quality} ${kib.padStart(7)} KiB  ${status}`,
  );
  return problems.length === 0;
}

async function quadrant(src, which) {
  const { width, height } = await sharp(src).metadata();
  const w = Math.floor(width / 2);
  const h = Math.floor(height / 2);
  const left = which === "tr" || which === "br" ? width - w : 0;
  const top = which === "bl" || which === "br" ? height - h : 0;
  return sharp(src).extract({ left, top, width: w, height: h });
}

async function main() {
  const themeId = arg("theme");
  const cfg = THEMES[themeId];
  if (!cfg) {
    console.error(
      `Unknown --theme "${themeId}". Known: ${Object.keys(THEMES).join(", ")}`,
    );
    process.exit(1);
  }
  const hero = arg("hero");
  const sheetA = arg("sheet-a");
  const sheetB = arg("sheet-b");
  const dryRun = flag("dry-run");
  for (const [label, p] of [
    ["--hero", hero],
    ["--sheet-a", sheetA],
    ["--sheet-b", sheetB],
  ]) {
    if (!p) {
      console.error(`Missing ${label}`);
      process.exit(1);
    }
    if (!existsSync(resolve(p))) {
      console.error(`No such file: ${p}`);
      process.exit(1);
    }
  }

  const out = arg("out", join(process.cwd(), "public", "themes", themeId));
  if (!dryRun) await mkdir(out, { recursive: true });
  console.log(
    `\n${themeId} → ${dryRun ? "(dry run, nothing written)" : out}\n`,
  );

  const fit = (spec) => ({
    width: spec.width,
    height: spec.height,
    fit: "cover",
    position: "attention",
  });
  let ok = true;

  ok =
    (await emit(
      out,
      "hero",
      sharp(resolve(hero)).resize(fit(cfg.hero)),
      cfg.hero,
      dryRun,
    )) && ok;
  ok =
    (await emit(
      out,
      "preview",
      sharp(resolve(hero)).resize(fit(cfg.preview)),
      cfg.preview,
      dryRun,
    )) && ok;

  for (const [sheet, names] of [
    [sheetA, cfg.sheetA],
    [sheetB, cfg.sheetB],
  ]) {
    for (let i = 0; i < names.length; i++) {
      const q = await quadrant(resolve(sheet), QUADRANTS[i]);
      ok =
        (await emit(
          out,
          names[i],
          q.resize(fit(cfg.product)),
          cfg.product,
          dryRun,
        )) && ok;
    }
  }

  // The preview ratio is asserted to a 0.01 tolerance; check it here rather
  // than discovering it in CI.
  const ratio = cfg.preview.width / cfg.preview.height;
  if (Math.abs(ratio - 4 / 3) > 0.01) {
    console.log(
      `\n  preview aspect ${ratio.toFixed(3)} is not 4:3 — themes.test.ts will fail`,
    );
    ok = false;
  }

  console.log(
    ok
      ? `\nAll assets within constraints.${dryRun ? " (dry run)" : ""}\n`
      : `\nSome assets are OUT of constraints — see FAIL above.\n`,
  );
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
