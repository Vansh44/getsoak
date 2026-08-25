# GCP Cutover Checklist — going live on Google Cloud

> The go-live checklist to fully cut StoreMink from **Supabase + Vercel** to
> **GCP** (Cloud SQL + Identity Platform + GCS + Cloud Run). The platform is
> live on Cloud Run; this document now retains the historical cutover and the
> release checks that remain operational.
>
> Detailed runbooks: [`gcp-migration-phase4-cloud-run.md`](gcp-migration-phase4-cloud-run.md)
> (Vercel→Cloud Run) and [`gcp-migration-phase5-6.md`](gcp-migration-phase5-6.md)
> (DB + Auth).

## Where we are (done + verified on staging)

- ✅ **Phase 5 (data → Cloud SQL/Drizzle)** — every DB read/write goes through
  `lib/db` (Drizzle). Only Supabase Storage (media) remains, by design.
- ✅ **Phase 6 (auth → Identity Platform)** — verified end-to-end on staging:
  signup, email/password login, "Continue with Google", forgot→reset password,
  staff invite → first login.
- ✅ **`uuid→text` uid-column migration** applied + verified on staging
  (`supabase/phase6_01_uid_columns_to_text.sql`) — Firebase uids are strings.
- ✅ **Code is fully Supabase-free** (2026-07-22, verified): no `@supabase/*`
  deps, `lib/supabase/` deleted, zero `SUPABASE_*` env reads. Only residue is
  the `.supabase.co` SSRF allowlist in `app/api/og-image/route.ts` that keeps
  serving LEGACY media URLs until the backfill. So the old §4 code items
  ("remove Supabase Storage fallback", "drop `NEXT_PUBLIC_SUPABASE_*`") are
  already done — see below.
- ✅ **Cloud Run + Cloud Scheduler are live** for staging and production. Eight
  schedulers are enabled; branch promotion is `f1` → `staging` → `main`.
- ▶ **Remaining:** finish the legacy media cleanup/decommission items below and
  use the checksummed database release gate for every future schema change.

> **⚠ DB TOPOLOGY CHANGED (2026-07-22): one instance, not two.** To cut cost the
> two Cloud SQL instances were **consolidated into a single instance
> `storemink-prod-db`** holding TWO databases — `storemink_staging` (staging +
> local dev) and `storemink` (prod). The separate `storemink-staging` instance
> was **DELETED**. So "provision a separate prod instance" below is OBSOLETE —
> the prod `storemink` DB already exists in the shared instance (schema + seed
> data present). The database is selected purely by `DB_NAME`; a wrong `DB_NAME`
> is now the only thing that could cross staging↔prod (guard it in deploy
> config). Matches CODEBASE.md §7.

**Key topology reminder:** the infra (the ONE Cloud SQL instance, GCS buckets,
Cloud Run, Vertex) lives in the **`storemink-prod` GCP project**; the **Identity
Platform project is separate per env** (`storemink-staging` for staging, a prod
project for prod — CODEBASE.md §7). Isolation = separate _databases/buckets_,
not separate instances or projects.

---

## 1. Prep — no downtime, do alongside the live site

**Code**

- [x] Fix [`lib/auth/firebase-admin.ts`](../lib/auth/firebase-admin.ts) so the ADC
      path prefers `FIREBASE_PROJECT_ID` over `GCP_PROJECT_ID`, so the Firebase
      project is never conflated with the infra project on Cloud Run. **(done)**
- [x] Refresh [`gcp-migration-phase4-cloud-run.md`](gcp-migration-phase4-cloud-run.md)
      — was stale (`SUPABASE_*` build args + "Supabase session check"); now `DB_*` + `FIREBASE_*` + Cloud SQL connector. Also swapped the `Dockerfile` +
      `cloudbuild.yaml` build args (2× Supabase → 6× Firebase). **(done)**

**Provision prod GCP** — exact `gcloud` commands in [`gcp-migration-prod-provision.md`](gcp-migration-prod-provision.md).

