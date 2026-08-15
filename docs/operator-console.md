# Operator console — the StoreMink admin at `storemink.com/dashboard`

> The console an operator uses to run the platform, as opposed to the dashboard
> a merchant uses to run their store. Served on the platform host only
> (`proxy.ts` rewrites `/dashboard/*` → `/platform/dashboard/*`), gated on
> `platform_admins`.

## Why this exists

The console grew one panel at a time and they all landed on the **home page**:
the store table, the pricing editor and the theme seeder were stacked on a
single scroll, under a metric row. Three consequences, all of them real:

- **"Reprice the Pro plan" was one mis-click from "look at a store".** Those are
  not the same kind of act and should not share a screen.
- **A store had no page of its own.** Everything an operator knew about a
  merchant came from one table row plus a history drawer, so answering "why is
  this merchant complaining?" meant opening their dashboard as them, or writing
  SQL against production.
- **The page grew whenever the platform did.** Every new capability had one
  obvious home, and it was the bottom of `page.tsx`.

## The information architecture

| Group              | Entry          | Path                       | What it answers                       |
| ------------------ | -------------- | -------------------------- | ------------------------------------- |
| **OPERATIONS**     | Overview       | `/dashboard`               | What needs someone right now?         |
|                    | Stores         | `/dashboard/stores`        | The merchant estate                   |
|                    | ↳ store detail | `/dashboard/stores/[id]`   | Everything about ONE merchant         |
|                    | People         | `/dashboard/people`        | Who can sign in to which store        |
|                    | Announcements  | `/dashboard/announcements` | Tell merchants something _(phase 4)_  |
|                    | Logs           | `/dashboard/logs`          | What happened, what broke _(phase 3)_ |
| **ADMINISTRATION** | Help Centre    | `/dashboard/help`          | Platform docs                         |
|                    | Themes         | `/dashboard/themes`        | The catalog + demo stores             |
|                    | Pricing        | `/dashboard/pricing`       | What StoreMink charges                |
|                    | Operators      | `/dashboard/operators`     | Who runs the platform                 |
|                    | Billing & tax  | `/dashboard/billing`       | StoreMink's own GST identity          |

**The split is by job**, the rule `app/dashboard/lib/permissions.ts` already
applies to the merchant nav. Operations is what an operator watches and acts on
daily; Administration is configured once and left alone. **Logs is deliberately
in Operations** — it is the first place anyone looks when something is wrong,
not a setting.

## Rules this console follows

### ★ The gate lives where the read is

`requireOperator()` (`app/platform/dashboard/(console)/require-operator.ts`) is
called by **every page**, not just the layout. A Next layout and its pages
render **concurrently**: a layout `redirect()` does not abort a page already
fetching — the same property that forces every storefront page to call
`requireStorefrontStore()` for itself (CODEBASE §3). These pages read every
store on the platform under `withService`, which **bypasses RLS**, so the gate
is the whole of the access control.

**⚠ The home page does NOT use it.** `requireOperator` redirects a non-operator
to `/dashboard`, which _is_ the home page — a signed-in non-operator would loop
forever. Home keeps its own "not authorized" branch with a way out.

### ★ Reads live in `lib/platform/`, not `app/actions/`

Every export of a `"use server"` file is a publicly reachable endpoint.
`loadStoreDetail` / `loadStorePeople` / `getPlatformInsights` are reads called
by server components that have already resolved the viewer, so exporting them
as actions would add public endpoints returning cross-tenant data for no
benefit. Same resolution as `lib/domains/reconcile.ts` (§30) and
`lib/retention/prune.ts` (§32): **core in `lib/`, gate at the entry point.**

### ★ One round trip, not fifteen

A store detail wants ~15 counts. Issued separately that is 15 × the ~46 ms round
trip to Cloud SQL in Mumbai (`docs/local-dev-performance.md`) — most of a second
before React starts. They are scalar subqueries in one statement, the shape
`getPlatformOverview` already used.

### ★ Never a secret, only a state

Channel cards show `connected / paused / not connected`. Gateway, carrier and
SMS credentials are encrypted at rest and write-only by design (§18, §35, §37);
an operator console is not a reason to widen that. `loadStorePeople` likewise
never returns `pin_hash`, `invite_token` or `reset_token` — each is a live
credential, and none of them answers an operator's question.

### ★ Effective plan, never the stored one

The gates read `effectivePlan(store)`, so the console must too. A lapsed timed
grant is stored as `pro` and **is free today**; showing only the stored plan is
how a support conversation starts wrong. The store detail shows both when they
disagree, and the SQL predicates behind the overview's plan mix mirror
`effectivePlan` exactly — if this screen counted stored plans while the gates
read effective ones, the console would report revenue the product is not
delivering.

### ★ Zero is rendered, never hidden

The overview's **Needs attention** block is six queues, each of which is zero on
a good day and each of which stays on screen at zero, greyed out. A row that
disappears when clear teaches nobody what is being watched. Only a non-zero row
takes colour and becomes a link. This is §22's sidebar-badge rule — a hardcoded
"12" on Orders taught people to ignore the badges that moved.

### ★ A read failure says so

`getPlatformInsights` never throws; it returns `ok: false` and zeroes. This is
the screen someone opens when something is wrong, so a 500 is the worst
available behaviour — but **rendering zeroes as though they were the answer is
the second worst**, hence the banner.

## Phases

