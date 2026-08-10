# Analytics & Search Console — plan

> **Status:** draft v1 (2026-08-10) · **Owner:** Vansh · **Purpose:** how to give
> every merchant their own Google Search Console data, and how to turn
> `/dashboard/analytics` into something a Shopify user would recognise.

These read as two asks. They are one feature split by **data source**: Shopify's
analytics is roughly half order data and half traffic data. StoreMink has rich
order data it doesn't query, and **zero** traffic data. Search Console is the
first acquisition data source available without building our own
traffic-tracking pipeline — which is why it comes first.

---

## 1. Where we actually are

### Search Console — submission only

`lib/seo/search-engines.ts` is entirely **write-side**: `sitemaps.submit`,
`sites.add`, and the two `siteVerification` calls. `searchanalytics` appears
**nowhere in the repo**. There is no clicks/impressions/position/query storage
and no merchant surface.

What already exists and is reusable as-is:

| Piece                                                                        | Where                               |
| ---------------------------------------------------------------------------- | ----------------------------------- |
| `googleAccessToken(scope)` — ADC + JWT, cached 55 min                        | `lib/seo/search-engines.ts:163`     |
| `WEBMASTERS_SCOPE` = `.../auth/webmasters` (full — **already covers reads**) | `:147`                              |
| `https://www.googleapis.com/webmasters/v3/sites/{prop}/…` endpoint shape     | `:138`                              |
| `searchconsole.googleapis.com` enabled in `storemink-prod`                   | `docs/cron-jobs.md:63-77`           |
| `storeOrigin(store)` — the one origin selector                               | `lib/site.ts:45`                    |
| Per-store settings + reconciliation state machine                            | `lib/seo/store-indexing.ts`         |
| Daily cron with `CRON_SECRET` + 503 retry contract                           | `app/api/cron/seo-refresh/route.ts` |

So: **no new dependency, no new OAuth scope, no new API to enable, no new auth
code.** `searchAnalytics.query` sits on the identical host and version prefix as
the sitemap call we already make.

### Analytics — order data, all-time, no date range

`app/dashboard/analytics/` is 4 files / 1,075 lines. One exported function,
`getAnalyticsData(storeId)` (`data.ts:125`) — a single `withService` transaction
running 10 queries, none of which takes a date range. 10 widgets, a dnd-kit
canvas, layout in `localStorage`.

**Absent:** sessions, visitors, pageviews, referrers, conversion rate, AOV, units
sold, repeat-vs-new customers, cohorts, channel split, location split, coupon
attribution, returns reporting, inventory velocity, any date picker, any
comparison beyond current-calendar-month vs previous.

**Present in the schema and never queried:** `orders.sales_channel`,
`orders.location_id`, `orders.payment_method`, `orders.applied_coupon_code`,
`orders.customer_id`, `order_items.quantity`, the whole `stock_movements`
ledger, `order_returns`, `order_refunds`, `order_payments`.

---

## Part A — Search Console per store

### A1 ★ The unlock: one Domain property, filtered per store

`sc-domain:storemink.com` is a **Domain property**, so Google aggregates every
subdomain under it — and `searchAnalytics.query` can **filter by the `page`
dimension without grouping by it**. One property therefore yields per-store data
for every subdomain store.

Consequences worth being explicit about, because they decide the whole shape:

- **Zero merchant setup.** No verification, no property, no pasted token, no
  waiting. A store gets search data the moment it has any.
- **Historical data may already exist for established stores.** Search Console
  can return historical search data for hosts and URLs that already have search
  activity, subject to Google's available data window. A brand-new or unindexed
  store may legitimately have none — so the widgets need an honest empty state,
  not zeros. Do not assume every newly created store arrives with useful history.
- **It is a differentiator.** Shopify does not surface Search Console data in its
  admin at all. "Here are the Google searches that found your shop" is a
  retention hook, and it costs one cron and one table.
- **Custom-domain stores are already handled.** `store-indexing.ts:161-245`
  creates a URL-prefix property (`https://domain/`) and verifies it via META.
  Query that property directly, no filter needed.

