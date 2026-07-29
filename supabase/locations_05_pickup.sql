-- Locations Phase F — pick up in store (click & collect).
--
-- Run as `postgres`, after locations_04.
--
-- A shopper buys online and collects at a shop instead of having it delivered.
-- Three things that separates from a normal order:
--
--   1. The stock is HELD, not sold. It sits on that shop's shelf until someone
--      hands it over, so `hold_stock_at` (Phase E) is the whole point — a
--      pickup is the first real consumer of reservations.
--   2. The CUSTOMER chose the location. That overrides fulfilment routing
--      entirely: they are driving to a specific shop, and no strategy gets to
--      second-guess that.
--   3. It can expire. Nobody collects, the hold lapses, the order is cancelled
--      and refunded — so the units come back rather than being locked forever.
--
-- ── Why columns on `orders` and not a pickups table ─────────────────────────
-- A pickup IS an order — same money, same items, same invoice, same history.
-- A side table would mean every order read either joins it or silently ignores
-- a whole fulfilment mode, and the orders list would need to know about both.

BEGIN;

ALTER TABLE public.orders
  -- 'delivery' (everything today) | 'pickup'. Text, not a boolean: "is_pickup"
  -- has no room for ship-from-store or a locker, both of which are on the map.
  ADD COLUMN IF NOT EXISTS fulfilment_type text NOT NULL DEFAULT 'delivery',
  -- Where the shopper collects. Distinct from `location_id`, which is where
  -- stock came FROM — for a pickup they are the same shop, but for
  -- ship-from-store later they will not be.
  ADD COLUMN IF NOT EXISTS pickup_location_id uuid REFERENCES public.store_locations(id),
  -- awaiting | ready | collected | expired. NULL for a delivery.
  ADD COLUMN IF NOT EXISTS pickup_status text,
  ADD COLUMN IF NOT EXISTS pickup_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS collected_at timestamptz,
  ADD COLUMN IF NOT EXISTS collected_by text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_fulfilment_type_check') THEN
    ALTER TABLE public.orders ADD CONSTRAINT orders_fulfilment_type_check
      CHECK (fulfilment_type IN ('delivery', 'pickup'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_pickup_status_check') THEN
    ALTER TABLE public.orders ADD CONSTRAINT orders_pickup_status_check
      CHECK (pickup_status IS NULL
             OR pickup_status IN ('awaiting', 'ready', 'collected', 'expired'));
  END IF;
  -- A pickup with no location is an order nobody can collect and no shop is
  -- responsible for.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_pickup_needs_location') THEN
    ALTER TABLE public.orders ADD CONSTRAINT orders_pickup_needs_location
      CHECK (fulfilment_type <> 'pickup' OR pickup_location_id IS NOT NULL);
  END IF;
END $$;

-- The POS collection queue: this shop's orders still waiting, oldest first.
CREATE INDEX IF NOT EXISTS orders_pickup_queue_idx
  ON public.orders (pickup_location_id, pickup_status, created_at)
  WHERE fulfilment_type = 'pickup';

-- ---------------------------------------------------------------------------
-- Tie the order's holds to the order
-- ---------------------------------------------------------------------------
-- Phase E's stock_reservations already carries owner_type/owner_id, and a
-- pickup uses owner_type = 'pickup' with owner_id = the order id. This index
-- is what makes "settle every hold for this order" a single lookup at
-- hand-over and at expiry.
CREATE INDEX IF NOT EXISTS stock_reservations_pickup_order_idx
  ON public.stock_reservations (owner_id)
  WHERE owner_type = 'pickup' AND status = 'held';

COMMENT ON COLUMN public.orders.fulfilment_type IS
  'delivery (default) | pickup. Text, not a boolean — ship-from-store and lockers are on the roadmap.';
COMMENT ON COLUMN public.orders.pickup_location_id IS
  'Where the shopper collects. The customer chose it, so it OVERRIDES fulfilment routing.';

COMMIT;

-- ── Rollback ────────────────────────────────────────────────────────────────
-- BEGIN;
-- DROP INDEX IF EXISTS public.stock_reservations_pickup_order_idx;
-- DROP INDEX IF EXISTS public.orders_pickup_queue_idx;
-- ALTER TABLE public.orders
--   DROP CONSTRAINT IF EXISTS orders_pickup_needs_location,
--   DROP CONSTRAINT IF EXISTS orders_pickup_status_check,
--   DROP CONSTRAINT IF EXISTS orders_fulfilment_type_check;
-- ALTER TABLE public.orders
--   DROP COLUMN IF EXISTS collected_by,
--   DROP COLUMN IF EXISTS collected_at,
--   DROP COLUMN IF EXISTS pickup_expires_at,
--   DROP COLUMN IF EXISTS pickup_status,
--   DROP COLUMN IF EXISTS pickup_location_id,
--   DROP COLUMN IF EXISTS fulfilment_type;
-- COMMIT;
