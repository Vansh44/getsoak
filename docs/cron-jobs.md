# Scheduled jobs (Cloud Scheduler)

**`vercel.json` does not drive anything.** Production runs on Cloud Run, where
Vercel's `crons` block is inert. It is kept only as a record of the intended
schedules. The real driver is **Cloud Scheduler in `storemink-prod`,
`asia-south1`**.

## The gap this documents

Between the Cloud Run cutover and **2026-07-30**, `storemink-prod` had **zero**
Cloud Scheduler jobs in **any** region — verified by sweeping every location.
`docs/gcp-migration-cutover-checklist.md` listed `Crons → Cloud Scheduler` and
the box was never ticked. So for the whole period after the cutover, none of the
three scheduled jobs ran.

It happened a second time, quietly: the 2026-07-30 fix created the three jobs it
knew about, `seo-refresh` was documented in this file as still to be created, and
it then sat uncreated until **2026-08-06** — with its two required Google APIs
never enabled either. A doc that says "must be created" is not a reminder anybody
receives. If you add a job here, create it in the same sitting and record the
verification below.

**Measured blast radius at the time of fixing (prod, read-only queries): 2
stores, 0 orders, 0 lapsed plans, 0 pending razorpay orders, 0 campaign
recipients.** Nothing was lost, because production has no real traffic yet — but
each job is a landmine the moment it does:

| Job                       | What its absence would have cost under real traffic                                                                                             |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `send-emails`             | Coupon email campaigns never send.                                                                                                              |
| `plan-expiry`             | A lapsed timed plan keeps its paid features **forever** — the durable half of the plan gate (`lib/plans.ts` `effectivePlan` covers reads only). |
| `expire-pending-payments` | Unpaid Razorpay orders are never reaped, so their stock reservations and coupon uses are held **permanently**.                                  |
| `domain-reconcile`        | A merchant's custom domain **never goes live** unless they happen to keep the settings tab open for the whole of Google's issuance window.      |
| `seo-refresh`             | No sitemap is ever submitted to Google, so nothing on the platform, the help centre or any launched store gets discovered.                      |

> Note: production currently runs `main`, which has **no notification system** —
> `lib/notifications/` and the `notification_email_queue` table do not exist
> there. `send-emails` on prod drives only the coupon-campaign worker. Once
> `staging` merges, the same job also drains notification email, and its 00:00
> UTC slot becomes load-bearing (below).

## The jobs

| Job                                 | Schedule (UTC) | Endpoint                                                 |
| ----------------------------------- | -------------- | -------------------------------------------------------- |
| `storemink-send-emails`             | `0 0 * * *`    | `https://storemink.com/api/cron/send-emails`             |
| `storemink-plan-expiry`             | `15 0 * * *`   | `https://storemink.com/api/cron/plan-expiry`             |
| `storemink-expire-pending-payments` | `30 1 * * *`   | `https://storemink.com/api/cron/expire-pending-payments` |
| `storemink-seo-refresh`             | `0 2 * * *`    | `https://storemink.com/api/cron/seo-refresh`             |
| `storemink-domain-reconcile`        | `10 * * * *`   | `https://storemink.com/api/cron/domain-reconcile`        |
| `storemink-prune-logs`              | `0 3 * * *`    | `https://storemink.com/api/cron/prune-logs`              |

All six: `GET`, `Etc/UTC`, 300s attempt deadline, 3 retries, and an
`Authorization: Bearer <CRON_SECRET>` header — the same secret the routes check
(`CRON_SECRET` is in Secret Manager and already wired to the prod service).

`seo-refresh` registers the platform/help sitemaps, retries sitemap coverage for
every launched store, and automatically verifies Search Console URL-prefix
properties for connected custom domains. It returns **503 on any partial
failure**, so Scheduler retries are part of its reliability contract. Enable
the Google Search Console + Site Verification APIs and configure the runtime
service account first; see `docs/seo-indexing.md`.

> **⚠ `Search Console rejected sitemap (403)` usually means the APIs are not
> enabled — not a property-permission problem.** The message reads like the
> service account lacks access to the property, which sends you into the Search
> Console UI looking for a grant that is already there. On 2026-08-06 every root
> and every store failed with this, and the entire cause was that
> `searchconsole.googleapis.com` and `siteverification.googleapis.com` had never
> been enabled in `storemink-prod` — a step `CODEBASE.md` §7 lists and that was
> simply skipped. Check this FIRST:
>
> ```bash
> gcloud services list --enabled --project=storemink-prod | grep -E "searchconsole|siteverification"
> ```
>
> Enabling both turned the same request into `200 {"ok":true}` with no other
> change. They are free; there is no reason for either to be off.