- [x] ~~**Prod Cloud SQL instance** (separate from staging)~~ **OBSOLETE — 2026-07-22
      consolidation.** Prod is the `storemink` DATABASE inside the shared
      `storemink-prod-db` instance (schema + seed data already present). No
      separate instance to provision. `app`/`postgres` role passwords were reset
      to their Secret Manager values (`CLOUDSQL_PROD_APP_PW` /
      `CLOUDSQL_PROD_POSTGRES_PW`) so the secrets are the source of truth.
- [ ] **Prod Identity Platform / Firebase project** — separate from staging.
      Enable Email/Password, Email-link, Google, Phone; reCAPTCHA; **SMS region
      allowlist** (NOT `allowlistOnly:{}`); authorized domains; Google OAuth web
      client. (3 gotchas hit on staging: ADC quota project must match, enable
      `recaptchaenterprise.googleapis.com`, allowlist SMS regions.)
- [ ] **Prod media GCS bucket** (e.g. `storemink-media-prod`) — public, uniform
      access, CORS for video PUT. Keeps prod media isolated from staging's
      `storemink-media`, mirroring the two DB instances. _(origin of this list.)_
- [ ] **Prod secrets → Secret Manager:** `DB_PASSWORD`, `FIREBASE_PRIVATE_KEY`
      (+`FIREBASE_CLIENT_EMAIL`/`FIREBASE_PROJECT_ID`), `PAYMENT_CRED_KEY`,
      `RAZORPAY_KEY_ID`/`_KEY_SECRET`/`_WEBHOOK_SECRET`, `RESEND_API_KEY`,
      `CRON_SECRET`.
- [ ] **Cloud Run runtime SA + roles:** `aiplatform.user`,
      `secretmanager.secretAccessor`, `storage.objectAdmin` (prod bucket),
      **`cloudsql.client`**, `iam.serviceAccountTokenCreator`.

**Build + edge (in parallel with Vercel)**

- [ ] Build the Cloud Run image against the **migrated** stack — the current
      staging image predates Phase 5/6 (built against Supabase); rebuild.
- [ ] **External HTTPS Load Balancer + Certificate Manager wildcard cert** for
      `storemink.com` and `*.storemink.com` (Cloud Run has no native wildcard
      domain mapping).

---

## 2. Historical cutover rehearsal — do not repeat

- [ ] Apply the schema to prod Cloud SQL in order:
      `drizzle/manual/0000_compat_setup.sql` → `0001_schema.sql` →
      `0002_postflight.sql`.
- [ ] Apply `supabase/phase6_01_uid_columns_to_text.sql` **as `postgres`** (uid
      columns → text; entity PKs + `store_id` stay uuid).
- [ ] Full app pass against prod Cloud SQL (Host-header trick on the Cloud Run
      URL: `curl -H "X-Forwarded-Host: storemink.com" <run-url>/`).

> Do not repeat this hand-applied sequence on an existing environment. Existing
> databases now use `npm run db:migrate` and `public.schema_migrations`; see
> [`drizzle/manual/README.md`](../drizzle/manual/README.md). The runner verifies
> the baseline, records immutable checksums, and refuses the wrong database.
> This historical section is unrelated to the recovery-only, database-enforced
> read-only `db:migrate audit` command.

---

## 3. Cutover window — short downtime

**Data**

- [ ] Final Supabase `pg_dump --data-only` → load into prod Cloud SQL (per-table
      `DISABLE TRIGGER USER` + `--single-transaction`; drop `auth.users` FKs —
      see the Phase 5 load gotchas). Supabase uuid uids load into the text
      columns fine.
- [ ] **User import** into prod Identity Platform — `admin.auth().importUsers()`
      preserving each **uid + bcrypt** hash (from the Supabase `auth.users`
      dump). Imported uuid uids match the text `admins.id`/`users.id`, so every
      FK stays intact and no passwords reset.

**Media**

