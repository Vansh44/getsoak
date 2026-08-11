# Studio and Ritual production release audit — 2026-08-11

This is the Phase 4 release record for Studio `0.1.0` and Ritual `0.1.0`.
The audit was run against the production demo hosts with the Codex in-app
Chromium browser and Lighthouse `12.8.2`. It is technical release evidence,
not either of the two independent human approvals required by
`docs/theme-acceptance.md`.

## Production storefront sweep

The route and responsive sweep covered 1440 × 900, 768 × 1024, and 390 × 844.
No route produced another tenant, the platform 404, a runtime error, horizontal
overflow, or a broken visible image after lazy media had loaded.

| Theme  | Homepage | Shop | Product detail                       | Cart | Content                                | Missing route   |
| ------ | -------- | ---- | ------------------------------------ | ---- | -------------------------------------- | --------------- |
| Studio | Pass     | Pass | `/shop/earth-table-lamp` pass        | Pass | `/our-approach` and `/care-guide` pass | Themed 404 pass |
| Ritual | Pass     | Pass | `/shop/stillwater-facial-serum` pass | Pass | `/our-ritual` and `/care-notes` pass   | Themed 404 pass |

Both product-detail pages added a product to the cart. Quantity controls,
prices, totals, cart badges, and checkout calls to action remained readable and
aligned. Header search returned the expected seeded product for `lamp` and
`serum`. The checked routes produced no console errors or warnings.

The production theme catalog currently exposes neither theme, as required for
a blocked release. Its metadata, host links, industry filters, and signup link
remain platform-owned; Basket is the only visible catalog card.

## Lighthouse baseline

The first mobile production run deliberately records the failing baseline
before fixes. Demo hosts are intentionally non-indexable, so the SEO score is
not a theme-release defect.

| Theme  | Performance | Accessibility | Best practices | SEO | LCP    | TBT    | CLS    |
| ------ | ----------- | ------------- | -------------- | --- | ------ | ------ | ------ |
| Studio | 43          | 94            | 100            | 69  | 5.82 s | 1.10 s | 0.0078 |
| Ritual | 59          | 94            | 100            | 69  | 4.72 s | 0.53 s | 0.0001 |

These runs fail TA-4.1 (Accessibility must be at least 95) and TA-4.4
(Performance at least 90 and LCP at most 2.5 s).

## Findings and candidate fixes on `f1`

- Replaced the deprecated Next.js 16 `priority` prop with `preload` on hero and
  first-carousel LCP images.
- Removed phone authentication, reCAPTCHA, country metadata, and the phone
  input from the anonymous storefront's initial bundle; the auth modal now
  loads only after the account control is used.
- Darkened both themes' faint-text token so sale prices meet WCAG AA.
- Switched Ritual's dusty-rose hero to dark copy; its prior light copy was
  below contrast minimum.
- Made linked category images decorative because the adjacent category name
  already supplies the link's accessible name.
- Corrected footer link-column headings from level four to level two.
- Marked both live demo hosts healthy while keeping both releases blocked and
  hidden.

Studio's production material-story section still contains the old black field,
and Ritual's stored hero still contains the old contrast setting. Those values
live in seeded page rows, so both demo stores must be reset/reseeded after this
candidate is deployed.

## Gates still required before publication

1. Deploy the `f1` candidate and reset/reseed `demo-studio` and `demo-ritual`.
2. Rerun the five-page accessibility scan and mobile production Lighthouse for
   both pristine demos; every TA-4 threshold must pass.
3. Complete the keyboard and screen-reader smoke test.
4. Record the product/design and commerce/QA scorecards. Every dimension must
   be at least 4 and each average at least 4.2; at least one reviewer must not
   have authored the theme.
5. Only then change each release to `published` and catalog visibility to
   `public`, and verify the cards and choices on `themes.storemink.com` and
   signup.