> **⚠ `send-emails` must stay at 00:00 UTC.** `DAILY_DIGEST_HOUR_UTC` is 23:00
> _because_ the heartbeat is 00:00 UTC (CODEBASE.md §24). Moving this schedule
> without moving that constant silently breaks digest timing.

> **⚠ Timezone is `Etc/UTC`, not IST.** The cron expressions were lifted verbatim
> from `vercel.json`, where they were always UTC. Re-creating them in
> `Asia/Kolkata` would shift every job by 5h30m.

## Recreating them

The secret is read straight from Secret Manager so it never lands in a shell
history or a repo file:

```bash
SECRET=$(gcloud secrets versions access latest --secret=CRON_SECRET --project=storemink-prod)
gcloud scheduler jobs create http storemink-plan-expiry \
  --project=storemink-prod --location=asia-south1 \
  --schedule="15 0 * * *" --time-zone="Etc/UTC" \
  --uri="https://storemink.com/api/cron/plan-expiry" \
  --http-method=GET --headers="Authorization=Bearer ${SECRET}" \
  --attempt-deadline=300s --max-retry-attempts=3
```

Create the SEO job with the same secret/header contract:

```bash
gcloud scheduler jobs create http storemink-seo-refresh \
  --project=storemink-prod --location=asia-south1 \
  --schedule="0 2 * * *" --time-zone="Etc/UTC" \
  --uri="https://storemink.com/api/cron/seo-refresh" \
  --http-method=GET --headers="Authorization=Bearer ${SECRET}" \
  --attempt-deadline=300s --max-retry-attempts=3
```

The domain backstop is the one **hourly** job. Google's managed certificate takes
up to ~30 minutes after the challenge CNAME resolves, and merchants edit DNS on
their own schedule, so a daily sweep would leave a domain connected at 09:05
waiting a full day to serve:

```bash
gcloud scheduler jobs create http storemink-domain-reconcile \
  --project=storemink-prod --location=asia-south1 \
  --schedule="10 * * * *" --time-zone="Etc/UTC" \
  --uri="https://storemink.com/api/cron/domain-reconcile" \
  --http-method=GET --headers="Authorization=Bearer ${SECRET}" \
  --attempt-deadline=300s --max-retry-attempts=3
```

Unlike `seo-refresh` it answers **200 even while domains are still waiting** — the
common case is a merchant who hasn't added their records yet, which a retry
within the hour cannot help, and a permanently-red job is one nobody reads. Its
response body lists `waiting[]` with the reason per store.

Log retention runs last, at 03:00, after every other job has written whatever it
was going to write:

```bash
gcloud scheduler jobs create http storemink-prune-logs \
  --project=storemink-prod --location=asia-south1 \
  --schedule="0 3 * * *" --time-zone="Etc/UTC" \
  --uri="https://storemink.com/api/cron/prune-logs" \
  --http-method=GET --headers="Authorization=Bearer ${SECRET}" \
  --attempt-deadline=300s --max-retry-attempts=3
```

### What `prune-logs` closes

Three tables grew without bound because their retention policy was written down
and never wired to anything:

| Table             | Window   | Why                                                                                                  |
| ----------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `notifications`   | 90 days  | A read inbox row is history.                                                                         |
| `activity_events` | 365 days | The audit trail, so it gets the longest life.                                                        |
| `email_logs`      | 90 days  | Holds rendered message BODIES, so it is much the heaviest of the three and gets the shortest window. |

`supabase/email_logs.sql` documented the 90-day intent and even carries an
`email_logs_created_idx` built "for retention sweeps". `pruneNotifications` had
the right windows and a docstring saying it was "called by the daily cron".
**Nothing called it** — a grep returned the definition and nothing else. So
every one of these tables had grown unbounded since the day it was created.

That function has been deleted, not wired up, because it was also a live
security hole: it sat in `app/actions/notification-actions.ts`, a `"use server"`
file where **every export is a publicly reachable endpoint**, with no gate of
any kind, running under `withService` (which bypasses RLS), taking its retention
windows as _parameters_. An unauthenticated caller passing zeroes would have
deleted every notification, every email log and the whole of `activity_events`
— the append-only audit trail — for every store on the platform. The windows and
the sweep now live in `lib/retention/prune.ts`, which is not a `"use server"`
file, and the cron route is the gate (CODEBASE.md §30 applies the same rule to
`lib/domains/reconcile.ts`).

