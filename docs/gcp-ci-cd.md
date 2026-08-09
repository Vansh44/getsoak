# CI/CD — Cloud Build → Cloud Run (per environment)

Push-to-deploy for both environments, driven by [`cloudbuild.yaml`](../cloudbuild.yaml):

| Branch    | Builds & deploys to         | Firebase / DB / bucket                                          |
| --------- | --------------------------- | --------------------------------------------------------------- |
| `staging` | `storemink-web` (staging)   | `storemink-staging` / `storemink-staging` / `storemink-media`   |
| `main`    | `storemink-web-prod` (prod) | `storemink-prod` / `storemink-prod-db` / `storemink-media-prod` |

Flow going forward: `f1` → merge to `staging` (auto-deploys staging, verify) →
merge `staging` to `main` (auto-deploys prod).

---

## Why the first CI build failed

Cloud Run's built-in "Deploy from repository" created a trigger with **no build
config** — it did a bare Dockerfile build with **zero `--build-arg`s**. So
`NEXT_PUBLIC_ROOT_DOMAIN` was empty at build time, and `next build` crashed:

```
Failed to collect page data for /_not-found
TypeError: Invalid URL, input: 'https:'
```

`NEXT_PUBLIC_*` are **baked into the client bundle at build time**, so they must
be passed as Docker build args (only `cloudbuild.yaml` does this). The empty
`ROOT_DOMAIN` produced `PLATFORM_URL = "https:"` → `new URL("https:")` throws.

Two-part fix (both in this commit):

1. **Code safety net** — `lib/store/host.ts` now uses `|| "storemink.com"` (not
   `??`), so an empty env degrades to the apex instead of crashing. Belt-and-
   suspenders; the trigger must still pass the real values.
2. **`cloudbuild.yaml` is now a full build → deploy pipeline** with per-env
   substitutions (below). Replace the built-in trigger with two that use it.
   The build step runs `docker buildx` with registry-backed layer caching: it
   pushes the image itself (no separate push step) and also writes a per-env
   `web:buildcache-<tag>` cache image to the same Artifact Registry repo, so the
   first build after this change is a cold cache and later builds skip an
   unchanged `npm ci`. No new IAM/substitution — the cache tag is derived from
   `_IMAGE` and reuses the SA's existing Artifact Registry write access.

---

## One-time IAM (Cloud Build service account)

Both triggers run as the Compute Engine default SA
`705863961054-compute@developer.gserviceaccount.com`. It already has
build/push/log perms; grant it deploy perms (idempotent):

```bash
# Deploy to Cloud Run
gcloud projects add-iam-policy-binding storemink-prod \
  --member="serviceAccount:705863961054-compute@developer.gserviceaccount.com" \
  --role="roles/run.admin"

# Act AS the runtime SA (the deploy sets the service to run as storemink-run)
gcloud iam service-accounts add-iam-policy-binding \
  storemink-run@storemink-prod.iam.gserviceaccount.com \
  --project=storemink-prod \
  --member="serviceAccount:705863961054-compute@developer.gserviceaccount.com" \
  --role="roles/iam.serviceAccountUser"
```

---

## Create the two triggers

The repo uses a 1st-gen GitHub App connection (`Vansh44/storemink`), so plain
`gcloud builds triggers create github` works.

> **`<STAGING_WEB_API_KEY>` / `<PROD_WEB_API_KEY>`** — the Firebase **web**
> apiKey. It's PUBLIC (it ships in the client bundle), so it's fine in a trigger
> config, but it's kept OUT of the tracked repo to avoid GitHub secret-scanning
> alerts. Fetch each from its project:
>
> ```bash
> gcloud auth application-default set-quota-project storemink-prod  # once
> curl -s -H "Authorization: Bearer $(gcloud auth print-access-token)" \
>   -H "X-Goog-User-Project: <PROJECT>" \
>   "https://firebase.googleapis.com/v1beta1/projects/<PROJECT>/webApps/-/config"
> ```
>
> (`<PROJECT>` = `storemink-staging` or `storemink-prod`) — or Firebase console →
> Project settings → Your apps → Web app → SDK config.
>
> **Real hardening (do this once per key):** in Google Cloud console →
> APIs & Services → Credentials → the "Browser key", set **Application
> restrictions** = HTTP referrers (your domains) and **API restrictions** =
> Identity Toolkit + Token Service + the Firebase APIs you use. That, not
> secrecy, is what protects a public web key.

### Staging (`staging` → `storemink-web`)

Only the 6 Firebase values differ from the `cloudbuild.yaml` defaults, but we
pass the full set so the trigger is self-documenting:

