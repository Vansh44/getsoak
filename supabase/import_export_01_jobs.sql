-- =============================================================
-- CSV import/export jobs + their per-row error log (CODEBASE.md §31).
--
-- Two tables, because they answer two different questions and one of them is
-- unbounded:
--
--   data_jobs        — one row per import or export. "What did I run, when,
--                      how did it go?" Small, kept, and what the history page
--                      lists.
--   data_job_issues  — one row per PROBLEM. "Which of my 4,000 rows failed and
--                      why?" This is the error log the merchant actually acts
--                      on, and it is the only part of the feature that can
--                      grow without limit, so the app layer caps how many are
--                      written per job (IMPORT_ISSUE_CAP) and records the
--                      overflow as a count on the job.
--
-- ★ AN IMPORT IS ROW-ATOMIC, NOT FILE-ATOMIC, and this schema is what makes
-- that honest. A 500-row file with 3 bad rows imports 497 and reports 3 — the
-- alternative (fail the file) means a merchant fixes one typo and re-uploads,
-- and the alternative to THAT (fail silently) means they never learn. So the
-- job carries a `partial` status as a first-class outcome and the counters
-- always add up: created + updated + skipped + failed = processed_rows.
--
-- ⚠ Service-role only — RLS ON with NO policies, the email_logs pattern. These
-- rows quote raw cells from the merchant's file, which for an orders export
-- means customer names and addresses. Reads go through the app layer, which
-- gates on the `activity` permission section AND scopes to the host store.
--
-- ⚠ Run as `postgres` against the target Cloud SQL database (through the Cloud
-- SQL Auth Proxy). Idempotent.
-- =============================================================

CREATE TABLE IF NOT EXISTS data_jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id        UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,
  -- Free text on purpose: the registry lives in lib/import-export/resources.ts
  -- and an old job row must keep its meaning after a resource is renamed.
  resource        TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  -- What the merchant uploaded / what we offered to download. Display only.
  filename        TEXT,

  -- Counters. `total_rows` is what the file claimed; `processed_rows` is what
  -- we actually reached, and they differ when a job is cancelled or dies.
  total_rows      INTEGER NOT NULL DEFAULT 0,
  processed_rows  INTEGER NOT NULL DEFAULT 0,
  created_count   INTEGER NOT NULL DEFAULT 0,
  updated_count   INTEGER NOT NULL DEFAULT 0,
  skipped_count   INTEGER NOT NULL DEFAULT 0,
  failed_count    INTEGER NOT NULL DEFAULT 0,
  warning_count   INTEGER NOT NULL DEFAULT 0,
  -- Issues that happened but were NOT written to data_job_issues because the
  -- cap was hit. Without this the log silently looks complete.
  dropped_issues  INTEGER NOT NULL DEFAULT 0,

  -- The failure that killed the WHOLE job (a bad header, a lost database), as
  -- opposed to the per-row problems in data_job_issues.
  error           TEXT,
  -- Import options the run used (match column, whether it published, the
  -- location for a stock import). Kept so a surprising result can be explained
  -- months later. Never secrets — this is merchant-visible.
  options         JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Firebase uid — TEXT, not UUID (phase6_01_uid_columns_to_text.sql).
  created_by      TEXT,
  actor_email     TEXT,

  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT data_jobs_kind_check
    CHECK (kind = ANY (ARRAY['import'::text, 'export'::text])),
  CONSTRAINT data_jobs_status_check
    CHECK (status = ANY (ARRAY[
      'pending'::text, 'running'::text, 'completed'::text,
      'partial'::text, 'failed'::text, 'cancelled'::text
    ]))
);

-- The history list: one store's jobs, newest first.
CREATE INDEX IF NOT EXISTS data_jobs_store_created_idx
  ON data_jobs (store_id, created_at DESC);
-- "Show me just the imports" / "just the failures".
CREATE INDEX IF NOT EXISTS data_jobs_store_kind_idx
  ON data_jobs (store_id, kind, created_at DESC);
CREATE INDEX IF NOT EXISTS data_jobs_store_resource_idx
  ON data_jobs (store_id, resource, created_at DESC);
-- Finding a run that never finished (a closed tab mid-import), and retention.
CREATE INDEX IF NOT EXISTS data_jobs_running_idx
  ON data_jobs (status, updated_at)
  WHERE status = ANY (ARRAY['pending'::text, 'running'::text]);

CREATE TABLE IF NOT EXISTS data_job_issues (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id       UUID NOT NULL REFERENCES data_jobs(id) ON DELETE CASCADE,
  -- Denormalised from the job so a read can be store-scoped without a join —
  -- the same reason order_items carries store_id.
  store_id     UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  -- 1-based line in the merchant's ORIGINAL file, so the number in the error
  -- is the number their spreadsheet shows. 0 = a problem with the file itself
  -- (a missing column) rather than with any one row.
  line         INTEGER NOT NULL DEFAULT 0,
  -- `column` is reserved in SQL; this is the CSV header the issue is about.
  column_name  TEXT,
  code         TEXT NOT NULL,
  severity     TEXT NOT NULL,
  message      TEXT NOT NULL,
  -- The offending cell, truncated by the writer. Quoting it back is what turns
  -- "invalid number" into something a merchant can find and fix.
  value        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT data_job_issues_severity_check
    CHECK (severity = ANY (ARRAY['error'::text, 'warning'::text]))
);

-- The detail view: one job's issues, in file order. Errors before warnings so
-- the page's default view leads with what actually failed.
CREATE INDEX IF NOT EXISTS data_job_issues_job_idx
  ON data_job_issues (job_id, severity, line);
CREATE INDEX IF NOT EXISTS data_job_issues_store_idx
  ON data_job_issues (store_id, created_at DESC);

-- Keep updated_at honest without every writer remembering to set it.
CREATE OR REPLACE FUNCTION touch_data_jobs_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS data_jobs_touch_updated_at ON data_jobs;
CREATE TRIGGER data_jobs_touch_updated_at
  BEFORE UPDATE ON data_jobs
  FOR EACH ROW EXECUTE FUNCTION touch_data_jobs_updated_at();

-- Service-role only (see the header note). No policies by design.
ALTER TABLE data_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_job_issues ENABLE ROW LEVEL SECURITY;

-- =============================================================
-- Rollback:
--   DROP TABLE IF EXISTS data_job_issues;
--   DROP TABLE IF EXISTS data_jobs;
--   DROP FUNCTION IF EXISTS touch_data_jobs_updated_at();
-- =============================================================