Behaviour worth knowing before you read a response:

- **It deletes in batches of 1000, each its own transaction**, so it never holds
  one enormous lock and a run that dies half way is resumable — the committed
  batches stay deleted and the next night carries on.
- **It stops itself** at 50,000 rows per table or 240 seconds, whichever comes
  first, and reports `stop` per table (`drained` / `cap` / `budget` / `error`).
  A first sweep over a long backlog will legitimately report `cap` for a few
  nights; `incomplete: true` in the body says so.
- **`incomplete` is a 200, a failed table is a 503.** A draining backlog is
  normal and must not turn the job permanently red (the `domain-reconcile`
  lesson); an actual failure should engage Scheduler's retries (the
  `seo-refresh` contract). One table failing never stops the next.
- Pruning `activity_events` cascades to any surviving `notifications`
  (`notifications.event_id` is `ON DELETE CASCADE`), which is why notifications
  are swept first and at the shorter window. **Financial records — orders,
  refunds, credit notes — live in their own tables and are never touched.**

> **⚠ `data_jobs` and `data_job_issues` are NOT yet swept, and they belong
> here.** They have the same shape and the same unbounded growth — `ISSUE_CAP`
> bounds issues per job, but nothing bounds the number of jobs. The sweep was
> written on `main`, where those tables do not exist; on this branch they do, so
> the blocker is gone. Adding them is two entries in `RETENTION_POLICIES`
> (`lib/retention/prune.ts`), **issues before jobs** — `data_job_issues.job_id`
> is `ON DELETE CASCADE` from `data_jobs`, the same shape as
> notifications→events.
>
> ⚠ Both tables carry only `(store_id, created_at)` composite indexes. A
> retention sweep filters on `created_at` **alone**, which cannot use a
> composite whose leading column is `store_id`, so each also wants a plain
> `created_at` index in `supabase/import_export_01_jobs.sql` — added as a
> separate `CREATE INDEX IF NOT EXISTS` so re-running the file stays idempotent.
> Without it the sweep works but seq-scans, which is precisely the cost that
> matters once the table is big enough to need pruning.

## Verifying

Trigger one by hand and confirm Cloud Run answered 200 — a job can be `ENABLED`
and still be failing every night, so check the _response_, not just the state:

```bash
gcloud scheduler jobs run storemink-plan-expiry --project=storemink-prod --location=asia-south1
```

```bash
gcloud logging read 'resource.type="cloud_run_revision" AND httpRequest.requestUrl=~"/api/cron/"' --project=storemink-prod --limit=10 --format="value(httpRequest.status,httpRequest.requestUrl)"
```

The original three were verified this way on 2026-07-30.

`storemink-seo-refresh` was created and verified on **2026-08-06** — it had never
existed, so sitemap submission had never run on a schedule. Verified by calling
the endpoint directly (`200 {"ok":true}`, both roots registered, both eligible
stores ready) after enabling the two APIs above.

`storemink-domain-reconcile` was created on **2026-08-06** alongside the fix it
backs. Its route ships in the same change, so verify its **response** once that
reaches production — the job authenticates (its baked-in header matches the
current `CRON_SECRET`) but will 404 until the deploy lands.

> **⚠ `storemink-prune-logs` HAS NOT BEEN CREATED.** The route ships in this
> change; the Cloud Scheduler job does not exist yet, and until someone runs the
> `gcloud` command above **no retention runs at all** — which is exactly the
> state this change set out to fix, and exactly the failure this file has now
> recorded three times. Create it, then verify the response and record the date
> here. Expect `{"ok":true,...}` with a large first `deleted` count and possibly
> `"incomplete":true` for the first few nights while the backlog drains.

## Staging

Staging has no scheduled jobs, deliberately — `SEARCH_INDEXABLE` keeps it out of
search, and a staging cron sending real email or cancelling real orders is a
liability, not a test. Exercise a cron route on staging by curling it with that
environment's `CRON_SECRET`.

## If you rotate `CRON_SECRET`

The header is baked into each job at creation. Rotating the secret without
updating the jobs makes all six start returning 401 — silently, because a
failing cron looks identical to one that had nothing to do. Update them with
`gcloud scheduler jobs update http <name> --headers=...`, then re-verify with the
logging query above.
