# Analytics dashboard & Google Search Console — product and technical spec

> **Status:** proposed v2 (2026-08-14) · **Owner:** Vansh · **Surface:**
> `/dashboard/analytics` · **Purpose:** give every seller a useful default
> dashboard, a Shopify-like dashboard editor, and tenant-safe Google Search
> Console insights on both StoreMink subdomains and merchant-owned domains.

These read as two asks. They are one feature split by **data source**: commerce
data says what sold; storefront analytics says how shoppers behaved; Search
Console says how the store appeared in Google. StoreMink already owns rich order
data it barely queries, has no first-party session data, and has the platform
credentials needed to read Search Console without asking each merchant for a
Google login.

This document supersedes the v1 draft from 2026-08-10. It preserves its useful
implementation findings, but adds the missing product contract, current Shopify
comparison, persistent dashboard model, and a source-aware custom-domain design.

---

## 0. Decisions at a glance

1. **Parity target:** match Shopify's _overview dashboard experience_, not its
   entire report builder in the first release. The first release includes global
   date/comparison controls; metric cards; add/remove/reorder/resize; named
   sections; a searchable library; reset; and server-persisted per-admin layouts.
2. **Useful default before customization:** a new merchant gets an opinionated
   dashboard immediately. Editing is optional and reversible.
3. **One metric contract:** every card on screen uses the same selected range,
   comparison, store time zone, currency, location scope, and sales definition.
   A card may opt out only when its label says so (for example, "Current stock").
4. **Search Console is managed by StoreMink:** merchants do not paste a token or
   connect a Google account. StoreMink reads its verified Domain property for
   `{slug}.storemink.com`; a verified custom domain gets an automatically
   provisioned URL-prefix property.
5. **Domain history follows the store:** subdomain, old custom-domain, and current
   custom-domain metrics are stored as separate sources and summed at read time.
   A domain change must never make the chart reset or let one seller see another
   seller's data.
6. **Layouts are personal:** save by `(store_id, admin_user_id)`, not globally per
   store and not only in `localStorage`. Different staff roles see different
   allowed cards; a layout follows the admin across devices.
7. **Search Console is not traffic analytics:** clicks are not sessions and
   impressions are not visits. StoreMink must not derive conversion rate from
   Search Console. First-party storefront events are a separate later phase.
8. **No forced upgrade of saved layouts:** when a new widget ships, existing
   customized layouts remain unchanged and the widget receives a "New" badge in
   the library. Only untouched/default layouts receive revised defaults.

### 0.1 Shopify baseline checked on 2026-08-14

Shopify's current overview dashboard supports:

- a default overview plus date range, comparison, and currency controls;
- metric cards that open a corresponding detailed report;
- add, remove, drag-reorder, and drag-resize;
- a searchable metric library, with each card present at most once;
- custom labeled sections that can be renamed, reordered, hidden, and deleted;
- explicit Save, Cancel, Reset to default, and desktop-only editing whose result
  is used on mobile;
- later-layer capabilities such as custom reports, targets, and generated
  insights.

StoreMink already has add/remove/reorder, a searchable library, Save/Cancel/Reset,
and a default card registry. It does **not** yet have resize, real sections,
server persistence, a global date/comparison contract, report drill-downs, or
enough commerce/traffic metrics. Calling the current page "Shopify parity" would
therefore be inaccurate.

| Capability                          | Shopify now                 | StoreMink now                       | This spec                               |
| ----------------------------------- | --------------------------- | ----------------------------------- | --------------------------------------- |
| Default dashboard                   | Yes                         | Yes, 10 mixed cards                 | Replace with seller-performance default |
| Global date + comparison            | Yes                         | No                                  | Release 1                               |
| Add/remove/reorder                  | Yes                         | Yes                                 | Keep and harden                         |
| Resize cards                        | Yes                         | No; span is fixed in registry       | Release 1                               |
| Named/reorderable/hideable sections | Yes                         | No; library groups are not sections | Release 1                               |
| Searchable widget library           | Yes                         | Yes                                 | Keep; add categories and "New" state    |
| Cross-device persistence            | Yes in product behavior     | No; browser `localStorage` only     | Release 1, per admin                    |
| Card -> detailed report             | Yes                         | No                                  | Release 2                               |
| Custom report -> dashboard card     | Yes                         | No report builder                   | Later, not dashboard-parity blocker     |
| Targets and generated insights      | Yes                         | No                                  | Later                                   |
| Google Search Console cards         | Not native to Shopify admin | No                                  | Release 2 differentiator                |
| First-party sessions/conversion     | Yes                         | No event pipeline                   | Release 3                               |

