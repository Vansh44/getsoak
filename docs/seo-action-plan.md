# SEO action plan — audit findings, fixes, and remaining scope

> Audit run 2026-07-29 against branch `staging` + the **live production hosts**.
> 65 findings survived an adversarial verification pass (2 refuted). Every item
> below cites a `file:line` or a live HTTP observation. Companion to
> `docs/seo-indexing.md`, which describes the intended design — this document
> records where reality diverges from it.

> **Implementation update — 2026-08-04.** The automatic discovery gap described
> below is now closed in code: `lib/seo/store-indexing.ts` unifies all
> product/blog/page publish paths, automatically verifies custom-domain
> URL-prefix properties, and persists Google attempt/success/error state;
> `/api/cron/seo-refresh` retries the platform/help/themes sitemaps and every launched
> store daily. Bulk product publish and customer direct-publish now participate,
> merchant Organization schema uses configured identity/contact/social data, and
> custom-domain canonical selection includes the live plan-entitlement gate.
> `docs/seo-indexing.md` is the current runbook. Historical “today/not built”
> statements below describe the 2026-07-29 audit baseline and are retained as
> evidence, not current architecture.

**Goals this plan is graded against:**

1. `storemink.com` ranks #1 for the brand query "storemink".
2. Every merchant store created on the platform is properly indexed.
3. `help.storemink.com` is public, highly indexed, and new articles get into
   Google fast.
4. Google stays continuously up to date (re-crawl / freshness cadence).

---

## 1. Verdict

**The SEO machinery on `main` is live and substantially correct — but the one
real merchant store is actively telling Google to index a domain that does not
exist, and there is almost nothing published to index.**

What is genuinely already working (do not rebuild these):

| Check                                | State                                                                                                                                                                                              |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storemink.com/robots.txt`           | 200, `Allow: /`, correct disallows, own `Host:` + `Sitemap:`                                                                                                                                       |
| `help.storemink.com/robots.txt`      | 200, own `Host:` + `Sitemap:`                                                                                                                                                                      |
| Staging/preview/dev noindex          | Correct, derived from the apex domain — no per-deploy flag to forget (`lib/store/host.ts:44`)                                                                                                      |
| IndexNow key file                    | 200, contents match the key — pings will be accepted                                                                                                                                               |
| Apex JSON-LD                         | Valid `Organization` + `WebSite` + `SoftwareApplication` `@graph` with real INR `AggregateOffer`                                                                                                   |
| Product / blog / help-article schema | Real `Product` / `Article` / `TechArticle` + breadcrumbs                                                                                                                                           |
| Search Console domain property       | **Verified** — two live `google-site-verification` TXT records on `storemink.com`. A Domain property covers `help.` and every `{slug}.` subdomain, so **no per-store verification is ever needed** |
| `main` vs `staging`                  | The 45-commit delta contains **zero SEO code**. Merging changes no ranking                                                                                                                         |

The honest framing on goal 1: `storemink.com` was registered **2026-06-30** — it
is four weeks old, has no backlinks, and is not yet in the index. "storemink" is
an invented, non-generic word with no competitor to outrank. So #1 is not a
competition problem; it is an **indexing and corroboration** problem. Once §3 A1–A3
land, expect #1 within days-to-weeks. If it doesn't happen, the cause will be
indexation, not ranking.

---

## 2. Problems found

### 2.1 Critical — actively reversing indexing

**P1. Storefronts canonicalise to an unverified custom domain.**
`lib/site.ts:21`, `app/sitemap.ts:111` and `app/robots.ts:34` all build the public
origin as `store.custom_domain ?? {slug}.{ROOT_DOMAIN}` with **no
`custom_domain_verified` check**, while `lib/store/resolve.ts:88-99` refuses to
_route_ an unverified custom domain. `getStoreUrl()` also feeds `metadataBase`
(`app/(storefront)/layout.tsx:40-42`), so this contaminates every canonical and
`og:url` on every storefront page — not just the two SEO routes.

Live, verified: `wholesip.storemink.com` serves 200 but emits
`<link rel="canonical" href="https://wholesip.com/shop/almond-milk">`,
`Host: https://wholesip.com` in robots.txt, and all 24 `<loc>` entries on
`wholesip.com` — while `curl https://wholesip.com/` returns **000** (no TLS
listener; DNS → a Namecheap registrant-hold page; no TXT records, so it was never
verified). Google follows the canonical, can't fetch it, and drops the working
subdomain URLs as _"Alternate page with proper canonical tag."_

This is reachable **by design** for every future merchant:
`app/actions/store-domain.ts:160-169` writes `custom_domain` while explicitly
`delete`-ing `custom_domain_verified` the moment someone types a domain, before
DNS is done. Total, silent deindexing of an entire tenant.

