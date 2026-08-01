# SEO & search indexing

How StoreMink gets the platform, the fallback store, and every merchant store
discovered and ranked on search engines — and the **one-time human setup** for
Google (everything else is automatic and already in code).

## TL;DR

- **Code is done.** Host-aware `robots.txt` + `sitemap.xml`, per-page metadata +
  canonicals, JSON-LD, OG cards, and auto-notify (IndexNow + Google) all ship.
- **Only production (`storemink.com`) is indexable.** Staging, previews, and
  local dev are auto-`noindex`d and never ping search engines — no flag to set.
  This is derived from the apex domain (`SEARCH_INDEXABLE` in
  `lib/store/host.ts`), so it can't be forgotten and can't accidentally hide prod.
- **One human step for Google** (below): verify the domain in Search Console and
  grant the Cloud Run service account access. IndexNow needs nothing.

## What runs automatically

| Piece             | File                                | Behavior                                                                                                                                                   |
| ----------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `robots.txt`      | `app/robots.ts`                     | Per host: allows `/`, disallows admin/auth/api/cart/profile/etc., advertises the host's own `sitemap.xml` + canonical host. Non-prod → `Disallow: /`.      |
| `sitemap.xml`     | `app/sitemap.ts`                    | Per host: platform apex → marketing pages; a store host → its static pages + all products, blogs, and custom pages (with image entries). Non-prod → empty. |
| Page metadata     | each route's `generateMetadata`     | Title/description/OpenGraph + `alternates.canonical` on the store's own origin.                                                                            |
| Structured data   | `lib/seo/schema.ts` + `<JsonLd>`    | Product / Article / Breadcrumb / Organization / WebSite JSON-LD.                                                                                           |
| OG share cards    | `app/api/og` + `lib/seo/og-card.ts` | Branded default share image.                                                                                                                               |
| **IndexNow**      | `lib/seo/search-engines.ts`         | Pings Bing/Yandex/Naver/Seznam on store create + product/blog/page/help-article publish. **Live in prod, zero setup. Does NOT reach Google.**              |
| **Google submit** | `lib/seo/search-engines.ts`         | `sitemaps.submit` to Search Console — **only from `store-signup.ts`**, i.e. once per new store. See the correction below.                                  |

IndexNow fires via `after()` from the mutation actions (`store-signup`,
`product-actions`, `blog-actions`, `page-actions`, `help-actions`), so a slow or
failed ping never blocks or breaks the user's request. It is gated on
`SEARCH_INDEXABLE`, so staging never pings with non-production URLs (important:
staging runs as `NODE_ENV=production` on Cloud Run).

> **⚠ The two channels are NOT symmetric — an earlier version of this document
> said they were.** `submitSitemapToGoogle` has exactly one non-test call site
> (`app/actions/store-signup.ts`). Publishing a product, blog, page or help
> article notifies IndexNow only. **Google is never actively told anything after
> a store is created**, and neither `storemink.com/sitemap.xml` nor
> `help.storemink.com/sitemap.xml` has ever been submitted — they are discovered
> only through the `Sitemap:` line in each host's `robots.txt`.
>
> That is less bad than it sounds, and mostly by design: `sitemaps.submit` is a
> one-time **registration** call, not a nudge. Repeat submissions of the same
> sitemap are rate-limited and ignored, so wiring it into per-publish paths would
> buy nothing. There is also **no Google equivalent of IndexNow** — the Indexing
> API is restricted to `JobPosting` and `BroadcastEvent`. For Google, the sitemap
> (with an honest `lastmod`) plus internal linking IS the mechanism.
>
> What this means in practice: submit each sitemap **once** by hand (step 4
> below), and keep `lastmod` truthful. See `docs/seo-action-plan.md` §4.

## Indexability is derived, not flagged

`SEARCH_INDEXABLE` (in `lib/store/host.ts`) is:

```ts
ROOT_DOMAIN === "storemink.com" && process.env.NEXT_PUBLIC_NOINDEX !== "1";
```

- **Production** bakes `NEXT_PUBLIC_ROOT_DOMAIN=storemink.com` → indexable. This
  covers the platform, the WholeSip fallback, and every `{slug}.storemink.com`
  and verified custom-domain store.
- **Staging** bakes `staging.storemink.com` → not the apex → auto-`noindex`,
  empty sitemap, no pings. Same for `*.vercel.app` previews and `localhost`.