### A2 ★★ The filter must be an anchored regex, not `contains`

This is the one place this feature can leak one merchant's data into another's
dashboard, so it goes first.

`operator: "contains"` with expression `mink.storemink.com` also matches
`https://supermink.storemink.com/` — the substring starts at index 5. Slugs are
merchant-chosen, so this is reachable by anyone who picks a slug ending in
another store's slug.

Use `includingRegex` (RE2), anchored, with the host regex-escaped:

```ts
// lib/seo/search-performance.ts — pure, tested
export function pageFilterForOrigin(origin: string) {
  const host = new URL(origin).host;
  return {
    dimension: "page",
    operator: "includingRegex",
    expression: `^https://${host.replace(/[.\\+*?[^\]$(){}=!<>|:#-]/g, "\\$&")}/`,
  };
}
```

Dots in `storemink.com` are the reason escaping is not optional. Test both
directions: `mink` must match its own URLs and must **not** match
`supermink.storemink.com`.

### A3 Ingest: upsert a trailing window, never append

GSC data is **revised for ~3 days** after the fact and lags ~2 days. An
append-only ingest therefore stores figures Google has since corrected.

```sql
-- supabase/search_metrics_01_schema.sql
create table if not exists store_search_metrics (
  store_id     uuid not null references stores(id) on delete cascade,
  date         date not null,
  dimension    text not null,              -- 'total' | 'query' | 'page' | 'country' | 'device'
  key          text not null default '',   -- '' for 'total'
  clicks       int  not null default 0,
  impressions  int  not null default 0,
  position_sum numeric(12,2) not null default 0,   -- position × impressions
  primary key (store_id, date, dimension, key)
);
create index if not exists store_search_metrics_store_date_idx
  on store_search_metrics (store_id, date desc);
```

Each run re-fetches the last **5 days** and `ON CONFLICT … DO UPDATE`, which
makes the sweep idempotent and self-correcting — the `increment_coupon_usage`
posture applied to a read pipeline.

Two derivation rules:

- **★ CTR is never stored.** It is `clicks / impressions`. A stored CTR that
  disagrees with its own numerator is a bug with no recovery path.
- **★ Position is stored as `position × impressions`, not position.** Averaging
  average-positions across days or queries is arithmetically wrong: position 3 on
  10,000 impressions and position 40 on 5 impressions do not average to 21.5.
  Store the weighted sum, divide by impressions at read time.

RLS: service-role writes only, `is_store_admin(store_id)` for reads — the
`email_logs` pattern (`supabase/email_logs.sql`).

#### ★ A migrating store queries BOTH properties and combines (decided)

When a merchant moves from `https://store.storemink.com` to
`https://merchantdomain.com`, their history lives under the Domain property and
their new traffic under the URL-prefix property. Accepting the break would make a
merchant's search traffic appear to **vanish on the day they upgraded** — the
worst possible moment to hand someone an empty chart. So ingest queries both and
sums them into the same store's rows.

**★ Double-counting is prevented by the A2 filter, not by a dedupe pass.** The
Domain-property query always carries its anchored `^https://store\.storemink\.com/`
page filter, and the URL-prefix property only ever returns URLs under the custom
domain — so the two result sets are **disjoint by construction**. This is a
second reason the anchored regex is not optional: drop it and the Domain
property starts returning custom-domain URLs too, and every figure doubles.

Two implementation rules follow:

- **Combine before the upsert, never upsert twice.** The primary key is
  `(store_id, date, dimension, key)`, and for `dimension = 'total'` the key is
  `''` — so two sequential upserts for one date would have the second overwrite
  the first rather than add to it. Sum the two properties' rows in the ingest,
  then write once. `page`-dimension keys are full URLs and cannot collide, but
  they must go through the same path so there is only one write shape.
- **Mark the boundary rather than hiding it.** `google_site_verified_at`
  (already written by `store-indexing.ts`) is the migration date; the chart
  annotates it so a step change in impressions reads as "you changed domain
  here" instead of an unexplained cliff.