### 0.2 Definition of done for dashboard parity

The overview-dashboard parity milestone is done when a seller can:

1. open Analytics and understand sales performance without editing anything;
2. change the date range and comparison once and see every compatible card
   update consistently;
3. select **Edit dashboard**, add cards from a searchable library, remove cards,
   drag them into order, resize them, and arrange them into named sections;
4. save, cancel, or reset, then see the saved layout on another device;
5. use the same saved composition on mobile in a responsive single-column order;
6. never see a card or aggregate outside their store, role permissions, or
   assigned location scope;
7. understand whether a number is StoreMink commerce data, StoreMink traffic
   data, or delayed Google Search data.

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
  retention hook, and it needs only a small scheduled ingestion pipeline.
- **Custom-domain provisioning already exists, but domain history does not.**
  `store-indexing.ts:161-245` creates a URL-prefix property
  (`https://domain/`) and verifies it via META. Query that property directly,
  with no page filter. The new work is recording it as a dated source so moving
  from subdomain -> custom A -> custom B does not overwrite history.
- **A merchant's own Google account is optional and can coexist.** StoreMink's
  service account is an additional verified owner/user for the managed property;
  it does not replace access the merchant already has. Disconnect removes only
  StoreMink's managed property/ownership path and stops new ingestion.

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

Google forces page aggregation when a query filters by page. Therefore the
subdomain cards are deliberately **page-aggregated** and might differ slightly
from an unfiltered property-level total if multiple pages from that store appear
in one result set. The tooltip must say "Google Search performance for this
store's pages"; it must not claim to reproduce the root Domain property's total.

### A3 Ingest: source-aware, trailing-window upserts

GSC data is **revised for ~3 days** after the fact and lags ~2 days. An
append-only ingest therefore stores figures Google has since corrected.

Do **not** collapse every domain into `(store_id, date, dimension, key)` at
write time. That v1 shape cannot safely represent custom-domain A -> B: refreshing
the last five days either drops A's contribution, keeps querying a domain that
can be reassigned, or overwrites A with B. Sources stay separate in storage and
are summed only in the read query.

```sql
-- supabase/search_metrics_01_schema.sql (shape; exact constraints in migration)
create table store_search_sources (
  id             uuid primary key default gen_random_uuid(),
  store_id       uuid not null references stores(id) on delete cascade,
  kind           text not null, -- 'platform_subdomain' | 'custom_domain'
  origin         text not null, -- normalized https origin, no trailing slash
  property       text not null, -- sc-domain:... or https://domain/
  page_filter    text,          -- anchored regex for platform source; null for custom
  active_from    timestamptz not null,
  inactive_at    timestamptz,
  last_synced_at timestamptz,
  last_data_date date,
  last_error     text,
  unique (store_id, origin, active_from)
);
create unique index store_search_sources_one_active_idx
  on store_search_sources (store_id) where inactive_at is null;

create table store_search_metrics (
  source_id      uuid not null references store_search_sources(id) on delete cascade,
  store_id       uuid not null references stores(id) on delete cascade,
  date           date not null, -- Google Search Console date: Pacific Time
  dimension      text not null, -- 'total' | 'query' | 'page' | 'country' | 'device'
  key            text not null default '',
  clicks         integer not null default 0,
  impressions    integer not null default 0,
  position_sum   numeric(18,4) not null default 0,
  primary key (source_id, date, dimension, key)
);
create index store_search_metrics_store_date_idx
  on store_search_metrics (store_id, date desc);
```

`store_id` is repeated on the metric row intentionally: it keeps RLS and the hot
read index simple. A trigger or composite foreign key must guarantee that the
metric's `store_id` equals its source's `store_id`; application code alone is not
an integrity boundary.

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