- [ ] Backfill existing media Supabase Storage → prod GCS bucket **+ rewrite DB
      URLs**. **Scope is tiny** (scan 2026-07-22): only **9** column-hits of
      `…supabase.co/storage/…` in each DB — `products.image_url` (3),
      `product_variants.image_url` (2), `blogs.cover_image_url` (1),
      `store_pages.sections`/`published_sections` (1 each, jsonb),
      `stores.settings` (1). These are WholeSip seed/legacy images; no real
      customer media (no prod traffic). Re-run the scan (dynamic loop over
      `information_schema.columns` for `%supabase.co/storage/%`) before cutover.
- [ ] Migrate the OG-image cache bucket ([`app/api/og-image/route.ts`](../app/api/og-image/route.ts)
      — only the `.supabase.co` SSRF allowlist entry remains, to keep proxying
      legacy media; no Supabase Storage writes remain in code).

**Deploy + DNS**

- [ ] Deploy Cloud Run: `--add-cloudsql-instances=<prod-instance>`, runtime SA,
      the **decoupled** env (explicit `FIREBASE_*` for the prod Firebase project + `GCP_PROJECT_ID=<infra project>`), `--set-secrets`.
- [x] Crons → **Cloud Scheduler** (`send-emails`, `plan-expiry`,
      `expire-pending-payments`) — **DONE 2026-07-30**, see `docs/cron-jobs.md`.
      ⚠ This box sat unticked long after the cutover, and prod ran with **zero**
      scheduled jobs in every region the whole time. Nothing was lost only
      because prod had 2 stores and 0 orders. `vercel.json` keeps its `crons`
      block as the record of intended schedules (annotated inert) rather than
      being deleted — deleting it would leave no reviewable trace of what the
      schedules are supposed to be.
- [ ] Flip DNS `storemink.com` + `*.storemink.com` → the LB IP. **Keep Vercel
      live as rollback.**

---

## 4. After — verify, then decommission

- [ ] Smoke-test prod: signup, login (email + Google), a storefront, a dashboard,
      place an order, upload an image + a video.
- [x] ~~Remove the Supabase Storage fallback from the 3 upload routes~~ **DONE** —
      code is Supabase-free; only the `.supabase.co` SSRF allowlist in
      `api/og-image` remains (intentional, for legacy media). After the media
      backfill, that allowlist entry can also be dropped.
- [x] ~~Drop `NEXT_PUBLIC_SUPABASE_*` + `SUPABASE_SERVICE_ROLE_KEY` from env~~
      **DONE** — no `SUPABASE_*` env is read by code anymore.
- [ ] Delete the Supabase project. Turn off Vercel.

**Hygiene (do sooner, not blocking)**

- [x] ~~Rotate the staging DB `app` password / delete staging users on the
      `storemink-staging` instance~~ **OBSOLETE — the `storemink-staging`
      instance was DELETED 2026-07-22** (consolidation). Staging now lives in the
      `storemink_staging` DB on `storemink-prod-db`. Its `app` password IS
      `CLOUDSQL_PROD_APP_PW` (shared instance). Durable backup of the deleted
      instance: `~/storemink-backups/old_staging_storemink_2026-07-22.sql`.
- [ ] Orphaned secrets `CLOUDSQL_STAGING_APP_PW` / `CLOUDSQL_STAGING_POSTGRES_PW`
      (no instance uses them) — delete whenever.
- [ ] Add the missing runtime secrets to `cloudbuild.yaml` `--set-secrets`:
      `RAZORPAY_KEY_ID`/`_KEY_SECRET`/`_WEBHOOK_SECRET`, `PAYMENT_CRED_KEY`
      (currently only `DB_PASSWORD`/`CRON_SECRET`/`RESEND_API_KEY` are set).

---

## Rollback

- **Application:** route traffic to the preceding healthy Cloud Run revision.
- **Database:** migrations are forward-only unless their reviewed runbook says
  otherwise. Restore to a separate database from PITR before considering an
  in-place restore; validate the data first.
- **Release rule:** an additive database migration may remain while the app is
  rolled back. Never execute a destructive SQL rollback merely to match an old
  image.