Query both for as long as the Domain property still returns data for the old
subdomain. Once it goes quiet the extra call is wasted, so skip it when the
subdomain has returned zero impressions for a full ingest window.

### A4 Volume — cap the dimension rows, not the totals

Naively storing top-100 queries + top-50 pages + countries + devices is ~175
rows/store/day → **64M rows/year at 1,000 stores**. Not worth it.

- `dimension = 'total'`: **daily**. 1 row/store/day = 365k/year at 1k stores.
  Cheap, and it is what the headline cards and the trend chart read.
- `query` / `page`: **top 25, weekly grain**. A small merchant does not have 100
  meaningful queries, and the API explicitly "does not guarantee to return all
  data rows but rather top ones" anyway.
- `country` / `device`: top 10 / all 3, weekly.

**★ These are the INITIAL storage policies, not architectural limits.** The
`(store_id, date, dimension, key)` primary key already accommodates daily
query-level rows and any number of keys per day — raising `query` to top 50 or
100, or moving it to a daily grain, is a constant change plus a backfill, **not a
schema redesign**. Keep the row caps and per-dimension granularity in one
constants module (the `lib/import-export/limits.ts` posture) rather than inlined
at the call sites, so the ceiling can be raised — globally or per plan — without
touching the ingest or the read path. The API's own "top rows only" behaviour is
the real ceiling on `query`/`page` fidelity; ours should sit below it by choice,
not by accident.

Add a `RETENTION_POLICIES` entry in `lib/retention/prune.ts` (§32) — 16 months,
matching Google's own window so a merchant never sees less than GSC shows.

### A5 The cron must be resumable

Per store this is ~2–3 API calls (totals-by-date, top queries, top pages).
At 1,000 stores that is 3,000 calls. Rate is fine — Search Analytics allows
**1,200 QPM per site** and 40,000 QPM per project — but `seo-refresh` has
`maxDuration = 300` and `CONCURRENCY = 4`, so 3,000 calls at ~300ms each is
~225s. That is inside the budget today and outside it next year.

**★ A separate cron, not an extension of `seo-refresh`.** Two reasons: that
route's 503 contract means a failed metrics read would make sitemap submission
look broken to Cloud Scheduler, and its `SELECT … WHERE status = 'active'` has
no pagination — piling a second concern onto that makes an existing latent
problem worse.

`/api/cron/search-metrics`, daily at `30 2 * * *` (after `seo-refresh` at
`0 2`), built like the import worker: a cursor + lease, self-chaining while work
remains, so it resumes rather than silently truncating the fleet. Register it in
Cloud Scheduler — `docs/cron-jobs.md` records that deploying a route does not
schedule it, and that three jobs sat undeployed for months.

**★ Skip the same stores `seo-refresh` skips**: not `active`, not launched
(`isStoreLaunched`), or `settings.demo === true`. An unindexed store has no data
and burns a call to find that out.

### A6 What the merchant sees

No new page. The widget registry already does this — add entries to `WIDGETS`
(`analytics/widgets.ts:32`) and nodes to the `slots` map (`analytics/page.tsx:34`)
under a new `"Search"` group:

| Widget               | Content                                                  |
| -------------------- | -------------------------------------------------------- |
| `search_clicks`      | Clicks from Google, trend vs previous period             |
| `search_impressions` | Impressions, trend                                       |
| `search_position`    | Average position (impression-weighted), trend            |
| `search_queries`     | Top 25 search terms — clicks, impressions, CTR, position |
| `search_pages`       | Top landing pages from search                            |

Gate on the existing `analytics` section. **Do not plan-gate it** — it costs one
cron and it is the cheapest acquisition data on the platform; making it Pro-only
trades a retention hook for very little revenue.

### A7 Also surface indexing health — near-zero work, real hole

`google_indexing_error` is persisted by `store-indexing.ts` and **shown to
nobody** — not the merchant, not an operator. Today the only way to learn a
store's sitemap submission has been failing for a month is a direct DB query.