RLS: service-role writes; `is_store_admin(store_id)` reads. Sellers never read
the source's Google property or filter directly; dashboard queries return typed
aggregates. This follows the `email_logs` service-write pattern.

#### ★ Domain lifecycle: keep history, stop ownership leaks

Every launched store starts with one active `platform_subdomain` source. When a
custom domain becomes verified and entitled, close that source epoch and create
an active `custom_domain` source. The closed row and its metrics remain attached
to the store, so the chart does not reset on the day of the move. There is
normally one active source per store; recently closed sources may receive only
the bounded correction sync described below.

**★ Double-counting is prevented by source boundaries, not a fuzzy dedupe.** The
Domain-property query always carries its anchored `^https://store\.storemink\.com/`
page filter, and the URL-prefix property only ever returns URLs under the custom
domain, so sources are disjoint by URL. Read-time totals sum their stored rows.

Transition rules:

| Event                                     | Source behavior                                                                                                                     | Merchant experience                                                  |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Store launches on subdomain               | Create platform source; query root Domain property with anchored filter                                                             | Search cards appear with collecting/no-data state                    |
| Custom domain verifies                    | Close active platform epoch; create custom source; provision/query URL-prefix property                                              | One continuous chart with a "Domain connected" annotation            |
| Custom domain changes A -> B              | Close A when it stops being canonical; create a platform epoch during fallback; close that epoch and create B only after B verifies | History remains; each origin owns only its active dates              |
| Custom domain disconnects                 | Close custom source; create a new platform epoch                                                                                    | Historical custom rows remain visible; new data comes from subdomain |
| Custom-domain entitlement lapses          | Same as disconnect for new collection; do not delete stored metrics                                                                 | No history deletion as a billing side effect                         |
| Domain is later attached to another store | It receives a new source owned by that store                                                                                        | Old store never queries dates after its cutoff                       |

An inactive custom source must never be queried beyond its cutoff. Because GSC
dates are Pacific Time and day-grained, set the source's final eligible date to
the last completed PT day before detachment. A bounded correction job may
re-query only dates on or before that cutoff for the next three days; this picks
up Google's revisions without ingesting traffic that belongs to a later owner.

`google_site_verified_at` is not enough to model this history—it is overwritten
when domains change. The source table is the durable record. Domain transitions
must update it in the same successful workflow that changes
`custom_domain_verified`; reconciliation must be idempotent if the browser closes.

After the final bounded sync, remove the obsolete URL-prefix property and Site
Verification ownership record so Google's 1,000-property account limit does not
ratchet forever. Removing Google ownership does **not** delete StoreMink's cached
historical metrics.

The chart annotates each source boundary. A visible step-change should read
"Custom domain connected" or "Domain changed", not look like unexplained growth
or loss.

### A4 Volume — cap the dimension rows, not the totals

Naively storing top-100 queries + top-50 pages + countries + devices is ~175
rows/store/day → **64M rows/year at 1,000 stores**. Not worth it.

- `dimension = 'total'`: **daily per source**. Usually one or two rows per
  store/day. This is what the headline cards and trend chart read.
- `query` / `page`: **top 25, weekly grain**. A small merchant does not have 100
  meaningful queries, and the API explicitly "does not guarantee to return all
  data rows but rather top ones" anyway.
- `country` / `device`: top 10 / all 3, weekly.

**★ These are the INITIAL storage policies, not architectural limits.** The
`(source_id, date, dimension, key)` primary key accommodates daily query-level
rows and any number of keys per day — raising `query` to top 50 or 100, or moving
it to a daily grain, is a constant change plus a backfill, **not a schema
redesign**. Keep the row caps and per-dimension granularity in one
constants module (the `lib/import-export/limits.ts` posture) rather than inlined
at the call sites, so the ceiling can be raised — globally or per plan — without
touching the ingest or the read path. The API's own "top rows only" behaviour is
the real ceiling on `query`/`page` fidelity; ours should sit below it by choice,
not by accident.

Add a `RETENTION_POLICIES` entry in `lib/retention/prune.ts` (§32) — 16 months,
matching Google's own window so a merchant never sees less than GSC shows.