```bash
gcloud builds triggers create github \
  --project=storemink-prod --region=global \
  --name=storemink-web-staging \
  --repo-owner=Vansh44 --repo-name=storemink \
  --branch-pattern='^staging$' \
  --build-config=cloudbuild.yaml \
  --service-account=projects/storemink-prod/serviceAccounts/705863961054-compute@developer.gserviceaccount.com \
  --substitutions='_IMAGE=asia-south1-docker.pkg.dev/storemink-prod/storemink/web:staging,_SERVICE=storemink-web,_MIN_INSTANCES=0,_DB_CONN=storemink-prod:asia-south1:storemink-prod-db,_DB_NAME=storemink_staging,_DB_PASSWORD_SECRET=CLOUDSQL_PROD_APP_PW,_GCS_BUCKET=storemink-media,_FIREBASE_PROJECT_ID=storemink-staging,_FIREBASE_SA_ID=firebase-adminsdk-fbsvc@storemink-staging.iam.gserviceaccount.com,_NEXT_PUBLIC_FIREBASE_API_KEY=<STAGING_WEB_API_KEY>,_NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=storemink-staging.firebaseapp.com,_NEXT_PUBLIC_FIREBASE_PROJECT_ID=storemink-staging,_NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=storemink-staging.firebasestorage.app,_NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=68037646295,_NEXT_PUBLIC_FIREBASE_APP_ID=1:68037646295:web:388ef47d32e39c822b1d92,_NEXT_PUBLIC_ROOT_DOMAIN=staging.storemink.com,_NEXT_PUBLIC_APP_URL=https://staging.storemink.com'
```

### Production (`main` → `storemink-web-prod`)

```bash
gcloud builds triggers create github \
  --project=storemink-prod --region=global \
  --name=storemink-web-prod \
  --repo-owner=Vansh44 --repo-name=storemink \
  --branch-pattern='^main$' \
  --build-config=cloudbuild.yaml \
  --service-account=projects/storemink-prod/serviceAccounts/705863961054-compute@developer.gserviceaccount.com \
  --substitutions='_IMAGE=asia-south1-docker.pkg.dev/storemink-prod/storemink/web:prod,_SERVICE=storemink-web-prod,_MIN_INSTANCES=0,_DB_CONN=storemink-prod:asia-south1:storemink-prod-db,_DB_NAME=storemink,_DB_PASSWORD_SECRET=CLOUDSQL_PROD_APP_PW,_GCS_BUCKET=storemink-media-prod,_FIREBASE_PROJECT_ID=storemink-prod,_FIREBASE_SA_ID=firebase-adminsdk-fbsvc@storemink-prod.iam.gserviceaccount.com,_NEXT_PUBLIC_FIREBASE_API_KEY=<PROD_WEB_API_KEY>,_NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=storemink-prod.firebaseapp.com,_NEXT_PUBLIC_FIREBASE_PROJECT_ID=storemink-prod,_NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=storemink-prod.firebasestorage.app,_NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=705863961054,_NEXT_PUBLIC_FIREBASE_APP_ID=1:705863961054:web:e326046a5f9f7b7de9f54f,_NEXT_PUBLIC_ROOT_DOMAIN=storemink.com,_NEXT_PUBLIC_APP_URL=https://storemink.com,_GOOGLE_SEARCH_CONSOLE_PROPERTY=sc-domain:storemink.com,_POS_SESSION_SECRET_SECRET=POS_SESSION_SECRET_PROD,_PAYMENT_CRED_KEY_SECRET=PAYMENT_CRED_KEY_PROD,_RAZORPAY_KEY_ID_SECRET=RAZORPAY_KEY_ID_PROD,_RAZORPAY_KEY_SECRET_SECRET=RAZORPAY_KEY_SECRET_PROD,_RAZORPAY_WEBHOOK_SECRET_SECRET=RAZORPAY_WEBHOOK_SECRET_PROD,_RESEND_WEBHOOK_SECRET_SECRET=RESEND_WEBHOOK_SECRET_PROD,_DOMAIN_ENV=prod'
```

> **⚠ The prod trigger must override every per-env secret NAME.** The
> `cloudbuild.yaml` defaults all target STAGING, so anything the prod trigger
> omits silently inherits a staging secret — prod would run on Razorpay TEST
> keys, and a `PAYMENT_CRED_KEY` mismatch cannot decrypt prod-stored gateway
> creds. The `*_SECRET` substitutions above were absent from this command
> until 2026-07-27 (and `_RESEND_WEBHOOK_SECRET_SECRET` until 2026-08-01);
> verify the live trigger actually carries them:
>
> ```bash
> gcloud builds triggers describe storemink-web-prod \
>   --project=storemink-prod --region=global \
>   --format='value(substitutions)'
> ```

---

## Delete the broken built-in trigger

```bash
gcloud builds triggers delete rmgpgab-storemink-web-asia-south1-Vansh44-storemink--stagiufd \
  --project=storemink-prod --region=global
```

---

