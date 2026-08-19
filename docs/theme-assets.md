# Theme asset provenance

This log records the source and transformation history of assets bundled in
`public/themes/{theme-id}/`. It is release evidence, not a statement that the
theme has passed storefront, accessibility, performance, or human review.

## Studio `0.1.0`

- **Created:** 2026-08-05
- **Source:** generated with the built-in OpenAI ImageGen tool; no third-party
  photograph, logo, branded product, or proprietary theme reference was used.
- **Art direction:** warm bone, near-black, cobalt and restrained terracotta;
  contemporary independent home-design shop; photorealistic editorial product
  photography; text-free and logo-free.
- **Human inspection:** all three source outputs were checked for invented text,
  watermarks, duplicated products and crop suitability before processing.

### Source prompts

1. **Hero/editorial room:** a gallery-like architectural interior containing a
   cobalt lounge chair, ivory boucle ottoman, terracotta lamp, hand-thrown
   vessels and a slim black side table; soft directional morning light; 4:3
   landscape; no people, text, logos, branded products, borders or gradients.
2. **Product sheet A:** an exact 2×2 studio contact sheet containing one cobalt
   lounge chair, terracotta table lamp, pair of ivory sculptural bookends and
   speckled stoneware vase; warm bone seamless backdrops and clear centre
   gutters; no people, text, labels, logos, props or duplicated objects.
3. **Product sheet B:** an exact 2×2 studio contact sheet containing one
   near-black side table, cobalt-and-ivory wool throw, framed geometric art
   print and terracotta serving bowl; the same lighting, backdrop, gutters and
   exclusion constraints as sheet A.

### Derived files

| Files                                                                  | Transformation                                                                 |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `hero.webp`                                                            | Hero source resized/cropped to 1440×1080, WebP quality 82                      |
| `preview.webp`                                                         | Hero source resized/cropped to 1200×900, WebP quality 76                       |
| `chair.webp`, `lamp.webp`, `bookends.webp`, `vase.webp`                | Cropped from product sheet A by quadrant, resized to 1000×750, WebP quality 80 |
| `side-table.webp`, `throw.webp`, `art-print.webp`, `serving-bowl.webp` | Cropped from product sheet B by quadrant, resized to 1000×750, WebP quality 80 |

All derived files are under 500 KiB; `preview.webp` is under the catalog limit
of 250 KiB. Source PNGs remain in the local ImageGen output store and are not
runtime dependencies.

## Ritual `0.1.0`

- **Created:** 2026-08-05
- **Source:** generated with the built-in OpenAI ImageGen tool; no third-party
  photograph, logo, branded product, or proprietary theme reference was used.
- **Art direction:** dusty rose, deep plum, amber, cream and botanical green;
  sensorial botanical beauty photography; completely blank packaging.
- **Human inspection:** all three source outputs were checked for invented text,
  watermarks, duplicated packaging and crop suitability before processing.

### Source prompts

1. **Hero/bathroom ritual:** an intimate modern washroom still life containing
   blank amber and ceramic care vessels, a plum stone tray, linen, botanical
   branch and candle; warm dawn light; 4:3 landscape with left-side copy space;
   no people, hands, text, labels, logos, branded packaging or gradients.
2. **Product sheet A:** an exact 2×2 contact sheet containing one blank amber
   cleanser pump, plum serum dropper, cream moisturizer jar and amber body-oil
   bottle; dusty-rose seamless backdrops and clear centre gutters.
3. **Product sheet B:** an exact 2×2 contact sheet containing one plum ceramic
   candle, pale-green massage stone, blank cream bath-soak pouch and smoked-glass
   botanical scent bottle; matching backdrop, lighting and exclusion constraints.

### Derived files

| Files                                                                 | Transformation                                                                 |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `hero.webp`                                                           | Hero source resized/cropped to 1440×1080, WebP quality 82                      |
| `preview.webp`                                                        | Hero source resized/cropped to 1200×900, WebP quality 76                       |
| `cleanser.webp`, `serum.webp`, `moisturizer.webp`, `body-oil.webp`    | Cropped from product sheet A by quadrant, resized to 1000×750, WebP quality 80 |
| `candle.webp`, `massage-stone.webp`, `bath-soak.webp`, `perfume.webp` | Cropped from product sheet B by quadrant, resized to 1000×750, WebP quality 80 |

All derived files are under 500 KiB; `preview.webp` is under the catalog limit
of 250 KiB. Source PNGs remain in the local ImageGen output store and are not
runtime dependencies.

## Vitrine `0.1.0`

