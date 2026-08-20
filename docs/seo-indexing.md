# SEO & search indexing

How StoreMink makes the platform and every launched merchant store eligible,
discoverable, and observable on search engines.

## What the system guarantees — and what Google decides

The application guarantees that an eligible public page has a crawlable host,
a self-consistent canonical URL, accurate metadata/JSON-LD, internal links, and
an automatically registered sitemap. Every failed Google setup is persisted on
the store and retried by the daily reconciliation job.

Google still decides whether and when to crawl or index a URL, how it ranks, and
whether a new coined brand name is spell-corrected. Google explicitly says that
crawling can take days to weeks and that a sitemap does not guarantee indexing.
The general-purpose Indexing API cannot be used here: it is restricted to
`JobPosting` and livestream `BroadcastEvent` pages.

## Automatic pipeline

| Piece              | File                                              | Behaviour                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------ | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host gate          | `lib/store/host.ts` + `proxy.ts`                  | Only the real `storemink.com` production build is indexable; `www` permanently redirects to the apex. Staging, previews, and local dev emit noindex/empty sitemaps and never notify engines.                                                                                                                                                                                      |
| Search eligibility | `lib/store/launch.ts`                             | `isStoreSearchIndexable()` is the one gate shared by storefront metadata, robots, sitemaps, and Google/IndexNow notifications. It requires a launched, non-demo store.                                                                                                                                                                                                            |
| `robots.txt`       | `app/robots.ts`                                   | Per host, shares the same utility/private-path disallow registry as the sitemap and advertises the host's canonical sitemap. Unknown hosts are closed. Demo and unlaunched public pages remain crawlable so bots can observe their `noindex`; they advertise no sitemap.                                                                                                          |
| `sitemap.xml`      | `app/sitemap.ts`                                  | Per host: platform marketing/legal pages, the dedicated POS product page, help content, themes, or the current store's homepage, product/blog hubs, products, blogs, and published custom pages. `lastmod` is derived from real content timestamps. The Help branch fails with 5xx rather than serving a false empty sitemap when its authoritative published-article read fails. |
| Canonicals         | route metadata + `lib/site.ts`                    | Uses a verified **and currently entitled** custom domain; otherwise `{slug}.storemink.com`. This matches the serving gate, including timed-plan expiry.                                                                                                                                                                                                                           |
| Merchant identity  | `app/(storefront)/components/structured-data.tsx` | Organization/WebSite graph using merchant name, legal name, logo, description, email, phone, and valid social profile URLs. Product and blog nodes point to the same Organization `@id`.                                                                                                                                                                                          |
| StoreMink identity | `lib/seo/brand-identity.ts`                       | One StoreMink Organization entity shared by the apex and help host, with alternate spellings, official profiles, contact point, and visible matching links.                                                                                                                                                                                                                       |
| Publish hook       | `lib/seo/store-indexing.ts` + `help-actions.ts`   | Products (including bulk publish), blogs (editor, bulk, customer direct-publish, approval), and builder pages all launch the store, notify IndexNow, and ensure Google coverage after the content write commits. Publishing a Help article notifies IndexNow and immediately re-submits the Help sitemap to Google.                                                               |
| IndexNow           | `lib/seo/search-engines.ts`                       | Groups URLs by host and notifies participating engines. This does **not** reach Google.                                                                                                                                                                                                                                                                                           |
| Google             | `lib/seo/store-indexing.ts`                       | StoreMink subdomains submit under `sc-domain:storemink.com`. Verified custom domains are META-verified automatically, added as URL-prefix properties, and get their own sitemap submission. Success/error timestamps are stored in `stores.settings`.                                                                                                                             |
| Reconciliation     | `app/api/cron/seo-refresh/route.ts`               | Daily, authenticated repair pass for the platform, help, POS, and themes sitemaps plus every active, launched, non-demo store. A partial failure returns HTTP 503 so Cloud Scheduler retries it. Successful per-store submissions refresh at most every seven days.                                                                                                               |

Every published Help article must have a category because its canonical URL is
`/help/{category}/{slug}`. The operator actions enforce this with a friendly
validation error and migration `20260820_0009_help_article_indexability` adds
the database constraint. Published Help pages are anonymously readable,
server-rendered, self-canonical, internally linked from their category/topics
tree, included with honest `lastmod` values in the production Help sitemap, and
described with TechArticle + breadcrumb structured data. Search-result pages
remain `noindex` so query permutations cannot create thin duplicate pages.

The Google verification token is deliberately public: it must appear as
`<meta name="google-site-verification">` on the custom-domain storefront. No
OAuth token or service-account credential is stored in the database.

## Launch/readiness rule