One card (on `/dashboard/settings/domain`, or a small `/dashboard/seo`) reading
the seven keys already written: verified state, sitemap submitted at, last
attempt, last error. Pair it with the operator-side view in
`/dashboard/failures` (§33) — this is exactly the "everything that didn't work"
feed, and `FAILURE_SOURCES` is a registry of reads, so it is one entry.

### A8 Pre-existing gaps this work should close

Found while mapping; each one degrades the feature above.

1. **`lib/domains/reconcile.ts:366` flips `custom_domain_verified` without
   calling `ensureGoogleCoverageForStore`.** Only the interactive
   `verifyDomain()` action triggers coverage (`store-domain.ts:431`). Since §30
   moved domain completion to the cron precisely because merchants close the tab,
   the common path is now the one that never registers the property — so a
   custom-domain store gets no Search Console property, and therefore no search
   data, until the next `seo-refresh`. One `after()` call.
2. **Nothing calls `sites.delete` / `webResource.delete` on disconnect.**
   `store-domain.ts:461` drops the DB keys and leaves Google's ownership record
   and URL-prefix property behind. `docs/seo-indexing.md:79-82` documents a
   1,000-property account limit; without deletion that limit is a one-way
   ratchet.
3. **`googleAccessToken` caches on a fixed 55-minute TTL**, not the token's own
   `expires_in` (`:178-179` admits it). Fine today; it is the kind of thing that
   fails at 3am once a scope changes.

### A9 What to promise, and what not to

Read `docs/seo-action-plan.md:277-282` before writing merchant-facing copy.

- Data is **~2 days behind**. Say so on the card. `dataState: "all"` returns
  fresher partial data if we want it, clearly labelled.
- **Rare queries are omitted** by Google for privacy, so query-level clicks will
  not sum to the total. Show the total from `dimension = 'total'`, never from
  summing queries.
- **Impressions ≠ sessions.** These are search-surface numbers. Conversion rate
  is not derivable from them — that is Part B Phase 3.
- **URL Inspection is not viable per store.** Its quota is **2,000 QPD per
  site**, and every subdomain store shares one site. Don't build on it.

---

## Part B — Shopify-like analytics

### B1 ★ Phase 1 is a date range, and it is load-bearing

Every other item here depends on it, and it is the change that touches
everything: `getAnalyticsData(storeId)` becomes range-aware, which means
splitting the 404-line monolith into per-widget async functions so widgets can
stream under `Suspense` instead of blocking on one 10-query transaction.

- `?range=30d|90d|12m|custom&from=&to=`, following the only date filter that
  exists in the dashboard today — the `<select>` at
  `app/dashboard/logs/activity-feed-view.tsx:117`.
- **Comparison = previous equal-length window**, not "previous calendar month".
  This also fixes a real bug: `stats` mixes time bases — `revenue.value` is
  all-time, `orders.value` is this month, `customers.value` is lifetime — and
  all four render a month-over-month `trendPct` (`data.ts:196-209`). A
  percentage next to an all-time total is meaningless.
- Default to **30 days**, which is what the metric cards should have said all
  along.

### B2 Fix these while you are in there

- **★ Revenue is divided by 1000 and rounded** for the chart series
  (`data.ts:114`, `:213`). Any month under ₹500 renders as **0**. A new store's
  first month reads as zero revenue.
- **★ Revenue counts unpaid orders.** The only filter is `status != 'cancelled'`
  (`data.ts:135`), so a pending Razorpay order that will be reaped by
  `expire-pending-payments` is booked as revenue. Decide and label:
  headline = paid, net of settled refunds (`order_refunds`); show booked
  separately if wanted. There is even a partial index for the pending case
  (`schema.ts:1294`).
- **★ Delete the dead fake widgets.** `product-performance.tsx` hardcodes
  `$12,450` and `conversion: "4.2%"`; `inventory-health.tsx` hardcodes "Smart
  Watch Series 5"; `operational-health.tsx` hardcodes all-Healthy. None are
  imported anywhere. A hardcoded conversion rate in the tree is a landmine — it
  is exactly the string someone will wire up to a slot in a hurry.

### B3 Phase 2 — widgets from columns you already have