- **Created:** 2026-08-19
- **Status:** assets built and bundled; the preset is registered in
  `THEME_DEFINITIONS` and `THEME_META` but held at `visibility: "hidden"` /
  `release.status: "draft"` until `demo-vitrine` is seeded and the scored design
  pass is done. This log is release evidence, not a statement that the theme has
  passed storefront, accessibility, performance or human review.
- **Source:** generated with an image-generation tool from the prompts below; no
  third-party photograph, logo, branded product or proprietary theme reference
  was used. ⚠ Do **not** trace or reuse imagery from any live retailer's site.
- **Art direction:** monochrome warm-neutral — off-white `#fbfaf8`, pale grey
  product bed `#efebe6`, warm brown-black `#2a211f`; contemporary fashion
  e-commerce; square, evenly-lit studio product photography with soft contact
  shadows; one tan and one tortoiseshell as the only chromatic notes; text-free
  and logo-free.
- **Human inspection:** all three sources were checked before processing for
  invented branding, watermarks, mismatched left/right shoes and duplicated
  products, and every derived file was checked afterwards for correct
  quadrant-to-filename mapping. All clean.
- ⚠ **Source resolution:** the contact sheets were 1254×1254, so each quadrant
  is 627px and the 1000×1000 product crops are upscaled ~1.6×. Not visible at
  the sizes the storefront renders (cards ~280–308px, so ~616px at 2× DPI), but
  regenerate the sheets at 2048px or above if the product pages ever need
  genuinely larger art.

### Source prompts

1. **Hero/editorial still life:** a pale editorial flat-lay of women's and men's
   leather footwear and two structured handbags arranged on a warm off-white
   surface with soft directional light; 4:3 landscape; no people, text, logos,
   branded products, borders or gradients.
2. **Product sheet A (footwear):** an exact 2×2 studio contact sheet containing
   one white leather low-top sneaker, one brown penny loafer, one black suede
   block-heel sandal and one black leather ankle boot; each a single shoe shown
   side-on; pale grey seamless backdrops with clear centre gutters; no people,
   text, labels, logos, props or duplicated objects.
3. **Product sheet B (bags & accessories):** an exact 2×2 studio contact sheet
   containing one structured tan leather tote, one black quilted crossbody with
   a chain strap, one reversible black-and-tan leather belt coiled flat and one
   pair of angular tortoiseshell sunglasses; the same backdrop, lighting,
   gutters and exclusion constraints as sheet A.

### Derived files

| Files                                                         | Transformation                                                                  |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `hero.webp`                                                   | Hero source resized/cropped to 1440×1080, WebP quality 82                       |
| `preview.webp`                                                | Hero source resized/cropped to 1200×900, WebP quality 76                        |
| `sneaker.webp`, `loafer.webp`, `heel.webp`, `boot.webp`       | Cropped from product sheet A by quadrant, resized to 1000×1000, WebP quality 80 |
| `tote.webp`, `crossbody.webp`, `belt.webp`, `sunglasses.webp` | Cropped from product sheet B by quadrant, resized to 1000×1000, WebP quality 80 |

Product crops are **square (1000×1000)** rather than 4:3 here, because Vitrine
renders product cards at a 1:1 ratio; a 4:3 source would be centre-cropped by
the card and lose the toe or the heel. `preview.webp` must stay 4:3 — the
catalog test asserts that ratio to a 0.01 tolerance and a 250 KiB ceiling.

### Building the derived files

`scripts/build-theme-assets.mjs` does every transformation in the table above —
quadrant crops in reading order, resize, WebP encode — and steps quality down
until each file fits its cap, so a heavier-than-expected source degrades rather
than failing. Save the three generated sources anywhere, then:

```bash
node scripts/build-theme-assets.mjs --theme vitrine \
  --hero ~/art/vitrine-hero.png \
  --sheet-a ~/art/vitrine-sheet-a.png \
  --sheet-b ~/art/vitrine-sheet-b.png
```

Add `--dry-run` to see the numbers without writing, or `--out <dir>` to write
somewhere other than `public/themes/vitrine/`. It exits non-zero and prints
`FAIL` against any file still outside the constraints, so it can gate a commit.

⚠ **Quadrant order is reading order** — top-left, top-right, bottom-left,
bottom-right — matching the order each prompt lists its products in. If a
generated sheet comes back with the products arranged differently, re-generate
rather than renaming the outputs: the filenames are referenced by
`lib/themes/definitions/vitrine.ts` and a silent mismatch produces a catalogue
where every product shows the wrong photograph.