**P2. An unresolved store host serves the platform's robots + sitemap.**
`app/sitemap.ts:99-109` falls back to `PLATFORM_PATHS` and `app/robots.ts:33-36`
to `PLATFORM_URL` whenever `getCurrentStoreOrNull()` is null. So
`demo-basket.storemink.com/sitemap.xml` serves `storemink.com` URLs, and
`zzz-not-a-store.storemink.com/robots.txt` returns `Allow: /` plus the apex's
`Host`/`Sitemap`.

**P3. `vercel.json` crons do not run.** Production is Cloud Run
(`server: Google Frontend`, no `x-vercel-*` headers) and the repo contains **no
Cloud Scheduler definition** — only the recipe at
`docs/gcp-migration-phase4-cloud-run.md:162`, and
`docs/gcp-migration-cutover-checklist.md:136` (`- [ ] Crons → Cloud Scheduler`)
is **unchecked**. This is listed here because it blocks the SEO cron in §4 — but
if those jobs were never created, `send-emails` is dead and the **entire
notification/email queue has been silently stalled** (CODEBASE.md §24). Verify
this before anything else in this document.

### 2.2 High

**P4. Fabricated `lastmod` on most URLs.** `app/sitemap.ts:64` `const now = new
Date()` is used verbatim for every static path (`:116`), every product (`:137`),
the help hub (`:78`) and every help category (`:85`). Two fetches four seconds
apart returned `20:15:43.058Z` then `20:15:47.282Z`. Google uses `lastmod` only
when it is consistently accurate and **discards it site-wide** when values look
fabricated — which throws away the values that _are_ correct (`store_pages` `:163`,
blogs `:152`, help articles `:90`). This is the direct mechanism behind goal 4.

**P5. Nothing published to index.** `storemink.com/sitemap.xml` has exactly
**2 URLs** (`/`, `/signup`). `help.storemink.com/sitemap.xml` has **9** — the hub
plus 8 categories — and **zero articles, because zero help articles are
published**. All 8 categories render _"No articles here yet."_ Goal 3 is currently
blocked by content, not code.

**P6. No `sameAs`, no `contactPoint`, no social links anywhere.**
`grep -rn "sameAs|contactPoint" app lib` returns **zero hits repo-wide**. The
Organization node (`app/platform/page.tsx:216-227`) is name/url/logo/description
only, and the footer (`:688-733`) has no outbound social anchor at all. Your new
LinkedIn / YouTube / Instagram profiles are invisible to Google as entity
evidence. Highest-leverage code lever for goal 1.

**P7. The apex competes with itself and has no canonical.** `/`, `/signup` and
`/login` all return 200 with the **byte-identical** `<title>` and identical
`og:url=https://storemink.com`, and there is **no `<link rel="canonical">`
anywhere** — while `app/sitemap.ts:56` nominates `/signup`.

**P8. Google is notified on exactly one event.** `submitSitemapToGoogle` has one
non-test call site: `app/actions/store-signup.ts:372`. Neither
`${PLATFORM_URL}/sitemap.xml` nor `${HELP_URL}/sitemap.xml` has ever been
submitted. `search-engines.ts:184` returns **silently** when the property env is
unset, so a misconfiguration is undetectable.

**P9. Missing IndexNow pings.** Blog publishing pings only from the list-row
toggle (`blog-actions.ts:504`) — `createBlog`, `updateBlog`,
`approveCustomerBlog`, `bulkSetBlogStatus` and `submitCustomerBlog`'s
direct-publish branch all just revalidate. Also missing:
`bulkToggleProductPublish` (`product-actions.ts:661-687`), `updatePageMeta`
(`page-actions.ts:250-329`), help category create/update
(`help-actions.ts:447-497`). Help article publish pings 1 URL where it should
ping 3 (article + category + hub).

### 2.3 Medium — mass-tenant hygiene (goal 2)

**P10. Theme seeds create near-duplicate content at scale.** Every store ships
~17 byte-identical pages (our-story is 800 words of shared prose with no
store-name interpolation, `lib/themes/definitions/basket.ts:257`) plus sample
products literally titled _"Tomatoes (500 g) (Sample)"_ with _"replace it with
your own"_ in the description (`:459-461`).

**P11. No readiness gate before first submission.** `store-signup.ts:369-375`
submits a seconds-old, unedited store to Google + IndexNow immediately. There is
no launch flag anywhere in the codebase. Mass-submitting thin stores damages
crawl reputation for the whole `*.storemink.com` domain — and `robots.txt`
Disallow does **not** deindex what is already in.

**P12. Merchant schema defects.** `structured-data.tsx:16` publishes
**StoreMink's** `icon.svg` as the merchant's `logo` whenever `brand.logoUrl` is
null (true for every new store — no theme seeds one). `brand.social.*` and
`brand.email`/`phone` are rendered visibly in the footer (`Footer.jsx:65-66`) but
never emitted as `sameAs`/`contactPoint`. Both article publishers
(`lib/seo/schema.ts:129-134`, `:173-181`) emit an Organization with **no `@id`
and no `url`**, so it can never resolve to the `#organization` node.