No schema change, no tracking. This is the best value-to-effort ratio in the
document, and it is most of what a merchant means by "Shopify-like".

| Widget                   | Source                                                           |
| ------------------------ | ---------------------------------------------------------------- |
| AOV                      | `sum(total) / count(*)`                                          |
| Units sold               | `order_items.quantity` — exists, never summed                    |
| Top products (units + ₹) | `order_items` grouped by `product_id` — replaces the fake one    |
| Sales by channel         | `orders.sales_channel` — online vs POS, already written          |
| **Sales by location**    | `orders.location_id` — the roadmap's outstanding item (§510)     |
| Sales by payment method  | `orders.payment_method`                                          |
| New vs returning         | first `orders.created_at` per `customer_id`                      |
| Discount impact          | `orders.discount` + `applied_coupon_code` × `coupons.used_count` |
| Returns & refunds        | `order_returns`, `order_refunds` — return rate, refund value     |
| Inventory velocity       | `stock_movements` — a clean per-SKU ledger, read zero times      |

**★ Profit/margin is NOT computable and should not be promised.**
`products.base_price` is labelled **"Base price ₹ (MRP)"**
(`product-editor-form.tsx:867`) and validation enforces
`selling_price <= base_price` (`:521`) — it is the struck-through compare-at
price, not cost. A real margin report needs a new nullable `cost_price` column
and a merchant willing to fill it in. Worth doing eventually; it is its own
feature, not a query.

### B4 Phase 3 — traffic, the expensive one

This is the half that makes the page feel like Shopify's, and there is no way to
fake it. **Conversion rate = orders / sessions**, and sessions do not exist.

- **★ It must be a client beacon.** Storefront pages are ISR
  (`app/(storefront)/page.tsx:30`, `revalidate = 300`), so a server-side counter
  in a page component fires once per revalidation, not once per visitor. And
  `proxy.ts` deliberately keeps the storefront path free of per-request DB work,
  so counting there is out. `POST /api/t` via `navigator.sendBeacon` — API routes
  are excluded from the proxy matcher (`proxy.ts:316`), so ingest is cheap.
- **★ Cookieless, but privacy-aware — not privacy-settled.** Visitor id =
  `sha256(ip + user-agent + store_id + daily_salt)`, truncated, salt rotating at
  midnight IST. Nothing is stored on the user's device, which minimises tracking
  and avoids client-side identifiers entirely. **But the resulting identifier is
  still pseudonymous data derived from an IP address, and should be treated as
  potentially personal.** Being cookieless or hashed does not by itself settle the
  legal position. StoreMink must separately document, per jurisdiction: the
  processing purpose, the retention period, the legal basis, the user-facing
  disclosure, and any applicable consent or opt-out requirement — and that
  belongs in the §25 legal machinery (a platform privacy-policy version and a
  merchant-facing store policy), not in a code comment. Get counsel on it before
  this ships, the same posture §25 and §28 already take. Technically it is
  Plausible's model, so the trade is well-trodden: no cross-day visitor identity,
  no cohort-by-first-visit.
- **Two tables.** `storefront_events` (raw, pruned at 7–14 days via §32) and
  `storefront_daily` (rollup, long retention). Roll up nightly; every read hits
  the rollup. The raw table is the only high-write object this feature adds, and
  aggressive pruning is what keeps it affordable.
- **Funnel events:** `page_view`, `product_view`, `add_to_cart`,
  `checkout_start`, `purchase`. `add_to_cart` hooks
  `CartProvider.addItem`; `checkout_start` on `/checkout` mount.
  **★ `purchase` is emitted server-side from `placeOrder`**, never from the
  client — the conversion numerator must not be forgeable, and a client that
  navigates away mid-redirect would silently under-count.