### A5 The cron must be resumable

Per active source this is ~3 API calls (totals-by-date, top queries, top pages).
At 1,000 stores with one source each that is ~3,000 calls; custom-domain stores
temporarily add another source. Rate is fine — Search Analytics allows
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
| `search_ctr`         | Click-through rate (`clicks / impressions`)              |
| `search_position`    | Average position (impression-weighted), trend            |
| `search_trend`       | Clicks and impressions over time                         |
| `search_queries`     | Top 25 search terms — clicks, impressions, CTR, position |
| `search_pages`       | Top landing pages from search                            |

Gate on the existing `analytics` section. **Do not plan-gate it** — it costs one
cron and it is the cheapest acquisition data on the platform; making it Pro-only
trades a retention hook for very little revenue.

Search cards carry a **Google Search** source badge and "Last updated" time. The
section has four distinct non-error states:

1. `not_launched` — "Publish your store to start collecting Google Search data."
2. `collecting` — launched/verified but no complete GSC day yet; never render 0.
3. `no_visibility` — collection is healthy and complete days exist with zero
   impressions; explain that Google has not shown the store yet.
4. `ready` — render values; top-query/page tables may still be empty because
   Google suppresses rare queries.

An indexing/permission failure is a fifth, actionable error state with a link to
Domain settings. A stale successful snapshot remains visible with a warning; a
temporary Google outage must not blank the dashboard.

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

### B0 ★ Dashboard product contract

#### Default composition

The out-of-box dashboard is opinionated. It should answer, in order: "How did I
do?", "What sold?", "Who bought?", and "How did Google find me?"

| Section       | Default cards                                                                    | Notes                                                                                           |
| ------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Overview      | Total sales, Orders, Average order value, Units sold                             | Four compact cards; selected range vs selected comparison                                       |
| Sales         | Sales over time, Top products, Sales by channel, Sales by location               | Location card appears only when locations exist and viewer scope permits it                     |
| Customers     | New vs returning customers, Total customers                                      | Total customers is explicitly a current/lifetime snapshot and does not fake a period comparison |
| Google Search | Clicks, Impressions, CTR, Average position, Search trend, Top queries, Top pages | Delayed source with its own freshness/empty-state copy                                          |

Returns/refunds, discounts, payment method, inventory velocity, recent orders,
enquiries, blog approvals, and recent activity remain available in the library
but do not crowd the seller-performance default. Operational queues belong on
Home or their own pages; Analytics defaults should be analytical.

When first-party traffic ships, add a recommended "Storefront conversion"
section (Sessions, Conversion rate, Add-to-cart rate, Reached-checkout rate,
Converted sessions). Do not silently insert it into a customized layout.

#### Editing interaction

- The page header contains **Edit dashboard** as requested. It is visible to any
  role that can view Analytics because changing a personal layout does not change
  store data.
- Editing is desktop-only for v1. Mobile renders the saved responsive order and
  says to use desktop when customization is requested.
- Entering edit mode creates a draft. **Save** commits, **Cancel** discards, and
  **Reset to default** removes the personal override after confirmation.
- Cards drag within or across sections. Sections can be added, renamed, hidden,
  reordered, and deleted. A section title is 1–60 trimmed characters.
- Cards support `compact`, `half`, and `full` sizes. The renderer maps these
  semantic sizes to the current four-column grid; raw column counts are not
  persisted. Tables and multi-series charts have a minimum `half` size.
- A widget can appear once. Adding it removes it from library results; removing
  it returns it to the library.
- The library is searchable and grouped by Overview, Sales, Customers,
  Acquisition, Inventory, Operations, and Content. Groups are catalog metadata,
  not dashboard sections.
- Keyboard drag/reorder, move-up/down controls, visible focus, and non-drag
  add/remove paths are acceptance requirements, not polish.
- The edit surface may render lightweight previews, but Save validates every
  widget id, size, section count, title, role, and store on the server.

#### Persistence model

Current `localStorage` (`sm.analytics.layout.v1.{storeId}`) is only a migration
input. Server state becomes authoritative:

```sql
create table analytics_dashboard_layouts (
  store_id      uuid not null references stores(id) on delete cascade,
  admin_user_id text not null,
  schema_version integer not null default 1,
  layout         jsonb not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (store_id, admin_user_id)
);
```