**P13. `help.storemink.com` emits no Organization/WebSite at all** —
`curl .../help | grep -c ld+json` → 0. Only the category and article routes have
JSON-LD.

**P14. `/track-order` is blocked but linked and submitted.** `app/robots.ts:49`
disallows it platform-wide, but `lib/sections/registry.ts:110-114` states it is
deliberately merchant `store_pages` data — so the same host's sitemap submits it
while `lib/menus.ts:34,59` links it from the default header **and** footer.

**P15. `public/icon.svg` is 3,176,331 bytes** (an inlined base64 PNG) and is
**2048×2098 — not square**, a documented reason SERP favicon extraction fails.
It is the `logo` in three JSON-LD nodes.

**P16. No category landing pages — the structural ceiling for goal 2.** No
`/shop/{category}` route exists; `shop/page.tsx:30-31` canonicalises every
`?category=` variant to `/shop`, and the theme's own tiles link to
`/shop?category=fruits-vegetables` (`basket.ts:120,130,140,146`) — four crawlable
facets that all canonicalise away. A store can rank for its brand and for
individual product names and **nothing in between** — which is where
e-commerce search volume actually lives.

**P17. No analytics of any kind.** `grep -rnE 'googletagmanager|gtag\(|plausible'`
over `app/layout.tsx` returns nothing. Goals 1 and 4 are unmeasurable.

**P18. `faq_accordion` renders only the first answer into the DOM.**
`faq-accordion-section.tsx:23` is `useState<number|null>(0)` and `:103-105` gates
the `<p>` on `open` — nothing clicks for a crawler. Latent today, but
`basket.ts:319` ships one, so every future store inherits it.

**P19. Five storefront pages missing the host guard.** `enquiries/page.jsx`
(sitemap-listed), `cart/page.jsx`, `profile/page.tsx`, `checkout/page.tsx`,
`checkout/success/page.tsx` lack `requireStorefrontStoreId()`.
`nonexistent-slug.storemink.com/enquiries` returns 200 with "WholeSip" in the
body — the exact failure CODEBASE.md §3 warns about.

**P20. `docs/seo-indexing.md` is wrong** at `:27-31` and `:76`: it claims both
notify channels fire from all four mutation actions and that per-store sitemaps
are auto-submitted on publish. Neither is true.

### 2.4 Refuted — do not act on these

- _"Soft-404s are an indexing problem."_ Storefront/help not-found pages return
  **200** (because `app/loading.tsx` streams before `notFound()` can set status),
  but Next injects `<meta name="robots" content="noindex">` into that HTML and its
  own docs (`loading.md:109-111`) state this "does not lead to indexation" —
  verified present on all five cases. Worth fixing for status correctness and GSC
  hygiene only (C6), not as an indexing defect.
- _"`changefreq`/`priority` need tuning."_ Google ignores both entirely. They
  cost nothing where they are; never reason about them.

---

## 3. Fixes — prioritised

### (A) Do first — blocks or reverses indexing

| #      | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                   | Where                                                      | Effort  |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------- |
| **A0** | **Verify the three existing Cloud Scheduler jobs exist**: `gcloud scheduler jobs list --project=storemink-prod`. Not SEO — but if they don't, the email/notification queue is dead. Gate everything else on this.                                                                                                                                                                                                                     | —                                                          | trivial |
| **A1** | **One helper `storeCanonicalHost(store)`** returning `custom_domain` **only** when `settings.custom_domain_verified === true`, else the subdomain — mirroring `resolve.ts:99`. Route all three call sites through it; this fixes `metadataBase` and the IndexNow base in the same edit. Unit-test the unverified case. Then clear `custom_domain` for wholesip in prod (or repoint its DNS) and audit for other stores in this state. | `lib/site.ts:21`, `app/sitemap.ts:111`, `app/robots.ts:34` | small   |
| **A2** | **Unresolved store host must not serve platform data.** Branch on `isPlatformHost(host)` (already imported) before emitting; return `[]` / `disallow: "/"` for a store-shaped host with no store. Same null-store path as A1 — do them together.                                                                                                                                                                                      | `app/sitemap.ts:99-109`, `app/robots.ts:31-56`             | small   |
| **A3** | **Make the Google channel visible when it's broken.** `search-engines.ts:184` returns silently when the property env is unset. Change to a `logWarn` via `lib/observability/logger.ts`; add a success log at `:190-201`. Then §5.2–5.4.                                                                                                                                                                                               | `lib/seo/search-engines.ts:181-201`                        | trivial |
| **A4** | **Publish help articles.** Content, not code — but it outranks every code fix below. The editor and AI drafting (`/dashboard/help`, `runHelpAiCommand`) are already built. Goal 3 is 100% blocked until there is one published article.                                                                                                                                                                                               | —                                                          | ongoing |

### (B) High leverage