- `NEXT_PUBLIC_NOINDEX=1` is an optional override to force prod off (e.g. an
  incident) — normally unset.

There is deliberately **no per-deploy `noindex` flag** to remember: keying off the
canonical apex means we can never accidentally leave prod hidden or staging
crawlable.

## One-time Google Search Console setup (do this once for prod)

Goal: verify the domain and let the prod Cloud Run service submit sitemaps —
**with no service-account key to store** (auth is the runtime SA via ADC).

1. **Verify the domain property.** In [Search Console](https://search.google.com/search-console),
   add a **Domain** property for `storemink.com` and complete DNS TXT
   verification (Cloud DNS). A Domain property covers **every** subdomain
   (`www`, `help`, and all `{slug}.storemink.com` stores) in one shot.
2. **Grant the Cloud Run service account access.** In the property → **Settings →
   Users and permissions → Add user**, add
   `storemink-run@storemink-prod.iam.gserviceaccount.com` (the `_RUN_SA` from
   `cloudbuild.yaml`) with the **Owner** (or Full) role. This is the identity the
   prod service already runs as, so its ADC token can call `sitemaps.submit`.
3. **Set the property env on prod.** Already wired: the prod Cloud Build trigger
   passes `_GOOGLE_SEARCH_CONSOLE_PROPERTY=sc-domain:storemink.com`
   (`docs/gcp-ci-cd.md`), which becomes `GOOGLE_SEARCH_CONSOLE_PROPERTY` on the
   service. Nothing to paste. Redeploy prod (or wait for the next `main` push) so
   the env is present.
4. **Submit both root sitemaps once — NOT optional.** In Search Console →
   **Sitemaps**, add `https://storemink.com/sitemap.xml` **and**
   `https://help.storemink.com/sitemap.xml`. Nothing in the code submits either
   (see the correction above), so this is the only time they get registered.
   Google re-reads a registered sitemap on its own schedule afterwards, which is
   why once is enough. Per-store subdomain sitemaps ARE submitted automatically,
   but only at store creation (`store-signup.ts`).

That's it — no key file, no Secret Manager entry, nothing to rotate.

> **Alternative (non-GCP / local):** set `GOOGLE_SEARCH_CONSOLE_CREDENTIALS` to a
> service-account key JSON instead of using ADC. The code prefers this key when
> present and falls back to ADC when it's absent. Not needed on Cloud Run.

### IndexNow — nothing to do

Already active in prod. The public key file is `public/3b7d8ad31a67d0ae436d04d13a099b6c.txt`;
`INDEXNOW_KEY` can override it (the file must match). Set `INDEXNOW_FORCE=1`
locally if you want to test the ping path off prod.

## Caveat: custom domains

Automatic Google submission only covers hosts under the verified
`sc-domain:storemink.com` property — i.e. the apex and all `*.storemink.com`
stores. A merchant on their **own** custom domain (`mystore.com`) is served and
`robots`/`sitemap` are correct, and IndexNow still pings, but Google won't accept
a `sitemaps.submit` for a property we haven't verified. The submit call simply
no-ops for that host (it isn't under our property). Options when this matters:
per-custom-domain Search Console properties + credentials, or rely on IndexNow +
organic crawl + the on-page canonicals/sitemap (which are all present). Not built
in v1.

## Verify it's working

```bash
# Production must be crawlable with a real sitemap:
curl -s https://storemink.com/robots.txt        # → Allow: / …, Sitemap: https://storemink.com/sitemap.xml
curl -s https://storemink.com/sitemap.xml | head

# A store subdomain advertises its own canonical + catalog:
curl -s https://<slug>.storemink.com/robots.txt
curl -s https://<slug>.storemink.com/sitemap.xml | head

# Staging must be fully blocked:
curl -s https://staging.storemink.com/robots.txt   # → Disallow: /
curl -s https://staging.storemink.com/sitemap.xml  # → empty <urlset>
```

In Search Console, watch **Sitemaps** (submitted/last-read) and **Pages**
(indexed count) over the following days. Use **URL Inspection → Request indexing**
to fast-track a specific important page.

> **If staging was ever indexed** (it was crawlable before this change): `robots.txt
Disallow: /` stops future crawling but won't evict pages already in the index.
> Add a Search Console property for `staging.storemink.com` and use **Removals →
> Temporarily remove** (or **Indexing → Remove**) to purge them. Going forward
> nothing new will be indexed.
