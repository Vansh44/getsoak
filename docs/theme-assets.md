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
