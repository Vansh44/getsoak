# Vertical Store Templates — Implementation Plan

> **Current expansion phase:** **Quality Phases 1–2 and Capability Phase 3
> DONE; Phase 4 IN PROGRESS (2026-08-05)** — the
> catalog release bar lives in `docs/theme-acceptance.md`; objective package
> requirements are enforced in `lib/themes/themes.test.ts`; and the versioned
> engine → immutable preset → merchant-owned content contract now lives in
> `lib/themes/meta.ts`, `types.ts`, `index.ts`, and `apply.ts`.
> Phase 3 now supplies the shared professional-theme capability layer:
> `media_text`, editorial `gallery`, `testimonials`, dedicated `video`, and a
> persistent consent-aware `newsletter`; plus header, card, PDP, cart, and
> footer variants that can inherit immutable theme defaults or take
> draft/published merchant overrides in the visual builder.
> Phase 4 has started with the public catalog foundation at
> `themes.storemink.com`: reserved host routing, a responsive metadata-driven
> gallery, truthful release/demo/plan states, independent SEO metadata, and a
> discoverable link from the platform site.
> Basket is the only/default implementation, but it is **blocked from approval**
> under the new bar until its missing live demo is repaired and the browser,
> accessibility, performance, and two-reviewer gates are recorded.
>
> **Earlier implementation status:** P1 (F&B slice) + P2 DONE (2026-07-04): hero /
> usp_bar / tile_grid blocks, market header + quick-add card layout variants,
> functional header search (`/shop?q=`), real-photo imagery pipeline, and the
> **Basket** grocery template (`lib/themes/definitions/basket.ts`) verified
> live on desktop + mobile with a seeded `demo-basket` store. Newsletter and
> the Phase 3 editorial/video capability set are now built; `logo_marquee`
> remains vertical-specific work, not a Phase 3 platform blocker.
> **Branch:** `feature` · **Strategy:** single big merge into `main`.
> **Decisions locked:** imagery = curated free stock (Unsplash/Pexels, commercial-use); layout fidelity = data-driven block library (not bespoke per-template code).

The acceptance document is authoritative for **whether a theme may ship**.
This plan remains authoritative for **what theme capability and vertical work
comes next**. A theme phase is not complete until its stories are recorded
there, just as POS phases are not complete until their acceptance stories are
recorded in `docs/pos-acceptance.md`.

A merchant picks a business-type template at signup and gets a genuinely
distinct, brand-named store they can then customise (products, categories,
blogs, pages…). Basket proved that the data-driven renderer can support a deep
vertical treatment. The remaining work is to turn that one successful slice
into a professional, safely releasable catalog.

---

## The core problem — current

StoreMink has one substantive theme. Basket includes real imagery and dedicated
grocery treatments for cards, product detail, and cart, but there is no breadth
of visual direction and no release evidence under the new acceptance gate. A
single good vertical is a reference implementation, not a theme catalog.

The versioned catalog seam and Phase 3 shared capability layer are now built.
The next work is to author and release distinct vertical presets on those
primitives, starting only after Basket's demo and acceptance evidence are
repaired. Theme-specific additions such as `logo_marquee` can land with the
first vertical that genuinely needs them.

---

## 1. Historical progression — archived context

This table records the pre-Basket branch state that motivated the original
work. It is not a description of the current repository; current state is in
the status block and §9.1.

| Dimension               | Historical `main`                                                   | Historical pre-Basket `feature`                                 | Intended target                                                           |
| ----------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **Storefront pages**    | Homepage via `homepage_sections`; static pages hardcoded route dirs | All pages are `store_pages` rows, builder-editable ✅ **built** | Same — keep                                                               |
| **Templates at signup** | None — new store is bare/generic ⛔ **absent**                      | 2 templates (Arcade, Fresko) ⚠️ **near-identical**              | 7 vertical templates, visually distinct 🎯                                |
| **Section library**     | 6 homepage block types                                              | Same 6, shared homepage + pages ⚠️ **too few**                  | ~14 blocks (hero, media+text, gallery, testimonials, FAQ, gift packs…) 🎯 |
| **Layout variety**      | One fixed storefront layout                                         | One layout + per-section style ⚠️ **identical bones**           | Header / card / footer variants per template 🎯                           |
| **Design tokens**       | One accent colour per store                                         | Full palette + fonts + shape engine ✅ **built this session**   | Keep — author real values per vertical                                    |
| **Imagery**             | Per-store uploads only                                              | 4–7 KB gradient + silhouette webp ⚠️ **worst offender**         | Curated real photography per vertical 🎯                                  |
| **Post-signup edit**    | Old `/dashboard/homepage` editor                                    | Full Website Builder + live preview ✅ **built**                | Same + new blocks editable                                                |