## Substitution reference (staging vs prod)

| Substitution                                | Staging                                                             | Production                                                       |
| ------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `_SERVICE`                                  | `storemink-web`                                                     | `storemink-web-prod`                                             |
| `_IMAGE` (tag)                              | `…/storemink/web:staging`                                           | `…/storemink/web:prod`                                           |
| `_MIN_INSTANCES`                            | `0`                                                                 | `0` (was `1` — see below)                                        |
| `_DB_POOL_MAX`                              | `5`                                                                 | `5`                                                              |
| `_DB_CONN`                                  | `storemink-prod:asia-south1:storemink-prod-db`                      | `storemink-prod:asia-south1:storemink-prod-db`                   |
| `_DB_NAME`                                  | `storemink_staging`                                                 | `storemink`                                                      |
| `_DB_PASSWORD_SECRET`                       | `CLOUDSQL_PROD_APP_PW`                                              | `CLOUDSQL_PROD_APP_PW`                                           |
| `_GCS_BUCKET`                               | `storemink-media`                                                   | `storemink-media-prod`                                           |
| `_FIREBASE_PROJECT_ID`                      | `storemink-staging`                                                 | `storemink-prod`                                                 |
| `_FIREBASE_SA_ID` (custom-token signer)     | `firebase-adminsdk-fbsvc@storemink-staging.iam.gserviceaccount.com` | `firebase-adminsdk-fbsvc@storemink-prod.iam.gserviceaccount.com` |
| `_NEXT_PUBLIC_FIREBASE_API_KEY`             | `<STAGING_WEB_API_KEY>`                                             | `<PROD_WEB_API_KEY>`                                             |
| `_NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`         | `storemink-staging.firebaseapp.com`                                 | `storemink-prod.firebaseapp.com`                                 |
| `_NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`      | `storemink-staging.firebasestorage.app`                             | `storemink-prod.firebasestorage.app`                             |
| `_NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` | `68037646295`                                                       | `705863961054`                                                   |
| `_NEXT_PUBLIC_FIREBASE_APP_ID`              | `1:68037646295:web:388ef47d32e39c822b1d92`                          | `1:705863961054:web:e326046a5f9f7b7de9f54f`                      |
| `_NEXT_PUBLIC_ROOT_DOMAIN`                  | `staging.storemink.com`                                             | `storemink.com`                                                  |
| `_DOMAIN_ENV`                               | `stg` (default)                                                     | **`prod` — must be set explicitly**                              |
| `_DOMAIN_CERT_MAP`                          | `prod-cert-map`                                                     | `prod-cert-map`                                                  |
| `_DOMAIN_LB_IP`                             | `136.69.75.127`                                                     | `136.69.75.127`                                                  |
| `_NEXT_PUBLIC_APP_URL`                      | `https://staging.storemink.com`                                     | `https://storemink.com`                                          |
| `_GOOGLE_SEARCH_CONSOLE_PROPERTY`           | _(empty — staging is never indexed)_                                | `sc-domain:storemink.com`                                        |
| `_POS_SESSION_SECRET_SECRET`                | `POS_SESSION_SECRET_STAGING`                                        | `POS_SESSION_SECRET_PROD`                                        |
| `_RESEND_WEBHOOK_SECRET_SECRET`             | `RESEND_WEBHOOK_SECRET_STAGING`                                     | `RESEND_WEBHOOK_SECRET_PROD`                                     |

> **⚠ COST CUTS OF 2026-08-10 — three values here are now tuned for spend, not
> for headroom.** Monthly GCP was tracking to ~₹6,400 and had to come down.
>
> - **`_MIN_INSTANCES` on prod went `1` → `0`.** The always-warm instance cost
>   ~₹700/month. Prod now scales to zero; a measured cold start is ~1.2 s
>   (`https://storemink.com`, first hit after idle). The original reason for
>   pinning it to 1 was Firebase session-cookie verification latency
>   ([phase-4 §126](gcp-migration-phase4-cloud-run.md)) — that cost is now paid
>   on the first request after an idle period instead of never. Put it back to
>   `1` the moment real traffic makes the cold start visible to shoppers.
> - **The Cloud SQL instance went `db-g1-small` → `db-f1-micro`** (~₹1,700/month).
>   0.6 GB RAM, shared core, **not covered by the Cloud SQL SLA** — Google
>   positions shared-core tiers as dev/test. This is the first thing to revert
>   if the database misbehaves under load:
>   `gcloud sql instances patch storemink-prod-db --tier=db-g1-small` (restarts
>   the instance; the downgrade itself took ~12 minutes).
> - **`_DB_POOL_MAX` is new, and it exists BECAUSE of that tier.** `f1-micro`'s
>   default `max_connections` is ~25, down from ~50 on `g1-small`, and staging
>   and prod share the one instance. See the comment in `cloudbuild.yaml` for
>   the arithmetic. `lib/db/client.ts` defaults to 10, so leaving this unset
>   doubles the exposure — always pass it.
>
> **Backups were OFF on `storemink-prod-db` until 2026-08-10** — the instance was
> created without `--backup` and nobody had noticed, with paying merchants on it.
> Now: **daily automated backups at 20:30 UTC (02:00 IST), 7 retained.**
> **Point-in-time recovery is ON** as of 2026-08-10, with 7 days of transaction
> logs, so a restore can target a moment rather than losing up to 24 hours of
> writes back to the nightly snapshot. It was enabled the same day the
> cancellation, refund and returns paths went live against real Razorpay keys —
> a daily-snapshot-only window is not something to run a payments path on.
> Enabling it archives WAL and therefore costs some storage; that was accepted
> deliberately, against a cut that had already saved ~₹3,100/month.