- **Phase 1 — IA, stores, themes, pricing ✅**
  New nav; `StoresConsole` moved to `/dashboard/stores`; store detail page
  (`lib/platform/store-detail.ts`); `ThemesPanel` → `/dashboard/themes` and
  `PricingPanel` → `/dashboard/pricing`, both superadmin-only; home rebuilt as a
  real overview (`lib/platform/overview.ts`) with a 12-week signup chart, plan
  mix, six attention queues and latest signups.
  The list's **History drawer was removed** rather than left alongside the
  detail page — two paths to the same data is the mess this revamp is undoing.
- **Phase 2 — People ✅**
  `/dashboard/people` (`lib/platform/people.ts`) unions `admins` and `pos_staff`
  across every store, searchable by name/email/store, filterable by access kind,
  and deep-linkable to one store (`?store=`) from the store detail page.
  - **★ `kind` IS NEVER COLLAPSED.** A dashboard login and a till PIN are
    different access with different reach; a flattened list would make revoking
    the wrong one look identical to revoking the right one.
  - **★ THE SAME PERSON MAY APPEAR TWICE, AND THAT IS CORRECT.** A shop owner
    who also rings the till has both rows — two credentials, revoked
    separately. Deduplicating by email would hide one.
  - **★ THE CHIP COUNTS IGNORE THE KIND FILTER.** Counted under the search and
    store filters alone, so selecting "Till" still reports how many dashboard
    admins the same search returns. Counting them under the full filter makes
    every unselected chip read zero, which is a dead end rather than a filter.
  - **★ `peopleHref` IS ONE TESTED BUILDER** (`lib/platform/people-links.ts`).
    A "next page" link that forgets `?q=` turns a filtered list into an
    unfiltered one that still looks filtered, and the only symptom is rows
    nobody asked for. Switching a chip resets paging for the mirror reason: a
    term matching four people has no page 4, and an empty screen reads as "no
    results".
- **Phase 3 — Logs hub ✅**
  Email logs, SMS logs and the cross-store failure feed behind one entry at
  `/dashboard/logs`, with 307s from the old `/dashboard/email-logs` and
  `/dashboard/failures`.
  - **★ `LogsRail` TAKES ITS REGISTRY AS A PROP.** Both consoles share
    `DashboardSidebar`, and their logs are NOT the same set — an operator has no
    import/export jobs and no per-store activity feed, a merchant has no
    cross-store failure view. Hardcoding `LOG_TYPES` would have put three rail
    entries in front of routes the platform does not have. It defaults to the
    merchant registry, so every existing call site is unchanged.
  - **★ A LANDING, NOT A REDIRECT TO THE FIRST LOG.** The merchant hub can
    default to its Activity feed; the platform has no cross-store equivalent, so
    "Logs" would silently mean "Email logs" and hide that the other two exist.
  - **★ `getSmsLogs` GAINED HOST-DERIVED SCOPE**, mirroring `getEmailLogs`. It
    used `getActingStoreId()`, whose never-null fallback resolves the WholeSip
    store — so on the operator console it would have served one merchant's SMS
    log as though it were the platform's. The platform scope re-checks operator
    membership inside the action, because a server action is an independently
    reachable POST endpoint.
  - **★ `log-types.test.ts` IS A DRIFT GUARD IN BOTH DIRECTIONS**: `fs.readdir`
    asserts every rail entry has a page, and every page has a rail entry. It
    also fails if the platform registry ever acquires the merchant-only keys —
    the guard against "tidying up" by pointing the platform sidebar at
    `LOG_TYPES`.
  - **⚠ The platform SMS log is EMPTY today**, and honestly so: nothing writes
    a `store_id IS NULL` row because there is no platform Twilio account. The
    page exists because adding it at the moment the first message goes out is
    how a send with no log ships.
- **Phase 4 — Announcements.** Broadcast to merchants and their staff.

## ⚠ Announcement SMS cannot send yet, and that is not a code problem

Decided 2026-08-15. Building it gated rather than omitting it, so the audience,
composer and log are designed for two channels from the start.

Three things are missing, and only the first is ours:

1. **StoreMink has no Twilio account of its own.** SMS is BYO-per-store (§37) —
   `store_sms_providers` holds a merchant's credentials, and there is no
   platform-level equivalent. Sending _to_ merchants needs one.
2. **DLT registration.** Every commercial SMS to an Indian number needs a
   registered Principal Entity, a 6-character sender header, and an **approved
   template per message body**. A body that does not match is dropped at the
   carrier — silently, with no bounce. 7–21 business days.
3. **A feature announcement is PROMOTIONAL, not transactional.** That is a
   different and heavier compliance surface than the transactional templates
   §37 already models: numeric sender headers, DND/NDNC scrubbing, and time-of-day
   restrictions.

Until all three exist, the SMS channel must **refuse with a stated reason**
rather than queue messages every carrier will drop. This is `available: false`
in `lib/notifications/channels.ts` applied one level up, and §23's rule that a
control which always fails is worse than no control.

## Testing

There is no cross-browser or authenticated-console E2E infrastructure (CODEBASE
§2), and the console sits behind an email-OTP login. What is checked:

- **Typecheck, lint, build and the full vitest suite**, all green.
- **Column audit**: every table and column named in the raw SQL of
  `lib/platform/*.ts` verified against `drizzle/schema.ts`, which is introspected
  from the live database and is therefore authoritative on names.
- **⚠ The SQL has not been executed.** The local Cloud SQL Auth Proxy resets
  every connection when its ADC token has expired (§6), which is the state this
  was written in. **Run `gcloud auth application-default login`, restart
  `npm run db:proxy`, then load `/dashboard` and one store detail before
  merging** — a raw-SQL mistake that typecheck cannot see would surface exactly
  as the empty/`ok: false` state, which is also what a dead proxy looks like.