- **★★ Event idempotency is REQUIRED, and the database enforces it.** Every event
  that can be retried or replayed needs a deterministic idempotency key. For
  `purchase` that key is the **order id** (one order is one purchase, forever), on
  a **UNIQUE constraint** — not an application-level check-then-insert, which is
  invariant 3 and is bypassed by the exact concurrency it is meant to guard. This
  is not hypothetical: server-side emission runs inside a request that Cloud Run
  can retry, `placeOrder` already carries a manual rollback chain, and
  reconcile-on-read (§18) plus the `expire-pending-payments` sweep can both touch
  a paid order again later. Without the constraint, **a single retry inflates
  purchases and therefore the conversion rate** — silently, in the direction that
  flatters the merchant, which is the direction nobody questions. `page_view` and
  the funnel steps get the same treatment via a client-generated event id, so a
  `sendBeacon` the browser retries on flaky mobile data cannot double-count a
  session. The insert is `ON CONFLICT DO NOTHING`: a duplicate is a no-op, never
  an error, so a retry must never fail the request that carried it.
- **Cart abandonment falls out of this** without persisting carts server-side.
  Carts are `localStorage`-only today (`CartProvider.tsx`) and a cart that never
  reaches a server cannot be measured; but `add_to_cart` → `checkout_start` →
  `purchase` gives the abandonment rates merchants actually ask for.
- **★ Bot filtering is not optional.** Without a UA denylist and a per-hash rate
  limit, every number is inflated and the conversion rate is quietly wrong —
  worse than absent, because people act on it.
- **Plan-gate this one** (basic+ or pro, `lib/plans.ts`). Unlike Part A it is a
  genuine per-request cost centre.
- **Skip Live View.** Shopify's real-time globe is mostly theatre and needs a
  streaming path nothing else here would use.

### B5 The cheap escape hatch, worth shipping regardless

A `marketing.ga4MeasurementId` / `marketing.metaPixelId` setting
(`lib/settings/registry.ts`) rendered into the storefront `<head>`. About a day
of work. It does not put numbers in our dashboard and it hands the merchant
relationship to Google — so it is **not** a substitute for Phase 3 — but many
merchants already want GA4, and it is a real answer to "where are my analytics?"
for the whole time Phase 3 is unbuilt.

---

## 3. Sequencing

Ordered by value per unit of work, and each step is shippable alone.

| #   | Step                                                                   | Rough size |
| --- | ---------------------------------------------------------------------- | ---------- |
| 1   | Date range + comparison + split `data.ts` (B1) and the three bugs (B2) | M          |
| 2   | Widgets from existing columns (B3)                                     | M          |
| 3   | Search Console ingest + widgets (A1–A6)                                | M          |
| 4   | Indexing-health card (A7) + the three gaps (A8)                        | S          |
| 5   | GA4/Pixel setting (B5)                                                 | XS         |
| 6   | Traffic pipeline: beacon, rollup, funnel, conversion (B4)              | L          |
| 7   | `cost_price` + margin reporting (B3 note)                              | M          |

Step 1 before step 2 — every widget in step 2 needs the range, and adding them
first means rewriting them. Step 3 is independent of both and can run in
parallel.

---

## 4. Open decisions

- **Revenue definition** for the headline number: paid-net-of-refunds, or booked?
  This changes every figure on the page and should be decided once, not per
  widget.
- **Layout persistence**: `localStorage` per browser today
  (`dashboard-canvas.tsx:64`). Server-persist it, or keep it a personal
  preference? The swap points are already named in that file.
- **Traffic analytics plan gate**: basic+ or pro-only?
- **Search data for unlaunched stores**: there is none, so the widgets need an
  honest empty state rather than zeros — zeros read as "nobody found us".
  _(Custom-domain history discontinuity was open in an earlier draft and is now
  decided — see A3, "A migrating store queries BOTH properties and combines".)_

---

## 5. Invariants this plan obeys

From `docs/roadmap.md`:

1. **A migration may not change what a live store does.** Every new widget is
   additive; new settings default to today's behaviour.
2. **Nothing cached is authoritative.** The metrics table is a cache of Google's
   numbers — re-ingested and self-correcting, never the source of truth.
3. **A disabled control is not a permission.** Range and store scope are
   re-derived server-side; `store_id` is never read from the client.
4. **Absence is not restriction.** A location-unbound admin sees every
   location's figures in the location split.