Example value:

```json
{
  "defaultRevision": 2,
  "sections": [
    {
      "id": "overview",
      "title": "Overview",
      "hidden": false,
      "items": [
        { "widgetId": "metric_total_sales", "size": "compact" },
        { "widgetId": "metric_orders", "size": "compact" }
      ]
    }
  ]
}
```

Rules:

- no row means "follow the current product default"; Reset deletes the row;
- first load may import the valid legacy localStorage order once, then mark or
  remove the local value;
- server rendering filters cards by current permissions and location scope;
- temporarily unavailable/unauthorized card entries stay in stored JSON but are
  omitted from rendering, so a permission change does not destroy a preference;
- unknown retired widget ids are ignored; aliases migrate renamed ids;
- layout JSON has bounded counts and byte size; no arbitrary component or query
  definitions are accepted;
- writes derive `store_id` and `admin_user_id` from the authenticated request;
  neither is trusted from the browser;
- last-write-wins is acceptable for the same admin editing on two devices, but
  return `updated_at` so the UI can warn before overwriting a newer draft.

#### Global filters and metric semantics

Filters live in URL search params so refresh/back/forward/share and server
rendering agree. Layout preferences do not contain filter values.

- range presets: Today, Yesterday, Last 7 days, Last 30 days, Last 90 days,
  Month to date, Year to date, Last 12 months, Custom;
- default: **Last 90 days**, matching Shopify's current overview default;
- comparison: Previous period (default), Previous year, Custom, None;
- location: All accessible locations or one accessible location, once location
  analytics ships; the server intersects the request with staff scope;
- currency: store currency only in the first release. Multi-currency display is
  not parity-critical while orders are effectively INR; do not show a dead
  currency selector.

The store's configured time zone defines commerce ranges. Search Console dates
are published in Pacific Time, so Search cards disclose that daily boundary in
their tooltip and may not line up exactly with commerce day buckets.

Metric cards show value, comparison delta when meaningful, sparkline, source,
freshness, and a plain-language definition. A current snapshot such as inventory
or total-customer count must not display a fake period delta.

### B1 ★ Phase 1 is a date range, and it is load-bearing

Every other item here depends on it, and it is the change that touches
everything: `getAnalyticsData(storeId)` becomes range-aware, which means
splitting the 404-line monolith into per-widget async functions so widgets can
stream under `Suspense` instead of blocking on one 10-query transaction.

- `?range=today|yesterday|7d|30d|90d|mtd|ytd|12m|custom&from=&to=&compare=previous|year|custom|none`, following the only date filter that
  exists in the dashboard today — the `<select>` at
  `app/dashboard/logs/activity-feed-view.tsx:117`.
- **Default comparison = previous equal-length window**, not "previous calendar
  month". Previous year, custom, and none are also supported.
  This also fixes a real bug: `stats` mixes time bases — `revenue.value` is
  all-time, `orders.value` is this month, `customers.value` is lifetime — and
  all four render a month-over-month `trendPct` (`data.ts:196-209`). A
  percentage next to an all-time total is meaningless.
- Default to **90 days** for current Shopify parity. The chosen range stays in
  the URL, so a seller can bookmark a 30-day operating view.

### B2 Fix these while you are in there

- **★ Revenue is divided by 1000 and rounded** for the chart series
  (`data.ts:114`, `:213`). Any month under ₹500 renders as **0**. A new store's
  first month reads as zero revenue.
- **★ Revenue counts unpaid online orders.** The only filter is
  `status != 'cancelled'` (`data.ts:135`), so a pending Razorpay order that will
  be reaped by `expire-pending-payments` is booked as revenue. Replace the vague
  "Revenue" label with defined sales metrics below.
- **★ Delete the dead fake widgets.** `product-performance.tsx` hardcodes
  `$12,450` and `conversion: "4.2%"`; `inventory-health.tsx` hardcodes "Smart
  Watch Series 5"; `operational-health.tsx` hardcodes all-Healthy. None are
  imported anywhere. A hardcoded conversion rate in the tree is a landmine — it
  is exactly the string someone will wire up to a slot in a hurry.