| #       | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Where                                                                   | Effort  |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------- |
| **B1**  | **Truthful `lastmod`** across all URL classes per the §4 table, incl. a new `products.content_updated_at` column and the `store_pages.published_at` switch. Add the two-identical-calls regression test. Delete the dead `revalidate = 3600` (`app/sitemap.ts:18`) and its false comment in the same commit.                                                                                                                                                                                            | `app/sitemap.ts`, `lib/storefront/queries.ts`                           | medium  |
| **B2**  | **`sameAs` + `contactPoint` + `address` on the platform Organization, plus three real `<a rel="me">` footer anchors.** Export from a new `lib/seo/brand-identity.ts` so the help centre reuses it. Keep `alternateName` unambiguous: `["Storemink","storemink.com"]`. Google explicitly supports a lowercase domain as a site-name fallback; the generic phrase `store mink` must not be used because it reinforces the unrelated fur-storage interpretation. 20-minute job, highest goal-1 code lever. | `app/platform/page.tsx:216-227`, `:688-733`                             | trivial |
| **B3**  | **Apex canonical + de-duplicate.** `alternates: { canonical: "/" }` on `app/platform/layout.tsx`; own metadata + canonical for `/signup`; `robots: { index: false, follow: false }` for `/login` and add it to the platform disallow branch. Both are client components → metadata goes in a co-located `layout.tsx`.                                                                                                                                                                                   | `app/platform/layout.tsx`, `signup/`, `login/`                          | small   |
| **B4**  | **Enrich the merchant Organization node** — build `sameAs` from `brand.social.instagram`/`youtube` (put **whatsapp in `contactPoint`**, not `sameAs` — a `wa.me` deep link is not a profile), add `legalName` and `contactPoint` from `brand.email`/`phone`. One file, lifts entity signals across the whole tenant fleet.                                                                                                                                                                              | `structured-data.tsx:11-27`                                             | small   |
| **B5**  | **Stop publishing StoreMink's logo as the merchant's:** `...(brand.logoUrl ? { logo: brand.logoUrl } : {})`, matching `lib/seo/schema.ts:130-134`. Leave the _favicon_ fallback alone.                                                                                                                                                                                                                                                                                                                  | `structured-data.tsx:16`                                                | trivial |
| **B6**  | **Fix the orphan publisher in both article builders** — add `@id` + `url` so it resolves to `${siteUrl}/#organization`. Cover in `schema.test.ts`.                                                                                                                                                                                                                                                                                                                                                      | `lib/seo/schema.ts:129-134`, `:173-181`                                 | trivial |
| **B7**  | **Add `platformOrganizationSchema()`** to `lib/seo/schema.ts` (same `@id`, the B2 `sameAs`) and render it from `app/help/layout.tsx`; have `app/platform/page.tsx` build its node from the same helper so they can't drift.                                                                                                                                                                                                                                                                             | `app/help/layout.tsx`, `lib/seo/schema.ts`                              | small   |
| **B8**  | **Add the missing IndexNow pings** per the §4 table: extract `notifyBlogPublished()` mirroring `product-actions.ts:303-311`; add to `bulkToggleProductPublish`, `updatePageMeta`, help category create/update; make the help ping submit 3 URLs; pass seeded slugs into `store-signup.ts:373`.                                                                                                                                                                                                          | 5 action files                                                          | small   |
| **B9**  | **Un-block `/track-order`** (delete the `robots.ts:49` entry). Then export the disallow list as a shared const and filter matching slugs in `getPublishedPageSlugs`, with a prefix-boundary check so a page slugged `cartography` isn't caught by `/cart`. Add a test asserting every disallowed prefix is reserved or non-storefront.                                                                                                                                                                  | `app/robots.ts:43-52`, `queries.ts:458`                                 | small   |
| **B10** | **Theme seed hygiene.** Set sample products to `status: "draft"` (`apply.ts:194`); shorten seeded prose to obvious placeholders. ⚠️ If you noindex seeded pages, scope it: **`seoNoindex: page.slug !== ""`** — the loop at `apply.ts:303` includes the homepage sentinel, so a blanket `true` would noindex every new store's homepage.                                                                                                                                                                | `lib/themes/apply.ts`, `definitions/basket.ts`                          | medium  |
| **B11** | **Readiness gate before first submission.** Add `stores.settings.launched`, set it on the merchant's first page publish or first non-sample product publish, move the ping there, and have robots/sitemap return `disallow: "/"` / `[]` until true. Must land **before** the first submission.                                                                                                                                                                                                          | `store-signup.ts`, `page-actions.ts`, `app/robots.ts`, `app/sitemap.ts` | medium  |
| **B12** | **Fix the 3.17 MB non-square favicon/logo.** Add a square `public/logo-512.png` for the three JSON-LD `logo` fields; either redraw `icon.svg` as a real vector or move to the Next 16 `app/icon.png` convention (content-hashed immutable URL for free).                                                                                                                                                                                                                                                | `public/`, 3 schema call sites                                          | small   |
| **B13** | **Merge `staging` → `main`** after the four CI gates, and in the same change add `/legal`, `/legal/terms`, `/legal/privacy`, `/legal/acceptable-use` to `PLATFORM_PATHS` — derive from `signupRequiredDocs()` so it can't drift — **and** footer-link them. Sitemap-only URLs with no internal links are crawled reluctantly.                                                                                                                                                                           | `app/sitemap.ts:54-57`, `app/platform/page.tsx`                         | small   |
| **B14** | **Product schema: three cheap additions** — `sku` (per-variant `Offer` nodes for multi-variant products rather than one flattened AggregateOffer), `seller` with `@id: ${siteUrl}/#organization`, `offerCount`, and `availability: BackOrder` where `shop/[slug]/page.tsx:307-317` flattens backorder into InStock. **Skip** `shippingDetails`/`hasMerchantReturnPolicy`/`priceValidUntil` — the structured source data does not exist, and a guessed past `priceValidUntil` marks your offers expired. | `lib/seo/schema.ts:38-107`, `shop/[slug]/page.tsx`                      | medium  |
| **B15** | **Render all FAQ answers into the DOM** (collapse with CSS, not conditional render), then add `faqPageSchema()` and emit from `(storefront)/page.tsx` + `[pageSlug]/page.tsx`, sharing the helper with a new apex FAQ block (the 6 Q/A pairs at `app/platform/page.tsx:153-178` are unmarked). FAQ rich results are gov/health-only since Aug 2023 — this buys AI Overview / Bing / LLM extractability, not a SERP accordion.                                                                           | `faq-accordion-section.tsx`, `lib/seo/schema.ts`                        | small   |
| **B16** | **Store discovery surface.** Add an **opt-in curated** `/stores` showcase to `PLATFORM_PATHS` — not an auto-list of every tenant, which reads as a link farm. Internal links, unlike sitemap entries, pass crawl signal, and it gives the apex real non-duplicate content.                                                                                                                                                                                                                              | new route, `app/sitemap.ts`                                             | medium  |
| **B17** | **Category landing pages.** Add `shop/[category]/page.tsx` with its own metadata + self-canonical, server-side filtered and paginated; keep `?category=`/`?q=` as the client facet; emit one sitemap entry per active category with `categories.updated_at`. Biggest structural win for goal 2. (Fold in the missing `.limit()` on `getPublishedProducts` while there.)                                                                                                                                 | new route, `queries.ts:105-141`, `app/sitemap.ts`                       | large   |

