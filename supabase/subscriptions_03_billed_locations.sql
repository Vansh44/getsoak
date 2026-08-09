-- store_subscriptions.billed_locations — metered extra POS locations.
-- Roadmap Step 5 / POS Phase 7. CODEBASE §22.
--
-- Run as `postgres`. Idempotent: safe to re-run.
--
-- ── Why its own file ────────────────────────────────────────────────────────
-- subscriptions_01_schema.sql is a `CREATE TABLE IF NOT EXISTS` that prod has
-- already run, so editing it to add this column would be a silent no-op there —
-- exactly the failure subscriptions_02 exists to document and repair. Anything
-- added to an existing table gets its own additive migration.
--
-- ── What it holds ───────────────────────────────────────────────────────────
-- The number of EXTRA locations this subscription is currently paying for, on
-- top of what the plan includes (`PLAN_LIMITS.posLocationsIncluded` — 2 on Pro).
-- It is ADDITIVE, never a total: if Pro's included count ever rises, a merchant
-- paying for 1 gains headroom rather than being billed for what became free.
--
-- ── Why a column and not a table ────────────────────────────────────────────
-- One integer per store, read on the same row the billing code already loads to
-- decide anything about a subscription. A `store_location_subscriptions` table
-- would be a join on every location read and a second row to keep in step with
-- the gateway — and there is nothing per-location to record here, because an
-- extra location is a PRICE, not an entity. Which shops exist is already
-- `store_locations`; this is only how many are paid for.
--
-- The cost is folded into the subscription's own amount (see
-- lib/plans/location-billing.ts for why: `razorpay_plans` is keyed on
-- (plan, period, amount), so a different location count resolves to a different
-- cached Razorpay plan with no schema change, and `planForRzpPlan` still maps
-- that id back to the right tier for the webhook).
--
-- ── Backfill ────────────────────────────────────────────────────────────────
-- DEFAULT 0, and that is the honest value: nobody has ever been able to buy an
-- extra location, so no existing subscription is paying for one. A migration
-- may not change what a live store does (roadmap invariant 1) — this one grants
-- nothing and charges nothing.

BEGIN;

ALTER TABLE public.store_subscriptions
  ADD COLUMN IF NOT EXISTS billed_locations integer NOT NULL DEFAULT 0;

DO $$
BEGIN
  ALTER TABLE public.store_subscriptions
    ADD CONSTRAINT store_subscriptions_billed_locations_check
    CHECK (billed_locations >= 0 AND billed_locations <= 50);
EXCEPTION
  WHEN duplicate_object THEN NULL; -- already there; re-running must be safe
END $$;

COMMENT ON COLUMN public.store_subscriptions.billed_locations IS
  'Extra POS locations this subscription pays for, ON TOP OF the plan''s included count (additive, never a total). Cost is folded into the subscription amount; see lib/plans/location-billing.ts. Upper bound mirrors MAX_EXTRA_LOCATIONS — the count becomes a charge against a live mandate, so it is bounded in the database too, not only in the action.';

COMMIT;

-- ── Rollback ────────────────────────────────────────────────────────────────
-- Dropping this does NOT stop anyone being charged: the amount lives in the
-- Razorpay plan the subscription is attached to. Move affected subscriptions
-- back to a location-free plan id FIRST, or they keep billing for locations
-- nothing here records.
--
-- BEGIN;
-- ALTER TABLE public.store_subscriptions
--   DROP CONSTRAINT IF EXISTS store_subscriptions_billed_locations_check;
-- ALTER TABLE public.store_subscriptions DROP COLUMN IF EXISTS billed_locations;
-- COMMIT;