#### Sales definitions (decided for implementation)

The dashboard's headline is **Total sales**, not "Revenue". A sale is recognized
when it is a paid online/store-credit order, a finalized POS order, or a
non-cancelled COD order. A pending Razorpay order is excluded. This preserves the
real COD business while removing online payment attempts that never settled.

- **Gross sales:** merchandise value before order discounts and returns.
- **Discounts:** `orders.discount` plus snapshotted line discounts.
- **Returns/refunds:** only settled/completed money-return rows; pending or failed
  refunds do not reduce sales yet.
- **Net sales:** gross sales - discounts - returned merchandise value.
- **Total sales:** net sales + tax + shipping, minus settled refunds of those
  components. Never subtract the same return and refund twice.
- **Orders:** recognized orders, excluding cancelled/expired payment attempts.
- **Average order value:** total sales / recognized orders for the same range.

These formulas live in one tested analytics module and every widget uses them.
The metric info popover explains the COD treatment. "Booked orders" can be a
separate library card later; it must not be silently mixed into Total sales.

### B3 Phase 2 — widgets from columns you already have

No schema change, no tracking. This is the best value-to-effort ratio in the
document, and it is most of what a merchant means by "Shopify-like".

| Widget                   | Source                                                        |
| ------------------------ | ------------------------------------------------------------- |
| AOV                      | Total sales / recognized orders                               |
| Units sold               | `order_items.quantity` — exists, never summed                 |
| Top products (units + ₹) | `order_items` grouped by `product_id` — replaces the fake one |
| Sales by channel         | `orders.sales_channel` — online vs POS, already written       |
| **Sales by location**    | `orders.location_id` — the roadmap's outstanding item (§510)  |
| Sales by payment method  | `orders.payment_method`                                       |
| New vs returning         | first `orders.created_at` per `customer_id`                   |
| Discount impact          | `orders.discount`, line discounts, and `applied_coupon_code`  |
| Returns & refunds        | `order_returns`, `order_refunds` — return rate, refund value  |
| Inventory velocity       | `stock_movements` — a clean per-SKU ledger, read zero times   |

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

| #   | Release               | Step                                                                                                        | Rough size |
| --- | --------------------- | ----------------------------------------------------------------------------------------------------------- | ---------- |
| 1   | Dashboard foundation  | Metric definitions, global range/comparison parser, range-aware per-widget queries, revenue/chart bug fixes | M          |
| 2   | Dashboard parity      | Server-persisted per-admin layout, real sections, resize, responsive rendering, legacy localStorage import  | L          |
| 3   | Useful default        | Commerce widgets from existing columns and the default composition in B0                                    | M          |
| 4   | Google Search         | Source-aware schema, safe subdomain filter, custom-domain lifecycle, resumable ingest, search widgets       | L          |
| 5   | Search operations     | Indexing-health merchant/operator surfaces and A8 cleanup                                                   | S          |
| 6   | Drill-down            | Card-linked detailed reports and CSV export for the highest-value metrics                                   | M/L        |
| 7   | Merchant pixels       | GA4 and Meta Pixel settings with consent-policy integration                                                 | S          |
| 8   | Storefront conversion | Beacon, raw-event retention, daily rollup, funnel, bot controls, conversion cards                           | L          |
| 9   | Margin                | `cost_price`, backfill UX, gross margin reporting                                                           | M          |

Steps 1–3 form overview-dashboard parity. Step 4 is independent once the global
range contract exists and is StoreMink's differentiator. Do not start the
first-party traffic pipeline before its privacy/consent decision is recorded.

---

## 4. Remaining product decisions

The headline sales definition, layout scope, default range, custom-domain
history, and unlaunched-store state are decided above. These remain:

- **First-party traffic plan gate:** Basic and Pro, or Pro only? Cost data from a
  small production pilot should decide; do not guess from positioning.
- **Consent model for StoreMink traffic and merchant pixels:** jurisdiction and
  storefront policy work must precede event collection.
- **Detailed-report scope:** which first four cards get drill-down pages after
  dashboard parity. Recommended: Total sales, Sales over time, Top products, and
  Google Search queries.