A newly created store is shared theme seed, not an indexable business. Signup
writes `settings.launched: false`; its storefront metadata is `noindex,
nofollow` and its sitemap is empty. Public routes remain crawlable because a
robots.txt block would prevent Google from observing `noindex` and could leave
previously discovered seed URLs in results. Utility/private paths remain
disallowed. Publishing the first real product, blog, or builder page calls the
unified publish hook and marks it launched. Legacy stores with no flag are
treated as launched so the rollout cannot deindex existing shops. Demo stores
remain permanently excluded by the same metadata/empty-sitemap path.

## Production Google setup (one time)

1. Verify the `storemink.com` **Domain property** in Search Console. It covers
   the apex, help, POS, themes, and every `{slug}.storemink.com` tenant.
2. Add the production Cloud Run runtime service account
   (`storemink-run@storemink-prod.iam.gserviceaccount.com`) as an Owner/Full user
   on that Search Console property.
3. Keep `_GOOGLE_SEARCH_CONSOLE_PROPERTY=sc-domain:storemink.com` on the prod
   Cloud Build trigger. It becomes `GOOGLE_SEARCH_CONSOLE_PROPERTY`; Cloud Run
   authenticates through ADC, so there is no key file to rotate.
4. Enable the **Google Search Console API** and **Google Site Verification API**
   in the production GCP project. The latter is required only for custom-domain
   URL-prefix ownership.
5. Create the Cloud Scheduler job documented in `docs/cron-jobs.md`. Deploying
   the route alone does not schedule it on Cloud Run.

For a non-GCP host, `GOOGLE_SEARCH_CONSOLE_CREDENTIALS` may contain a service
account key JSON; ADC is preferred in production.

### Custom-domain lifecycle

When StoreMink's certificate + routing verification flips a domain to verified:

1. the background hook requests a Google META token for `https://domain/`;
2. the API's complete META-tag response is reduced to its `content` token,
   stored in public store settings, and rendered once in `<head>` (legacy
   full-tag values are normalized at render and repaired by reconciliation);
3. Google verifies that URL-prefix property;
4. the service account adds it to Search Console and submits
   `https://domain/sitemap.xml`;
5. the cron retries any incomplete step and preserves the last error for
   diagnosis.

Changing or disconnecting the domain first removes the old public verification
token and routing state, then best-effort deletes both the URL-prefix property
from Search Console and this service account's Site Verification ownership.
Missing remote resources count as already clean; API failures are logged without
rolling back the merchant's successful domain change. Google access tokens are
cached only to their returned `expires_in`/ADC `expiry_date`, with an early
refresh margin.
At larger scale, note Search Console's account limit of 1,000 properties: shard
custom-domain ownership across service accounts or move to merchant-authorized
OAuth before approaching that limit. StoreMink subdomains do not consume one
property each because the single Domain property covers them all.

## Scheduling and failure semantics

`/api/cron/seo-refresh` accepts GET or POST with
`Authorization: Bearer <CRON_SECRET>`. It returns:

- `200` only when all four root sitemaps and all eligible stores are ready;
- `503` when any Google operation failed, so Cloud Scheduler's configured
  retries run;
- `401` for a missing/wrong secret;
- `200 { skipped: ... }` on non-indexable environments such as staging.

The per-store settings keys are public operational state:

- `google_site_verification_token`
- `google_site_verification_domain`
- `google_site_verified_at`
- `google_sitemap_submitted_at`
- `google_sitemap_submitted_origin`
- `google_indexing_attempted_at`
- `google_indexing_error`

`/dashboard/settings/domain` presents these keys as one origin-aware Google
Search coverage card: StoreMink Domain-property ownership or custom-domain META
verification, current-origin sitemap submission, last attempt, and last error.
Managers can run the same idempotent reconciliation immediately with **Check
now**; `/api/cron/seo-refresh` remains the unattended backstop. Current errors
also appear in the merchant and operator Failures feeds without copying them to
a second table.

## Verification

```bash
# Production platform
curl -s https://storemink.com/robots.txt
curl -s https://storemink.com/sitemap.xml | head

# Public theme catalog
curl -s https://themes.storemink.com/robots.txt
curl -s https://themes.storemink.com/sitemap.xml | head

# Public POS product site
curl -s https://pos.storemink.com/robots.txt
curl -s https://pos.storemink.com/sitemap.xml | head

# StoreMink tenant
curl -s https://<slug>.storemink.com/robots.txt
curl -s https://<slug>.storemink.com/sitemap.xml | head

# Custom domain (after connection)
curl -s https://<domain>/robots.txt
curl -s https://<domain>/sitemap.xml | head
curl -s https://<domain>/ | grep google-site-verification

# Staging must remain closed
curl -s https://staging.storemink.com/robots.txt
curl -s https://staging.storemink.com/sitemap.xml
```

After deployment, run the Scheduler job manually once and verify a 200 response.
In Search Console, monitor Sitemaps, Pages, Crawl Stats, and individual URL
Inspection. For a small number of urgent pages, URL Inspection's manual
“Request indexing” can ask Google to recrawl sooner; there is no compliant API
for automating that button for ecommerce/product/blog pages.