> **POS_SESSION_SECRET is required for the register to work at all.** It signs
> the `pos_device` / `pos_operator` cookies (`lib/pos/session.ts`). Verification
> degrades quietly without it, but MINTING does not — so with the secret absent,
> "Authorize this device" and cashier PIN login both fail. It was missing from
> this file until 2026-07-27, which is exactly how staging shipped a POS that
> 500'd on every authorize attempt. Per-env, like `PAYMENT_CRED_KEY`: this key
> mints register credentials, so a leaked staging value must not forge a device
> cookie against prod. Create each once:
>
> ```bash
> printf '%s' "$(openssl rand -base64 32)" | gcloud secrets create POS_SESSION_SECRET_STAGING \
>   --project=storemink-prod --data-file=-
> ```

> **⚠ RESEND_WEBHOOK_SECRET must exist BEFORE this config deploys.** Cloud Run
> fails a revision outright when `--set-secrets` names a secret that isn't in
> Secret Manager, so creating both entries is a PREREQUISITE of merging the
> `cloudbuild.yaml` change, not a follow-up. Unlike `POS_SESSION_SECRET` there
> is nothing to generate — the value is Resend's, minted when you register the
> endpoint, so the order is: add the endpoint in Resend → copy its `whsec_…` →
> create the secret → merge.
>
> Per **endpoint**, hence per env (`RESEND_API_KEY` is one account-wide key and
> stays unsubstituted). In the Resend dashboard → Webhooks, add one endpoint per
> environment subscribed to `email.bounced` + `email.complained`:
>
> | env     | endpoint                                            | secret                          |
> | ------- | --------------------------------------------------- | ------------------------------- |
> | staging | `https://staging.storemink.com/api/webhooks/resend` | `RESEND_WEBHOOK_SECRET_STAGING` |
> | prod    | `https://storemink.com/api/webhooks/resend`         | `RESEND_WEBHOOK_SECRET_PROD`    |
>
> ```bash
> printf '%s' 'whsec_…' | gcloud secrets create RESEND_WEBHOOK_SECRET_PROD \
>   --project=storemink-prod --data-file=-
> ```
>
> Why it matters: this endpoint is how the app learns an address is dead
> (`email_suppressions`, CODEBASE §24). Unset, the route logs a warning and
> drops every event — so nothing is ever suppressed and dead addresses are
> mailed forever on a sending domain whose reputation is shared by every store.
> It fails silently in exactly the direction you don't notice.

Staging is never indexed (its `ROOT_DOMAIN` isn't the prod apex), so it needs no
Search Console property. On prod, the runtime SA `_RUN_SA` authenticates to
Search Console via ADC — grant it access to the property once (see
`docs/seo-indexing.md`); there is no key/secret to store.

> **⚠ Shared database instance.** Staging and prod share ONE Cloud SQL instance
> (`storemink-prod-db`); staging is the `storemink_staging` database, prod is
> `storemink`. Both triggers point `_DB_CONN` at the same instance, so the ONLY
> thing separating them is `_DB_NAME`. **Both triggers must set `_DB_NAME`
> explicitly** — if prod ever omitted it and fell back to the `cloudbuild.yaml`
> default (`storemink_staging`), prod would silently run against the staging
> database. There is one cluster-wide `app` role, so both use
> `CLOUDSQL_PROD_APP_PW`; staging credentials can therefore reach the prod
> database if `_DB_NAME` is wrong. Before onboarding real customers, either
> split staging back onto its own instance or add a restricted `app_staging`
> role (own secret + a `_DB_USER` substitution) so this is impossible.

The Firebase `apiKey` and app id are public (they ship in the client bundle) —
not secrets. Real secrets (`DB_PASSWORD`, `CRON_SECRET`) come from Secret Manager
at deploy time via `--set-secrets`; add `RESEND_API_KEY`, `PAYMENT_CRED_KEY`,
`RAZORPAY_*` there when those features go live.
