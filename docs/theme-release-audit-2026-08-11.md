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

After the 2026-08-12 production reseed, the public theme catalog exposes both
Studio and Ritual with healthy live-preview links and the correct industry
filters. The signup picker consumes the same `isThemeSelectable` metadata, so
both published presets are eligible there as well.

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
- Marked both live demo hosts healthy; the initial candidate remained blocked
  and hidden until the later production publication.

Studio's old black material-story field and Ritual's old hero contrast setting
were stored in seeded page rows. Both production demo stores were reset and
reseeded on 2026-08-12; the responsive production sweep confirms the corrected
values are live.

## Post-reseed verification — 2026-08-12

The route sweep was repeated at 390 × 844, 768 × 1024, and 1440 × 900. Studio
and Ritual passed homepage, shop, product detail, cart, content-page, and themed
404 checks with no horizontal overflow or broken images.

The required five-page Lighthouse accessibility scan produced:

| Theme  | Home | Shop | Product detail | Cart | Content |
| ------ | ---- | ---- | -------------- | ---- | ------- |
| Studio | 100  | 98   | 100            | 100  | 100     |
| Ritual | 100  | 98   | 100            | 100  | 100     |

The only failed accessibility audit is moderate heading order on `/shop`: the
shared product card rendered an `h3` directly below the page `h1`. The `f1`
candidate now lets the shop grid render card names as `h2`, while homepage and
related-product carousels retain `h3` below their section headings.

Fresh mobile performance runs improved accessibility and main-thread work but
still fail the strict TA-4.4 performance threshold:

| Theme  | Performance | Accessibility | Best practices | LCP    | Observed LCP | TBT    | CLS   |
| ------ | ----------- | ------------- | -------------- | ------ | ------------ | ------ | ----- |
| Studio | 67          | 100           | 100            | 7.26 s | 3.07 s       | 300 ms | 0.008 |
| Ritual | 73          | 100           | 100            | 6.73 s | 2.57 s       | 160 ms | 0     |

The hero is correctly preloaded and has only 22–36 ms discovery delay. The
remaining critical path includes Firebase Auth and its hosted iframe on every
anonymous visit. The `f1` candidate now checks for the server session cookie
and dynamically loads Firebase only for returning shoppers or when an
anonymous visitor opens account UI. This preserves immediate signed-in-session
restoration while removing the SDK from anonymous catalog visits. Production
Lighthouse must be rerun after that candidate is deployed.

The keyboard audit also found that the account button relied on hover. The
`f1` candidate makes it toggle the menu with Enter/Space and dismiss with
Escape while restoring focus. This must be smoke-tested after deployment.

Studio and Ritual are already public in production catalog/signup metadata.
That describes the live state, but it does not retroactively satisfy the strict
acceptance policy: TA-4.4 and the two independent human scorecards remain open.

## Gates still required for full approval

1. Deploy the `f1` semantic, keyboard, and anonymous-auth performance fixes.
2. Rerun `/shop` accessibility and mobile production Lighthouse for both
   pristine demos; every TA-4 threshold must pass.
3. Complete the post-deploy keyboard and screen-reader smoke test.
4. Record the product/design and commerce/QA scorecards. Every dimension must
   be at least 4 and each average at least 4.2; at least one reviewer must not
   have authored the theme.
5. Once those gates pass, close the release exception and record Studio and
   Ritual as fully approved rather than merely live.