- **Search types:** start with `type: "web"`. Images/News/Discover can be added as
  explicit sources later; mixing them into one unexplained total is not useful.
- **Saved layouts and staff offboarding:** rows should normally cascade/delete
  with the admin membership, but platform-operator layouts need a deliberate
  retention rule because operators have no `admins` row in every store.

---

## 5. Invariants this plan obeys

From `docs/roadmap.md`:

1. **A migration may not change what a live store does.** Every new widget is
   additive; new settings default to today's behaviour.
2. **Nothing cached is authoritative.** The metrics table is a cache of Google's
   numbers — re-ingested and self-correcting while a source is active, never the
   source of truth. Frozen rows for detached domains are explicitly historical.
3. **A disabled control is not a permission.** Range and store scope are
   re-derived server-side; `store_id` is never read from the client.
4. **Absence is not restriction.** A location-unbound admin sees every
   location's figures in the location split.
5. **Preferences are not permissions.** A saved widget id cannot grant access to
   its data. The server intersects layout, section permission, and location scope
   on every read.
6. **A domain is a dated source, not store identity.** Reassigning a domain never
   reassigns cached metrics; changing domains never changes `store_id` ownership.

---

## 6. Acceptance and verification checklist

### Dashboard

- Default, saved, empty, corrupt, legacy, and reset layouts all render safely.
- Add/remove/reorder/resize/section operations work with pointer and keyboard.
- Save persists across browser/device; Cancel performs no write.
- Mobile order matches desktop reading order and never relies on a four-column
  viewport.
- URL range/comparison survives reload and invalid params fall back safely.
- Every metric is tested at zero, previous-period zero, refunds, cancellation,
  pending Razorpay, COD, POS, and mixed-channel cases.
- A restricted role cannot reveal a hidden card by editing JSON or URL params.
- Location-bound staff never see all-location totals in cards, deltas, exports,
  or report links.

### Search Console and domains

- The filter for `mink.storemink.com` does not match
  `supermink.storemink.com`, `mink-storemink.com`, HTTP, or another protocol/host.
- Store A cannot query or read Store B's source or metrics under any API response,
  saved layout, role, or domain-reassignment path.
- Subdomain -> custom A -> custom B -> subdomain preserves prior chart history,
  inserts visible annotations, and collects new data from only active sources.
- A detached custom source never queries dates after its final eligible PT date.
- Re-running a window updates rows rather than duplicates them; CTR and weighted
  position recompute correctly after revisions.
- Query rows need not sum to totals; empty/suppressed-query copy remains honest.
- Google timeout/403/429 leaves the last good snapshot visible, records an
  operator-visible failure, and resumes from the lease/cursor.
- Domain reconciliation (not only the interactive button) creates and deactivates
  sources and provisioning state idempotently.

### Performance and observability

- The page streams independent widget groups; one slow Google query never blocks
  commerce cards (normal reads come from local tables, not live Google calls).
- Record per-run stores/sources scanned, rows upserted, oldest/newest data date,
  API latency, quota errors, source lag, and terminal failures.
- Alert on fleet cursor not advancing, GSC data age beyond four days, and repeated
  401/403, rather than alerting on a legitimate zero-impression store.

---

## 7. Research sources (checked 2026-08-14)

- [Shopify: Using the Analytics overview dashboard](https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/overview-dashboard/using-the-overview-dashboard)
- [Shopify: Customizing the Analytics overview dashboard](https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/overview-dashboard/customizing-overview-dashboard)
- [Shopify analytics and reports](https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports)
- [Google: Domain and URL-prefix properties](https://support.google.com/webmasters/answer/34592?hl=en)
- [Google Search Analytics API query reference](https://developers.google.com/webmaster-tools/v1/searchanalytics/query)
- [Google Search Console API usage limits](https://developers.google.com/webmaster-tools/limits)
- [Google: Performance data freshness, time zone, and discrepancies](https://support.google.com/webmasters/answer/17010575?hl=en)
- [Google: Performance aggregation and preliminary data](https://support.google.com/webmasters/answer/17011364?hl=en)
- [Google Site Verification API](https://developers.google.com/site-verification/v1/getting_started)
