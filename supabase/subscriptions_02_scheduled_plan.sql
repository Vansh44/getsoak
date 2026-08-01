-- store_subscriptions.scheduled_plan — repairing a column that never landed.
--
-- Run as `postgres`.
--
-- ── What went wrong ─────────────────────────────────────────────────────────
-- subscriptions_01_schema.sql CREATEs the table with `scheduled_plan`. But that
-- file was edited AFTER prod had already run it, and its body is
-- `CREATE TABLE IF NOT EXISTS` — so re-running is a silent no-op and the new
-- column never arrived. Prod ended up with a table that matched an older
-- version of the file while the code expected the newer one.
--
-- The symptom was every subscription attempt failing with
-- "Couldn't start the subscription", because Drizzle writes every column it
-- knows about:
--     ERROR: column "scheduled_plan" of relation "store_subscriptions"
--            does not exist
-- and worse, the Razorpay subscription is created BEFORE that insert — so each
-- failed attempt left an orphaned subscription at the gateway.
--
-- ── The lesson ──────────────────────────────────────────────────────────────
-- Editing a `CREATE TABLE IF NOT EXISTS` migration only works for environments
-- that have not run it yet. Anything added to an existing table needs its OWN
-- additive migration, like this one. Don't add columns to subscriptions_01.

BEGIN;

ALTER TABLE public.store_subscriptions
  ADD COLUMN IF NOT EXISTS scheduled_plan text;

DO $$
BEGIN
  ALTER TABLE public.store_subscriptions
    ADD CONSTRAINT store_subscriptions_scheduled_plan_check
    CHECK (scheduled_plan IS NULL OR scheduled_plan IN ('basic', 'pro'));
EXCEPTION
  WHEN duplicate_object THEN NULL; -- already there; re-running must be safe
END $$;

COMMENT ON COLUMN public.store_subscriptions.scheduled_plan IS
  'Plan tier taking effect at the next renewal. NULL = no tier change pending. Paired with scheduled_period (plans_04); either or both may be set.';

COMMIT;

-- ── Rollback ────────────────────────────────────────────────────────────────
-- BEGIN;
-- ALTER TABLE public.store_subscriptions
--   DROP CONSTRAINT IF EXISTS store_subscriptions_scheduled_plan_check;
-- ALTER TABLE public.store_subscriptions DROP COLUMN IF EXISTS scheduled_plan;
-- COMMIT;