---

## 2. What historical `main` had

- Multi-tenant SaaS: host-based tenancy, per-store branding, platform admin
  console, settings-based features, per-store blog taxonomy.
- Storefront homepage driven by the `homepage_sections` table and edited in the
  old `/dashboard/homepage` screen (`homepage-actions.ts`).
- Static pages (our-story, faqs, …) are **hardcoded route directories** — not
  editable.
- **No template system at all** — `lib/themes`, the builder, and `store_pages`
  do not exist on `main`. Signup creates a bare store.

## 3. What the historical `feature` branch built

Substantial and mostly _correct_ — the plumbing the vision needs already exists
here.

- **Website Builder** — every page is a `store_pages` row (draft + published
  sections), edited on a live-preview canvas with autosave and click-to-edit.
- **Section system** — 6 composable block types, a shared renderer, per-section
  style (background / padding / width / anchor), and sandboxed custom code.
- **Template system** (`lib/themes/`) — themes are data packages (brand, pages,
  menus, sample catalog). Signup picker filters by category, previews the live
  demo store, plan-gates.
- **Instantiation** — `createStore(name, template)` → `applyTheme` seeds a
  _published_, brand-named store with catalog + menus + pages. Exactly the flow
  the vision describes.
- **Design-token engine** (this session) — full palette + fonts + shape injected
  per store; all chrome CSS tokenised. Reusable foundation.

## 4. What was wrong before Basket

**Historical diagnosis:** both placeholder templates used the **same six section
types in the same homepage structure** — just reordered and recoloured.
Arcade's "hero" is a hardcoded dark-gradient custom-code block; product images
are 4–7 KB synthetic gradients with black silhouettes. The result reads as one
store wearing two hats.

- **Identical layout.** No layout variants — every template renders WholeSip's
  header, card grid, and footer.
- **Impoverished block library.** Six blocks can't express a lookbook, an
  ingredient story, a gift-pack grid, or a wholesale-enquiry page.
- **Placeholder imagery.** The single biggest "looks bad" factor — gradients and
  emoji, not photographs.
- **Only two, both generic.** No coverage of the verticals real merchants sign
  up for.
- **The token re-skin (this session) was the wrong altitude** — it recolours the
  problem instead of solving it. The engine stays; the invented Arcade/Fresko
  values and synthetic art go.

## 5. Target architecture: templates are data, not code

Distinctness comes from a richer block library + layout variants + per-template
tokens + real content — all stored as data and editable in the builder. We
deliberately do **not** hand-code a bespoke storefront per template, because:

- The storefront is one multi-tenant renderer over per-store data; bespoke code
  can't be instantiated or customised per merchant.
- The merchant edits _sections_ after signup — bespoke layouts wouldn't be
  builder-editable, breaking the whole promise.
- This is how mature builders (Shopify, Wix) work: a deep block library plus
  theme settings, all data.

**Principle:** make the **data** expressive enough that data alone produces
genuinely different stores. Every capability we add is a block, a variant, a
token, or an asset — never a one-off page.

---

## 6. Workstreams

### A. Richer section library — _the biggest lever for distinct layouts_

Add blocks via the documented 5-step recipe in `lib/homepage/section-types.ts`
(type → config → `EMPTY_CONFIG` → META → validate → editor form → renderer):

- **hero** — image / split / minimal / carousel variants (replaces the
  custom_code hero hack)
- **media_text** — image + copy (ingredient / routine / process stories)
- **gallery / lookbook** — image grid / masonry
- **testimonials** — reviews strip
- **usp_bar / trust_bar** — icon + label row
- **faq_accordion** — education-led verticals
- **collection_grid / gift_packs** — curated tiles
- **newsletter**, **logo_marquee**

### B. Layout variants on shared chrome

Extend `ThemeDesign` with a `layout` block; expose in the builder.

- **Header:** centred-logo / left-logo / minimal
- **Product card:** image-below / overlay / framed
- **Footer:** rich-columns / minimal

### C. Per-template design tokens

Keep the engine; author real values per vertical — premium serif for jewelry,
clean sans for wellness, editorial contrast for fashion.

### D. Imagery pipeline — _fixes the "images are worse" problem outright_

Source license-clear photos (Unsplash / Pexels, commercial use), optimise →
webp, bundle under `public/themes/{id}/`. Replace the emoji fallbacks
(🥛/📝/🧺) with a tasteful neutral placeholder. The existing CI asset-existence
test guards it.

### E. Author the vertical templates — _needs your per-vertical design ideas_

