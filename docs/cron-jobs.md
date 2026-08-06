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

All five: `GET`, `Etc/UTC`, 300s attempt deadline, 3 retries, and an
`Authorization: Bearer <CRON_SECRET>` header — the same secret the routes check
(`CRON_SECRET` is in Secret Manager and already wired to the prod service).

`seo-refresh` registers the platform/help sitemaps, retries sitemap coverage for
every launched store, and automatically verifies Search Console URL-prefix
properties for connected custom domains. It returns **503 on any partial
failure**, so Scheduler retries are part of its reliability contract. Enable
the Google Search Console + Site Verification APIs and configure the runtime
service account first; see `docs/seo-indexing.md`.

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

## Verifying

Trigger one by hand and confirm Cloud Run answered 200 — a job can be `ENABLED`
and still be failing every night, so check the _response_, not just the state:

```bash
gcloud scheduler jobs run storemink-plan-expiry --project=storemink-prod --location=asia-south1
```

```bash
gcloud logging read 'resource.type="cloud_run_revision" AND httpRequest.requestUrl=~"/api/cron/"' --project=storemink-prod --limit=10 --format="value(httpRequest.status,httpRequest.requestUrl)"
```

The original three were verified this way on 2026-07-30. The SEO job is new and
must be created and verified after this change reaches production.

## Staging

Staging has no scheduled jobs, deliberately — `SEARCH_INDEXABLE` keeps it out of
search, and a staging cron sending real email or cancelling real orders is a
liability, not a test. Exercise a cron route on staging by curling it with that
environment's `CRON_SECRET`.

## If you rotate `CRON_SECRET`

The header is baked into each job at creation. Rotating the secret without
updating the jobs makes all four start returning 401 — silently, because a
failing cron looks identical to one that had nothing to do. Update them with
`gcloud scheduler jobs update http <name> --headers=...`, then re-verify with the
logging query above.
