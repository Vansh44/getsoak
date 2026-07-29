-- Locations Phase F follow-up — the "collect it soon" nudge.
--
-- Run as `postgres`, after locations_05.
--
-- ── Why a column and not a schedule ────────────────────────────────────────
-- The reminder must fire ONCE per order. Two things make that hard:
--
--   * the cron is a heartbeat, not an alarm clock — it re-reads the same rows
--     every run, so "expires within 24 hours" is true on consecutive runs if
--     the schedule tightens or a run is retried; and
--   * `notifications` is UNIQUE on (event, recipient), but each emit creates a
--     NEW event row, so that constraint cannot dedupe a repeated send.
--
-- So the order itself records that it was warned, and the job CLAIMS the
-- transition (`pickup_warned_at IS NULL` → now()) in one conditional UPDATE —
-- the same exactly-once pattern as the cancel-restock claim and the
-- awaiting→collected hand-over. A merchant nagging a customer daily about the
-- same box is precisely the failure that makes people stop reading the mail.

BEGIN;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS pickup_warned_at timestamptz;

-- The reminder job's whole query: unwarned pickups still waiting, by deadline.
-- Partial, because warned and non-pickup rows are the overwhelming majority.
CREATE INDEX IF NOT EXISTS orders_pickup_unwarned_idx
  ON public.orders (pickup_expires_at)
  WHERE fulfilment_type = 'pickup'
    AND pickup_warned_at IS NULL
    AND pickup_status IN ('awaiting', 'ready');

COMMENT ON COLUMN public.orders.pickup_warned_at IS
  'When the pre-expiry reminder was sent. NULL = not yet warned; the job claims this transition so the nudge fires exactly once.';

COMMIT;

-- ── Rollback ────────────────────────────────────────────────────────────────
-- BEGIN;
-- DROP INDEX IF EXISTS public.orders_pickup_unwarned_idx;
-- ALTER TABLE public.orders DROP COLUMN IF EXISTS pickup_warned_at;
-- COMMIT;