Per vertical: `design` + tailored page set + menus + sample catalog with real
images + tailored copy. Register in `meta.ts` / `definitions/` / `index.ts`; one
demo store each.

### F. Signup picker & post-signup polish — _mostly extension_

Extend the picker's vertical list to 7; use real hero previews. Ensure every new
block + variant is editable in the builder inspector, and add a "replace sample
content" nudge for new merchants.

---

## 7. Data & schema touches

- **No new tables.** New blocks live in the existing `store_pages.sections`
  JSONB; layout variants live in `stores.settings` via the theme. Keeps the
  merge small and reversible.
- Extend `ThemeDesign` (types only) with a `layout` block; extend the
  section-type union + validators for each new block.
- Product/category model already carries `image_url`, `images[]`, `card_color`,
  and variants — enough for rich sample catalogs.

## 8. Sequencing

Build one vertical end-to-end first as the reference pattern, then parallelise.
Each phase ends green (typecheck, tests, lint) so the branch stays mergeable
even mid-build.

- **P1 — Vertical-agnostic foundation.** Workstreams A + B + D: the new block
  types, layout variants, imagery pipeline + fallback. No per-vertical input
  required.
- **P2 — Reference vertical (Food & Beverage).** Origin, content-rich. Real
  imagery + tokens + full template + demo store, verified live on desktop +
  mobile. Becomes the pattern.
- **P3 — Remaining 6 verticals.** Authored in parallel on the shared library,
  each to the per-vertical design ideas.
- **P4 — Picker, QA, docs.** Extend the signup picker, extend CI theme
  invariants, visual QA each template, update `CODEBASE.md`. Then the single
  merge. (The Arcade/Fresko placeholders were retired early, 2026-07-04 —
  definitions, assets and demo stores deleted; Basket is the default theme
  until P3 lands more.)

## 9. The seven verticals

| Vertical                      | Signature sections / pages                                | Reuses                   |
| ----------------------------- | --------------------------------------------------------- | ------------------------ |
| **Food & Beverage**           | Ingredient / process story, USP bar, reviews, blog        | blogs, reviews, variants |
| **Beauty & Personal Care**    | Routine media+text, ingredient story, gift packs, reviews | blogs, reviews           |
| **Fashion & Apparel**         | Lookbook hero, collection grid, colour variants           | categories, variants     |
| **Health & Wellness**         | Education hero, FAQ accordion, reviews, blog              | blogs, reviews, FAQs     |
| **Home, Decor & Lifestyle**   | Category tiles, gallery, promo banners                    | categories, banners      |
| **Jewelry & Gifting**         | Premium hero, gift packs, minimal chrome                  | gift-packs, branding     |
| **Wholesale / Made-to-order** | Enquiry-led hero, wholesale page, **no checkout**         | enquiries, coupons       |

### 9.1 Food & Beverage — locked design direction (2026-07-04)

Owner picked a **grocery-marketplace** style (reference: Grocery Market / Home
Biz screenshots), not the artisanal farm-to-table draft. Spec:

- **Tokens** — deep pine header `#0F3E38`, white page canvas, peach hero field
  `#FAE3C1`, tangerine accent `#EF5A2A` (pill CTAs), navy `#101B33` USP strip +
  footer, pastel tile fills. Type: Plus Jakarta Sans (bold) display / Inter
  body — no new fonts. Shape: friendly — 12–16px cards, full-pill buttons.
- **Homepage** — hero banner (colored field, headline + pill CTA + product
  imagery + promo badge) → category circles → colored offer tiles →
  per-category product rows with quick-add → promo banner 2-up → dark usp_bar
  strip. Density over storytelling; testimonials/blog demoted to inner pages.
- **Mostly variants of existing blocks**: category circles =
  `shop_by_category` variant; offer tiles = colored `collection_grid` tiles;
  product rows = `featured_products` carousel variant; banner pair =
  `promo_banner` 2-up; USP strip = `usp_bar` dark style.
- **New Phase-1 scope this implies** (Workstream B): (a) header layout
  variant — solid brand-colored bar with prominent search; needs
  `layout.header` + a header-background token in `ThemeDesign`; (b)
  product-card quick-add variant ("+ Add" on card, cart plumbing exists).
- **Imagery (Workstream D)**: packshot cutouts on white/pastel fields, not
  lifestyle photography.
