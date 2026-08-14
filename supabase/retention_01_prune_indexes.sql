-- Retention sweep indexes (CODEBASE §32).
--
-- `lib/retention/prune.ts` now sweeps `data_jobs` and `data_job_issues`, whose
-- delete pass filters on `created_at` ALONE. Both tables only carried COMPOSITE
-- indexes led by `store_id`:
--
--   data_jobs_store_created_idx   (store_id, created_at DESC)
--   data_job_issues_store_idx     (store_id, created_at DESC)
--
-- Postgres cannot use either for a bare `WHERE created_at < $1`, because the
-- leading column is unconstrained — so the nightly sweep would sequential-scan
-- the whole table on every batch, and each batch is a fresh transaction.
--
-- ⚠ `data_jobs_claimable_idx` is on `created_at` but PARTIAL
-- (`WHERE status IN ('pending','running')`), so it is useless here: the sweep
-- is looking for OLD rows, which are exactly the finished ones the partial
-- index excludes.
--
-- `billing_webhook_events` needs nothing added — it already has a plain
-- `received_at` index, which is the column its policy filters on.
--
-- ⚠ ITS OWN FILE, not an edit to `import_export_01_jobs.sql`. That file has
-- already been applied in production, and editing an applied
-- `CREATE TABLE IF NOT EXISTS` migration is a SILENT no-op — the incident
-- CODEBASE §15b records for `subscriptions_02`. Re-running this file is safe.
--
-- Apply as `postgres` via the Cloud SQL proxy, like every other migration here.

create index if not exists data_jobs_created_idx
  on public.data_jobs (created_at);

create index if not exists data_job_issues_created_idx
  on public.data_job_issues (created_at);

-- ── Verify ──────────────────────────────────────────────────────────────────
-- Both must report a real index, not a partial or composite one.
do $$
declare
  missing text;
begin
  select string_agg(t, ', ')
    into missing
  from (values ('data_jobs'), ('data_job_issues')) as v(t)
  where not exists (
    select 1
    from pg_indexes
    where schemaname = 'public'
      and tablename = v.t
      and indexdef like '%(created_at)%'
      and indexdef not like '%WHERE%'
  );

  if missing is not null then
    raise exception 'retention_01: created_at index missing on %', missing;
  end if;

  raise notice 'retention_01: created_at indexes present on data_jobs and data_job_issues';
end $$;

-- ── Rollback ────────────────────────────────────────────────────────────────
-- drop index if exists public.data_jobs_created_idx;
-- drop index if exists public.data_job_issues_created_idx;
