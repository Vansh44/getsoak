-- Locations — when a collection order will actually be ready.
--
-- Run as `postgres`, after locations_08.
--
-- `pickup_expires_at` says when an uncollected order lapses. It never said when
-- the shopper could COME — which is the first thing they want to know, and the
-- only date worth putting in the confirmation email.
--
-- ── Why the hold now starts at READY, not at order time ─────────────────────
-- Expiry used to be `now() + pickupHoldDays`. If a shop takes three days to
-- pick an order and the merchant holds for five, the shopper got two days to
-- collect, not five — a slow shop silently ate most of the customer's window,
-- and the busier the shop the shorter the window. Expiry is now
-- `ready_at + hold`, so the promise is the same for everyone.

BEGIN;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS pickup_ready_at timestamptz;

COMMENT ON COLUMN public.orders.pickup_ready_at IS
  'When the shop expects to have this order ready to collect. Set at order time from fulfilment.pickupReadyDays (0 = same day). pickup_expires_at is measured FROM this, so a slow shop cannot shorten the customer''s collection window.';

COMMIT;

-- ── Rollback ────────────────────────────────────────────────────────────────
-- BEGIN;
-- ALTER TABLE public.orders DROP COLUMN IF EXISTS pickup_ready_at;
-- COMMIT;