- **Skipped for v1**: wishlist hearts (no wishlist feature exists).
- **BUILT (2026-07-04)** as the `basket` theme: new `hero` (banner variant),
  `tile_grid` (offer tiles + banner 2-up) and `usp_bar` blocks; category
  circles as a `shop_by_category` display variant; `ThemeDesign.layout`
  (`header: "market"` + `card: "quick_add"`); functional header search →
  `/shop?q=` with client-side filtering; 22 curated Unsplash webp assets under
  `public/themes/basket/`; emoji placeholders replaced with a neutral icon.
  Deviation from spec: bright product photography instead of packshot cutouts
  (true cutouts are rare on free-stock sources; pastel `card_color` tiles keep
  the grocery look). CI invariants extended (tile imagery walk, strict layout
  colours). Demo store `demo-basket` seeded and visually verified.
- **FULL STOREFRONT REDESIGN (2026-07-04)** — from owner design references, a
  distinct premium grocery skin for the whole Basket storefront, gated so it
  looks nothing like WholeSip and CANNOT affect the WholeSip store. Added
  `ThemeDesign.layout.storefront = "grocery"` → `sm-storefront-grocery` root
  class + `lib/store/storefront-layout.ts` helper. New grocery variants:
  product cards (peach card, category pill, always-on "+ Add" — CSS-gated),
  product-detail page (`grocery-product-detail.tsx`: breadcrumb, buy-box with
  price note, variant chips, dark Add-to-cart + orange Buy-now, trust row,
  description accordion), cart (`grocery-cart.tsx`: "Your basket", order-summary
  card with Delivery/Savings, promo, orange Proceed-to-checkout), the shop
  hero (brand-neutral, no WholeSip text), and the new `faq_accordion` block
  (filter pills + accordion) on the FAQ page. `CartItem.category` added so cart
  lines show the category. Related products now render the shared `ShopCard`.
  Checkout/order-confirmation deliberately skipped (payments deferred).
  Verified route-level (grocery markup present on demo-basket, ABSENT on the
  WholeSip store's PDP/cart/shop) + full CI green.
- **Per-store branding cleanup (2026-07-04)** — removed the last hardcoded
  "WholeSip" strings that surfaced on every store: blog listing/detail, shop,
  product, cart and enquiries page metadata now read the host store's brand
  (via `getStoreBrand()` / the layout `%s | {brand}` title template), and the
  `AuthModal` "Welcome to …" copy uses `useBrand()`. The Basket `our-story`
  page was rebuilt from bare text into a designed page (hero banner + story +
  dark USP strip + full-image closing hero). demo-basket now renders ZERO
  "WholeSip" references; the WholeSip store still shows its own brand.

## 10. Testing & guardrails

- `themes.test.ts` now enforces the objective package gate: catalog metadata,
  content floors, strict section validity, complete design tokens, theme-local
  optimized assets, and a catalog-sized preview.
- `docs/theme-acceptance.md` owns the complete gate: package CI, live storefront
  stories, accessibility/performance evidence, and a scored two-reviewer design
  pass. A theme does not count as done merely because it renders.
- CI parity throughout: `lint`, `typecheck`, `test`, `prettier`, `build`.

## 11. Next phase

- **Quality Phase 1 — done:** acceptance source of truth plus enforceable
  package/asset checks.
- **Quality Phase 2 — done:** the client-safe manifest now declares engine and
  preset versions, release state, industries, catalog-size fit, feature claims,
  screenshots, demo health, plan gate, and catalog visibility. Full definitions
  nest immutable authored content under `preset`; `applyTheme` pins engine and
  preset versions in `stores.settings.theme`; rendering honors that pin and
  falls back to legacy `settings.template` without a migration.
- **Capability Phase 3 — done:** media with text, editorial gallery/lookbook,
  testimonials/press, dedicated video, and persistent consent-aware newsletter
  are typed, validated, builder-editable, rendered responsively, and tested.
  Shared header/card/PDP/cart/footer variants resolve from the pinned theme plus
  draft/published merchant overrides without forking the storefront or mutating
  the immutable preset. Legacy Basket grocery pins remain compatible.
- **Phase 4 — in progress:** the public `themes.storemink.com` catalog
  foundation is built from `THEME_META`, with reserved host routing, industry
  filters, canonical/robots/sitemap/OG metadata, and demo links gated by live
  health. Next repair Basket's demo/release evidence, then author Studio, Ritual,
  and subsequent vertical presets against the completed shared capability
  contract. A preset is not done until every applicable acceptance story and
  two-reviewer gate is recorded.
- **Basket repair — parallel prerequisite:** restore/reseed `demo-basket` and
  run the new acceptance stories. This can return Basket to Candidate, but does
  not block designing the Phase 2 contract.

---

_Companion visual version of this plan was drafted as an artifact during
planning; this markdown file is the source of truth kept on the branch._