### (C) Polish

| #   | Fix                                                                                                                                                                                                                                                                                                                                                        | Where                             |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| C1  | Add `/checkout` to the store disallow list **and** a `checkout/layout.tsx` with `robots: { index: false }`. Add `/orders`, `/notifications`, `/pos` now so they're covered when staging ships.                                                                                                                                                             | `app/robots.ts`, `checkout/`      |
| C2  | Filter empty help categories out of the sitemap — `getHelpCategoryCounts` already exists (`lib/help/queries.ts:70-90`); 8 of 8 are currently empty. Optionally `robots: { index: false }` on an empty category so it self-heals.                                                                                                                           | `app/sitemap.ts:82-87`            |
| C3  | Respect `seo_noindex` on the homepage — `app/sitemap.ts:30` hardcodes `/` and the sentinel never reaches the filter. Fold into B1.                                                                                                                                                                                                                         | `app/sitemap.ts`                  |
| C4  | Emit `/blogs` only when the store has ≥1 published post (already fetched, so free) and `/shop` only with published products; **drop `/enquiries`** — a contact form is not a landing page.                                                                                                                                                                 | `app/sitemap.ts:30-35`            |
| C5  | Add `requireStorefrontStoreId()` to the five pages in P19, then a drift test that `fs.readdir`s `app/(storefront)` and asserts every page references the guard (mirroring the `RESERVED_PAGE_SLUGS` test).                                                                                                                                                 | 5 files + test                    |
| C6  | Soft-404 → real 404 for status correctness: resolve the store in `proxy.ts` and 404 an unknown slug (Next's own recommendation, `loading.md:115`), and/or move `app/loading.tsx` under the route groups that want it.                                                                                                                                      | `proxy.ts`, `app/loading.tsx`     |
| C7  | `breadcrumbSchema` on `[pageSlug]` — every merchant's our-story/faqs/policies has none. (Skip `ItemList` on listings; Carousels is a limited beta.)                                                                                                                                                                                                        | `[pageSlug]/page.tsx`             |
| C8  | Emit up to ~10 `Review` nodes from the already-fetched array; cap explicitly (`getReviews` is unbounded). Marginal — `aggregateRating` already unlocks the stars.                                                                                                                                                                                          | `lib/seo/schema.ts`               |
| C9  | `imageEntry` for custom/theme page sitemap entries (hero, tile_grid, carousel slides) and for `/`. No grant change needed — anon SELECT on `published_sections` already exists.                                                                                                                                                                            | `app/sitemap.ts:157-165`          |
| C10 | Demo stores are created `status: "active"` with no indexability treatment (`platform.ts:745-758`). Add a `settings.demo === true` guard → `disallow: "/"` / `[]`. **Do this before** reseeding `demo-basket`, which currently 404s — so the signup wizard's Preview button sends every prospect to a dead page (a conversion bug worth fixing on its own). | `app/robots.ts`, `app/sitemap.ts` |
| C11 | Correct the false claims in `docs/seo-indexing.md:27-31` and `:76` (P20).                                                                                                                                                                                                                                                                                  | `docs/seo-indexing.md`            |
| C12 | Sitemap sharding — **defer.** No cap exists, but 50k products in one store is far beyond anything hosted, and the query is `unstable_cache`d at 300s. Revisit near ~20k products with keyset paging (the `getCatalogSnapshot` pattern).                                                                                                                    | `app/sitemap.ts`                  |

---

## 4. Re-index cadence — the concrete answer

### What Google does and does not let you control

|                                       | Reality                                                                                                                                                                                             |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Instant indexing**                  | **Does not exist for this content.** The Indexing API is restricted to `JobPosting` and `BroadcastEvent`; using it for general pages violates its terms. There is no Google equivalent of IndexNow. |
| **Crawl rate**                        | **Not settable.** The GSC crawl-rate tool was retired. Google decides, based on server response time and how often it finds real changes.                                                           |
| **`changefreq` / `priority`**         | **Ignored entirely.** Leave them; never reason about them.                                                                                                                                          |
| **`lastmod`**                         | **Used — conditionally.** Only when consistently accurate; discarded **site-wide** when values look fabricated. This is your only real freshness lever, and it is currently broken (P4).            |
| **`sitemaps.submit`**                 | A one-time **registration** call, not a nudge. Repeat submits of the same sitemap are rate-limited/ignored. Submit each sitemap **once**.                                                           |
| **URL Inspection → Request indexing** | Manual, ~10/day, for a single important page. Not automatable.                                                                                                                                      |

### Sitemap route freshness — no cron needed, and no change from 3600

`export const revalidate = 3600` (`app/sitemap.ts:18`) is **dead config**: `:68-69`
awaits `headers()` — necessarily, the sitemap is per-host — which forces the route
dynamic. Live headers confirm `cache-control: public, max-age=0, must-revalidate`.
**Delete the line and its comment**; do not try to make it work.

Real staleness is already bounded by the tagged `unstable_cache` reads
(`REVALIDATE = 300` in `lib/storefront/queries.ts:50` and `lib/help/queries.ts`)
plus `revalidateTag` on every publish — so **the sitemap reflects a publish within
≤5 minutes**, which is already better than any cron would give you.

Note `revalidateTag(tag, "max")` is stale-while-revalidate, so the _first_ fetch
after a publish can serve the previous list. If that ever matters, warm it with
`after(() => fetch(sitemapUrl))` from the publish action — **not** `updateTag`,
which throws outside a Server Action (error E872) and forces a blocking
revalidate onto the next visitor.

### `lastmod` — derive from these columns, and only these

| URL class                           | Today                   | Set `lastmod` from                              |
| ----------------------------------- | ----------------------- | ----------------------------------------------- |
| Store `/`                           | `now` (`:116`)          | homepage sentinel's `published_at`              |
| Store `/shop`                       | `now`                   | `MAX(products.content_updated_at)`              |
| Store `/blogs`                      | `now`                   | `MAX(blogs.published_at)`                       |
| Store `/enquiries`                  | `now`                   | **omit** — better, drop the URL (C4)            |
| Product `/shop/{slug}`              | `now` (`:137`)          | **`products.content_updated_at`** (new column)  |
| Blog `/blogs/{slug}`                | `published_at` (`:152`) | `updated_at ?? published_at`                    |
| Page `/{slug}`                      | `updated_at` (`:162`)   | **`published_at`**                              |
| `help/` hub                         | `now` (`:78`)           | `MAX(helpArticles.updatedAt)`                   |
| `/help/{category}`                  | `now` (`:85`)           | `MAX(helpArticles.updatedAt)` in that category  |
| `/help/{cat}/{slug}`                | `updatedAt` ✅          | unchanged — already correct                     |
| Platform `/`, `/signup`, `/legal/*` | `now` (`:105`)          | **omit**, or the legal version's effective date |

Two subtleties that make the naive fix wrong:

- **`products.updated_at` is bumped by `_recompute_stock_aggregate` on every
  sale** (`supabase/products_categories.sql:128-131`). Shipping it raw claims a
  content change per purchase — nearly as untruthful as `now`. Add a column bumped
  only by `product-actions` writes, or exclude the stock-aggregate path from the
  trigger. Also `getPublishedProducts` (`queries.ts:113-141`) selects no
  timestamp — add it inside the existing `unstable_cache`, so this costs no extra
  query.
- **`store_pages.updated_at` is not a real publish date.** A BEFORE-UPDATE trigger
  (`store_pages.sql:42-45`) plus `savePageDraft` writing `sections` on every
  autosave debounce (`page-actions.ts:376`) means a merchant editing an
  _unpublished draft_ for an hour advances the _published_ page's lastmod dozens
  of times while the public HTML never changes. Use `published_at`.

**Add this regression test: two `sitemap()` calls with unchanged data must produce
identical `lastModified` values.** That one assertion prevents this class of bug
forever.

### Ping cadence — which event, which channel

IndexNow reaches Bing / Yandex / Naver / Seznam and **explicitly not Google**
(`search-engines.ts:16-18`). It accepts up to 10,000 URLs per request, one host
per request. Google's channel for all of this is the sitemap.

| Event                       | IndexNow                                     | Google               | Today                                                                                                              |
| --------------------------- | -------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Product publish / unpublish | ✅ single URL                                | —                    | ✅ `product-actions.ts:309`                                                                                        |
| Bulk product toggle         | ✅ batch from `.returning()`                 | —                    | ❌                                                                                                                 |
| Blog publish (editor path)  | ✅                                           | —                    | ❌ only the list-row toggle pings                                                                                  |
| Page publish                | ✅                                           | —                    | ✅ `page-actions.ts:459`                                                                                           |
| Page meta / slug change     | ✅ new URL                                   | —                    | ❌                                                                                                                 |
| Help article publish        | ✅ **3 URLs** (article + category + hub)     | —                    | ⚠️ 1 URL only                                                                                                      |
| Help category create/update | ✅ 1 URL                                     | —                    | ❌                                                                                                                 |
| Store creation              | ✅ homepage **+ all seeded published slugs** | ✅ sitemap, **once** | ⚠️ homepage only                                                                                                   |
| Custom domain `false→true`  | ✅ new origin                                | ✅ new sitemap       | ❌ — **and only after A1**, or you ping a host whose `keyLocation` key file is unreachable, which IndexNow rejects |
| Each sitemap, ever          | —                                            | ✅ **exactly once**  | ❌ only `store-signup.ts:372`                                                                                      |

**Do not** wire `submitSitemapToGoogle` into per-publish paths. It re-registers a
file Google already re-reads on its own schedule; per-save calls are rate-limited
and buy nothing. If you do it anyway, debounce ≥6h per sitemap URL.

### The one new cron

⚠️ Gated on **A0** — confirm Cloud Scheduler jobs exist at all first.

|                  | Value                                                                                                                                                                                                                                                                                               |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Route            | `app/api/cron/seo-refresh/route.ts` — copy the Bearer `CRON_SECRET` pattern from `plan-expiry`                                                                                                                                                                                                      |
| Schedule         | **`0 2 * * *`** (daily, 02:00 UTC / 07:30 IST) via Cloud Scheduler                                                                                                                                                                                                                                  |
| Lookback         | **25 hours** — a deliberate 1h overlap on a 24h cadence, so a slow or skipped run never leaves a gap                                                                                                                                                                                                |
| Job 1            | IndexNow-ping every URL whose content timestamp moved in the last 25h, grouped **one request per host** (catches anything an inline ping missed)                                                                                                                                                    |
| Job 2            | Re-submit the platform + help sitemaps to Search Console **only if >7 days since last submit** — a keep-alive, nothing more                                                                                                                                                                         |
| Job 3            | Re-check every `custom_domain_verified = true` domain; flip false on failure (`setCustomDomainVerified` already exists at `store-domain.ts:213-241`) and `revalidateTag(STORE_TAG)`. **This is the durable half of A1** — nothing currently re-verifies a domain that verified once and later broke |
| Do **not** build | Hourly Google sitemap resubmission. Zero effect.                                                                                                                                                                                                                                                    |

---

## 5. Human steps code cannot do

1. **Verify the three existing Cloud Scheduler jobs exist** —
   `gcloud scheduler jobs list --project=storemink-prod`. If they were never
   created, `send-emails` is dead and the whole notification queue is stalled.
   Bigger than any SEO item here.
2. **Confirm `_GOOGLE_SEARCH_CONSOLE_PROPERTY=sc-domain:storemink.com` on the prod
   Cloud Build _trigger_** — not the service. `cloudbuild.yaml:56` documents that
   `--set-env-vars` replaces the whole set, so a console-pasted value is wiped by
   the next deploy.
3. **Add `storemink-run@storemink-prod.iam.gserviceaccount.com` as a user on the
   Search Console property** (Settings → Users and permissions). The code
   authenticates via ADC; without the grant, `sitemaps.submit` fails forever.
4. **Hand-submit `https://storemink.com/sitemap.xml` and
   `https://help.storemink.com/sitemap.xml` once** in Search Console. One-time
   registration is the whole win; the code never submits either. Your Domain
   property already covers `help.` and every `{slug}.` subdomain.
5. **Set `storemink.com` as the website field on LinkedIn, YouTube and
   Instagram.** `sameAs` (B2) is your _claim_; the reciprocal link is what lets
   Google confirm the entity. This is the other half of B2 and the
   highest-leverage non-code action for goal 1.
6. **Register IndexNow in Bing Webmaster Tools** (import from Search Console —
   one click). Every ping the codebase fires goes to Bing/Yandex and you have zero
   visibility into whether they're accepted. No `msvalidate` TXT exists today.
7. **Add GA4 or Plausible to `app/layout.tsx`, gated on `SEARCH_INDEXABLE`**
   (matching `robots.ts:13`). There is no analytics of any kind in the repo — you
   cannot currently tell whether "storemink" traffic is arriving.
8. **Decide `wholesip.com`'s fate** — repoint DNS at the load balancer and
   complete Resend verification, or clear `custom_domain` in prod. A1 restores
   that store to its subdomain, but the merchant's stated domain stays broken.
9. **Reseed `demo-basket` in prod** from the platform Themes panel, after C10 —
   the signup theme step's Preview button currently opens a 404.
10. **Write help articles.** Goal 3 is 100% content-blocked.
11. **Get 3–5 real inbound links** (Product Hunt, a Shopify-alternatives listing,
    YouTube descriptions, GitHub profile, LinkedIn posts). The only remaining
    input to a brand query once the site is fully indexed, and the only one that
    takes calendar time.
12. **Get the legal policy text lawyer-reviewed** before taking real money
    (CODEBASE.md §25). Not SEO — but B13 makes those pages publicly indexed.

---

## 6. Still left to scan

Three of the eight planned audit dimensions **did not complete their
verification pass** (the agents hit a session limit mid-run), so their findings
were dropped rather than reported unverified. Partial coverage leaked in from
neighbouring dimensions — which is why P7 (apex canonical) and P5 (help content)
appear above — but these three were not scanned to depth:

| Dimension                          | What it was going to check                                                                                                                                                                                                                                                                                                                                                      | Why it matters                                                                                                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Per-page metadata & canonicals** | An exhaustive route-by-route table of `title` / `description` / `alternates.canonical` / `openGraph` / `robots` across _every_ public page; `metadataBase` correctness; title-length and duplicate-title sweeps; whether `noindex` meta (not just robots.txt) is present on `/checkout/**`, `/dashboard/**`, `/pos/**`, `/auth/**`, customer `orders`/`notifications`/`profile` | robots.txt Disallow does **not** prevent indexing of a linked URL. Only the dedicated pass can tell you which private routes are actually protected vs merely blocked from crawling |
| **Help centre depth**              | Whether the empty sitemap is genuinely "no content" or a **swallowed DB error** (every sitemap read is `.catch(() => [])`); orphaned-article risk (in the sitemap, linked from nowhere); whether a category rename changes article URLs and leaves 404s with no redirect; whether `/help` vs `/` on the help host is handled by more than a canonical                           | A category rename silently 404-ing every article under it would be an indexing disaster, and the swallowed-error question changes whether A4 is "write content" or "fix a bug"      |
| **Core Web Vitals & crawl health** | Font loading cost (7 families are declared in `app/layout.tsx`); raw `<img>` vs `next/image` on public pages; LCP priority on hero sections; whether the landing page and help pages are statically generated or dynamic per-request; `public/themes/` asset weights; redirect chains and status codes                                                                          | CWV is a real ranking input, and P15 (a 3.17 MB "icon") suggests asset discipline has not been audited at all — there may be more of the same                                       |

Two further things I could not settle from this machine:

- **Whether the prod Cloud Run service actually has
  `GOOGLE_SEARCH_CONSOLE_PROPERTY` set.** `gcloud` is installed but the
  `storemink-prod` project was not readable, so this rests on
  `docs/gcp-ci-cd.md:167` documenting the trigger. A3 makes the answer visible in
  logs; step 2 above confirms it directly.
- **Google's actual index state.** Without Search Console access I can only
  observe that a search for "storemink" returns nothing related. The Coverage and
  Sitemaps reports will say whether the cause is "not crawled yet" (expected at
  four weeks) or "crawled and excluded" (which would point at P1/P2).

### Suggested order of work

1. **A0** — confirm crons exist (could be a much larger outage than SEO).
2. **A1 + A2** — one commit, same null-store code path. Stops active harm.
3. **Human steps 2, 3, 4, 5** — an afternoon, no code, unblocks the Google channel
   and goal 1.
4. **B2 + B3 + B5 + B6 + B7** — small schema/metadata batch, high goal-1 leverage.
5. **B1** — truthful `lastmod`, plus the regression test. This is the answer to
   "how often does Google re-index"; nothing else moves that needle.
6. **A4** — start publishing help articles; everything for goal 3 is inert until
   then.
7. Re-run the three unfinished audit dimensions above.
8. **B10 + B11** before onboarding merchants at any volume — they protect the
   `*.storemink.com` domain's crawl reputation, and `robots.txt` cannot undo a
   bad first submission.
9. **B17** when you want stores to rank for category terms rather than only brand
   and product names.
