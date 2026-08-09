-- =============================================================
-- §31 — imports become REAL background jobs.
--
-- Until now the chunk loop ran in the merchant's BROWSER: the file was parsed
-- there and posted a slice at a time, so closing the tab stopped the import
-- half-applied. That was a deliberate answer to two hard limits — a server
-- action's body cap and Cloud Run's request timeout — but it made "start it
-- and get on with your day" impossible.
--
-- This moves the work server-side. The file is uploaded ONCE, stored here, and
-- a worker (/api/cron/import-worker) processes it a time-boxed slice at a time,
-- chaining itself until the file is done. The browser's only job is the upload.
--
-- ⚠ A SEPARATE FILE ON PURPOSE. import_export_01_jobs.sql has already run in
-- production, and it is a `CREATE TABLE IF NOT EXISTS` — editing it to add a
-- column is a silent no-op, which is exactly how `subscriptions_01_schema.sql`
-- shipped a column prod never got (CODEBASE §15b). Anything added to an
-- existing table needs its own migration.
--
-- ⚠ Run as `postgres` against the target Cloud SQL database (through the Cloud
-- SQL Auth Proxy). Idempotent.
-- =============================================================

-- ── data_jobs: where the worker is up to, and who is holding the job ────────

-- The next row index to read, 0-based, counting DATA rows (the header is not
-- one). Distinct from `processed_rows`, which counts rows we finished with:
-- they move together today, but conflating "where to resume" with "how much
-- got done" is how a resumed job silently reprocesses or skips a slice.
ALTER TABLE data_jobs
  ADD COLUMN IF NOT EXISTS cursor INTEGER NOT NULL DEFAULT 0;

-- ★ THE LEASE IS WHAT STOPS TWO WORKERS ON ONE FILE. The worker chains itself
-- and a cron sweep also picks up stalled jobs, so two runs CAN overlap — and
-- because importing is not idempotent (a create is a create), overlapping runs
-- would double-import a slice. A claim sets this a couple of minutes out; only
-- a job whose lease has EXPIRED is claimable again, which is also what lets a
-- job survive a worker that died mid-slice without a human noticing.
ALTER TABLE data_jobs
  ADD COLUMN IF NOT EXISTS lease_until TIMESTAMPTZ;

-- How many times a worker has claimed this job. Bounded retries: a job that
-- keeps dying (a row that reliably crashes the importer, an OOM) must give up
-- rather than be re-claimed by every sweep for the rest of time.
ALTER TABLE data_jobs
  ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;

-- The worker's claim query: the oldest queued job whose lease is free.
CREATE INDEX IF NOT EXISTS data_jobs_claimable_idx
  ON data_jobs (created_at)
  WHERE status = ANY (ARRAY['pending'::text, 'running'::text]);

-- ── The uploaded file ───────────────────────────────────────────────────────
--
-- ★★ IN POSTGRES, NOT THE MEDIA BUCKET, AND THAT IS A SECURITY DECISION.
-- The GCS bucket this app uses is `allUsers:objectViewer` with uniform
-- bucket-level access (lib/storage/gcs.ts) — every object in it is readable by
-- anyone with the URL. An import file is the merchant's raw data, and the same
-- code path carries an orders-shaped CSV with customer names, addresses and
-- phone numbers. Putting that behind an unguessable public URL is obscurity,
-- not access control. Here it is service-role only, like every other table in
-- this feature, and it is deleted with its job for free.
--
-- A separate table rather than a column on data_jobs: the job row is read by
-- the history list, the detail page and the failures feed, and none of them
-- want to drag a 25 MB text field along for the ride.
CREATE TABLE IF NOT EXISTS data_job_payloads (
  -- One payload per job, so the job id IS the key.
  job_id      UUID PRIMARY KEY REFERENCES data_jobs(id) ON DELETE CASCADE,
  store_id    UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  -- The parsed header row, so the worker doesn't re-derive it per slice.
  header      JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- The file exactly as uploaded. Postgres TOASTs this out of line, so a large
  -- import costs nothing on reads of the job row itself.
  csv         TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Retention (§32) prunes by created_at alone, which a (store_id, created_at)
-- composite cannot serve.
CREATE INDEX IF NOT EXISTS data_job_payloads_created_idx
  ON data_job_payloads (created_at);

-- Service-role only, exactly like data_jobs and data_job_issues. No policies
-- by design — this table holds the merchant's raw file.
ALTER TABLE data_job_payloads ENABLE ROW LEVEL SECURITY;

-- =============================================================
-- Rollback:
--   DROP TABLE IF EXISTS data_job_payloads;
--   DROP INDEX IF EXISTS data_jobs_claimable_idx;
--   ALTER TABLE data_jobs DROP COLUMN IF EXISTS attempts;
--   ALTER TABLE data_jobs DROP COLUMN IF EXISTS lease_until;
--   ALTER TABLE data_jobs DROP COLUMN IF EXISTS cursor;
-- =============================================================
