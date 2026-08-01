-- Scheduled billing-period changes.
--
-- Run as `postgres`.
--
-- store_subscriptions.scheduled_plan already records "move to this TIER at the
-- next renewal". It cannot express "same tier, different billing period", and
-- that is now a change we support (yearly → monthly is a downgrade, so it is
-- always scheduled rather than applied immediately).
--
-- Without this column a same-tier period change is invisible and, worse,
-- self-cancelling: the webhook clears a scheduled change once billing moves to
-- `scheduled_plan`, and for a period-only change the plan never changes — so
-- the schedule would be cleared on the very next renewal event while the period
-- switch was still pending.

BEGIN;

ALTER TABLE public.store_subscriptions
  ADD COLUMN IF NOT EXISTS scheduled_period text;

COMMENT ON COLUMN public.store_subscriptions.scheduled_period IS
  'Billing period that takes effect at the next renewal (monthly|yearly). NULL = no period change pending. Paired with scheduled_plan; either or both may be set.';

ALTER TABLE public.store_subscriptions
  ADD CONSTRAINT store_subscriptions_scheduled_period_check
  CHECK (scheduled_period IS NULL OR scheduled_period IN ('monthly', 'yearly'));

COMMIT;

-- ── Rollback ────────────────────────────────────────────────────────────────
-- BEGIN;
-- ALTER TABLE public.store_subscriptions
--   DROP CONSTRAINT IF EXISTS store_subscriptions_scheduled_period_check;
-- ALTER TABLE public.store_subscriptions DROP COLUMN IF EXISTS scheduled_period;
-- COMMIT;
