-- Locations Phase E — real stock reservations.
--
-- Run as `postgres`, after locations_03.
--
-- ── What exists today, and why it isn't enough ──────────────────────────────
-- reserve_stock_at decrements `on_hand` immediately and writes a 'sale'
-- movement. That is atomic and unoversellable, and it is exactly right for a
-- COD order that is final the moment it is placed.
--
-- It cannot express a HOLD: "these 2 are spoken for but not yet sold." That is
-- what an unpaid online order, an uncollected pickup, and a marketplace sync
-- all need. `inventory_levels.reserved` has been carried since pos_01 for this
-- and never used.
--
-- ── The model ───────────────────────────────────────────────────────────────
--   available = on_hand - reserved
--
--   hold     reserved += qty                 (on_hand untouched — the goods are
--                                             still physically on the shelf)
--   commit   on_hand -= qty, reserved -= qty  (the sale actually happened)
--   release  reserved -= qty                  (it didn't)
--
-- ── ADDITIVE ON PURPOSE ─────────────────────────────────────────────────────
-- reserve_stock_at is NOT changed to hold-then-commit. Every current flow —
-- COD checkout, the POS register, cancellation restock — keeps working exactly
-- as it does now (invariant 5). Holds are a new capability that Phase F
-- (pickup) will use; the only change to existing behaviour is that both stock
-- guards now subtract `reserved`, so a hold genuinely protects the units.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The reservations themselves
-- ---------------------------------------------------------------------------
-- The `reserved` counter alone cannot say WHOSE hold it is or when it lapses,
-- so a hold that is never completed would lock stock forever. These rows are
-- what the sweeper walks.
CREATE TABLE IF NOT EXISTS public.stock_reservations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id    uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES public.store_locations(id) ON DELETE CASCADE,
  product_id  uuid NOT NULL,
  variant_id  uuid,
  quantity    integer NOT NULL,

  -- What the hold is FOR. Text + id rather than a column per owner type, so
  -- pickup, marketplace and anything later need no migration.
  owner_type  text NOT NULL,
  owner_id    text,

  status      text NOT NULL DEFAULT 'held',
  -- NULL = no expiry (a hold something else is responsible for ending).
  expires_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  settled_at  timestamptz,

  CONSTRAINT stock_reservations_qty_check CHECK (quantity > 0),
  CONSTRAINT stock_reservations_status_check
    CHECK (status IN ('held', 'committed', 'released', 'expired'))
);

-- The sweeper's query: still held, past its expiry.
CREATE INDEX IF NOT EXISTS stock_reservations_expiry_idx
  ON public.stock_reservations (expires_at)
  WHERE status = 'held';

CREATE INDEX IF NOT EXISTS stock_reservations_owner_idx
  ON public.stock_reservations (owner_type, owner_id);

ALTER TABLE public.stock_reservations ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 2. hold_stock_at — put units aside without selling them
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.hold_stock_at(
  p_store      uuid,
  p_location   uuid,
  p_product    uuid,
  p_variant    uuid,
  p_qty        integer,
  p_owner_type text,
  p_owner_id   text,
  p_ttl_minutes integer DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tracked   boolean;
  v_backorder boolean;
  v_id        uuid;
  v_ok        boolean;
BEGIN
  IF p_qty IS NULL OR p_qty <= 0 THEN
    RETURN NULL;
  END IF;

  IF p_variant IS NOT NULL THEN
    SELECT track_inventory, allow_backorder INTO v_tracked, v_backorder
      FROM public.product_variants WHERE id = p_variant AND store_id = p_store;
  ELSE
    SELECT track_inventory, allow_backorder INTO v_tracked, v_backorder
      FROM public.products WHERE id = p_product AND store_id = p_store;
  END IF;

  -- An untracked SKU has infinite stock: record the hold for the audit trail
  -- but do not move a counter that means nothing.
  IF v_tracked IS NOT TRUE THEN
    INSERT INTO public.stock_reservations
      (store_id, location_id, product_id, variant_id, quantity,
       owner_type, owner_id, expires_at)
    VALUES
      (p_store, p_location, p_product, p_variant, p_qty, p_owner_type, p_owner_id,
       CASE WHEN p_ttl_minutes IS NULL THEN NULL
            ELSE now() + make_interval(mins => p_ttl_minutes) END)
    RETURNING id INTO v_id;
    RETURN v_id;
  END IF;

  INSERT INTO public.inventory_levels (store_id, location_id, product_id, variant_id, on_hand)
  VALUES (p_store, p_location, p_product, p_variant, 0)
  ON CONFLICT (location_id, product_id, COALESCE(variant_id, '00000000-0000-0000-0000-000000000000'::uuid))
    DO NOTHING;

  -- The whole guarantee, in one conditional UPDATE: you may only hold what is
  -- AVAILABLE, and two simultaneous holds on the last unit cannot both win.
  UPDATE public.inventory_levels
     SET reserved = reserved + p_qty, updated_at = now()
   WHERE store_id = p_store
     AND location_id = p_location
     AND product_id = p_product
     AND variant_id IS NOT DISTINCT FROM p_variant
     AND (v_backorder OR on_hand - reserved >= p_qty)
  RETURNING true INTO v_ok;

  IF v_ok IS NOT TRUE THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.stock_reservations
    (store_id, location_id, product_id, variant_id, quantity,
     owner_type, owner_id, expires_at)
  VALUES
    (p_store, p_location, p_product, p_variant, p_qty, p_owner_type, p_owner_id,
     CASE WHEN p_ttl_minutes IS NULL THEN NULL
          ELSE now() + make_interval(mins => p_ttl_minutes) END)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. commit_stock_hold — the sale actually happened
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.commit_stock_hold(
  p_reservation uuid,
  p_order       uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  r      record;
  v_new  integer;
BEGIN
  -- Claim the held→committed transition CONDITIONALLY, so a double-commit
  -- (a retried webhook, a double tap) moves stock exactly once.
  UPDATE public.stock_reservations
     SET status = 'committed', settled_at = now()
   WHERE id = p_reservation AND status = 'held'
  RETURNING * INTO r;

  IF r.id IS NULL THEN
    RETURN false;
  END IF;

  UPDATE public.inventory_levels
     SET on_hand  = on_hand - r.quantity,
         reserved = GREATEST(0, reserved - r.quantity),
         updated_at = now()
   WHERE store_id = r.store_id
     AND location_id = r.location_id
     AND product_id = r.product_id
     AND variant_id IS NOT DISTINCT FROM r.variant_id
  RETURNING on_hand INTO v_new;

  IF v_new IS NOT NULL THEN
    INSERT INTO public.stock_movements
      (store_id, product_id, variant_id, location_id, delta, reason, balance_after, order_id)
    VALUES
      (r.store_id, r.product_id, r.variant_id, r.location_id,
       -r.quantity, 'sale', v_new, p_order);
  END IF;

  RETURN true;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. release_stock_hold — it didn't
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.release_stock_hold(
  p_reservation uuid,
  p_status      text DEFAULT 'released'
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  r record;
BEGIN
  IF p_status NOT IN ('released', 'expired') THEN
    RETURN false;
  END IF;

  UPDATE public.stock_reservations
     SET status = p_status, settled_at = now()
   WHERE id = p_reservation AND status = 'held'
  RETURNING * INTO r;

  IF r.id IS NULL THEN
    RETURN false;
  END IF;

  -- No ledger row: nothing physically moved. `reserved` is a claim on stock,
  -- not stock, so writing a movement here would make the ledger disagree with
  -- the shelf.
  UPDATE public.inventory_levels
     SET reserved = GREATEST(0, reserved - r.quantity), updated_at = now()
   WHERE store_id = r.store_id
     AND location_id = r.location_id
     AND product_id = r.product_id
     AND variant_id IS NOT DISTINCT FROM r.variant_id;

  RETURN true;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. sweep_expired_holds — a hold nobody completes must not lock stock forever
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sweep_expired_holds(p_limit integer DEFAULT 500)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  r     record;
  v_n   integer := 0;
BEGIN
  FOR r IN
    SELECT id FROM public.stock_reservations
     WHERE status = 'held'
       AND expires_at IS NOT NULL
       AND expires_at < now()
     ORDER BY expires_at
     LIMIT p_limit
  LOOP
    IF public.release_stock_hold(r.id, 'expired') THEN
      v_n := v_n + 1;
    END IF;
  END LOOP;
  RETURN v_n;
END;
$$;

-- ---------------------------------------------------------------------------
-- 6. A hold must actually protect the units
-- ---------------------------------------------------------------------------
-- Both existing guards subtract `reserved`. Without this a hold would be
-- decorative: a POS sale or a transfer could take units already promised to
-- someone. pos_11 flags this exact requirement in its own header.
CREATE OR REPLACE FUNCTION public.reserve_stock_at(
  p_store    uuid,
  p_location uuid,
  p_product  uuid,
  p_variant  uuid,
  p_qty      integer,
  p_order    uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tracked   boolean;
  v_backorder boolean;
  v_new       integer;
BEGIN
  IF p_variant IS NOT NULL THEN
    SELECT track_inventory, allow_backorder INTO v_tracked, v_backorder
      FROM public.product_variants WHERE id = p_variant AND store_id = p_store;
  ELSE
    SELECT track_inventory, allow_backorder INTO v_tracked, v_backorder
      FROM public.products WHERE id = p_product AND store_id = p_store;
  END IF;

  IF v_tracked IS NOT TRUE THEN
    RETURN true;
  END IF;

  INSERT INTO public.inventory_levels (store_id, location_id, product_id, variant_id, on_hand)
  VALUES (p_store, p_location, p_product, p_variant, 0)
  ON CONFLICT (location_id, product_id, COALESCE(variant_id, '00000000-0000-0000-0000-000000000000'::uuid))
    DO NOTHING;

  UPDATE public.inventory_levels
     SET on_hand = on_hand - p_qty, updated_at = now()
   WHERE store_id = p_store
     AND location_id = p_location
     AND product_id = p_product
     AND variant_id IS NOT DISTINCT FROM p_variant
     -- CHANGED in locations_04: available, not physical.
     AND (v_backorder OR on_hand - reserved >= p_qty)
  RETURNING on_hand INTO v_new;

  IF v_new IS NULL THEN
    RETURN false;
  END IF;

  INSERT INTO public.stock_movements
    (store_id, product_id, variant_id, location_id, delta, reason, balance_after, order_id)
  VALUES
    (p_store, p_product, p_variant, p_location, -p_qty, 'sale', v_new, p_order);

  RETURN true;
END;
$$;

-- Same for transfers: never ship units already promised to an online order.
CREATE OR REPLACE FUNCTION public.transfer_stock(
  p_store    uuid,
  p_from     uuid,
  p_to       uuid,
  p_product  uuid,
  p_variant  uuid,
  p_qty      integer,
  p_note     text,
  p_actor    text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_from_new integer;
  v_to_new   integer;
BEGIN
  IF p_qty IS NULL OR p_qty <= 0 THEN RETURN false; END IF;
  IF p_from = p_to THEN RETURN false; END IF;

  IF NOT EXISTS (SELECT 1 FROM public.store_locations WHERE id = p_from AND store_id = p_store)
     OR NOT EXISTS (SELECT 1 FROM public.store_locations WHERE id = p_to AND store_id = p_store) THEN
    RETURN false;
  END IF;

  UPDATE public.inventory_levels
     SET on_hand = on_hand - p_qty, updated_at = now()
   WHERE store_id = p_store
     AND location_id = p_from
     AND product_id = p_product
     AND variant_id IS NOT DISTINCT FROM p_variant
     -- CHANGED in locations_04: available, not physical.
     AND on_hand - reserved >= p_qty
  RETURNING on_hand INTO v_from_new;

  IF v_from_new IS NULL THEN RETURN false; END IF;

  INSERT INTO public.inventory_levels (store_id, location_id, product_id, variant_id, on_hand)
  VALUES (p_store, p_to, p_product, p_variant, 0)
  ON CONFLICT (location_id, product_id, COALESCE(variant_id, '00000000-0000-0000-0000-000000000000'::uuid))
    DO NOTHING;

  UPDATE public.inventory_levels
     SET on_hand = on_hand + p_qty, updated_at = now()
   WHERE store_id = p_store
     AND location_id = p_to
     AND product_id = p_product
     AND variant_id IS NOT DISTINCT FROM p_variant
  RETURNING on_hand INTO v_to_new;

  INSERT INTO public.stock_movements
    (store_id, product_id, variant_id, location_id, delta, reason, balance_after, note, created_by)
  VALUES
    (p_store, p_product, p_variant, p_from, -p_qty, 'transfer_out', v_from_new, p_note, p_actor),
    (p_store, p_product, p_variant, p_to,    p_qty, 'transfer_in',  v_to_new,   p_note, p_actor);

  RETURN true;
END;
$$;

-- ---------------------------------------------------------------------------
-- 7. The storefront must not promise held units
-- ---------------------------------------------------------------------------
-- online_stock becomes AVAILABLE at fulfilling locations. products.stock stays
-- the physical count — the dashboard and POS want to know what is on the shelf,
-- including what is spoken for.
CREATE OR REPLACE FUNCTION public._recompute_stock_aggregate(p_product uuid, p_variant uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_sum    integer;
  v_online integer;
BEGIN
  IF p_variant IS NOT NULL THEN
    SELECT COALESCE(SUM(l.on_hand), 0),
           COALESCE(SUM(GREATEST(0, l.on_hand - l.reserved)) FILTER (
             WHERE (loc.capabilities ->> 'online_fulfil')::boolean IS TRUE
               AND loc.active
           ), 0)
      INTO v_sum, v_online
      FROM public.inventory_levels l
      JOIN public.store_locations loc ON loc.id = l.location_id
     WHERE l.variant_id = p_variant;
    UPDATE public.product_variants SET stock = v_sum, online_stock = v_online WHERE id = p_variant;
  ELSE
    SELECT COALESCE(SUM(l.on_hand), 0),
           COALESCE(SUM(GREATEST(0, l.on_hand - l.reserved)) FILTER (
             WHERE (loc.capabilities ->> 'online_fulfil')::boolean IS TRUE
               AND loc.active
           ), 0)
      INTO v_sum, v_online
      FROM public.inventory_levels l
      JOIN public.store_locations loc ON loc.id = l.location_id
     WHERE l.product_id = p_product AND l.variant_id IS NULL;
    UPDATE public.products SET stock = v_sum, online_stock = v_online WHERE id = p_product;
  END IF;
END;
$$;

-- A change to `reserved` must refresh what the storefront may promise. The
-- pos_01 trigger already fires on any inventory_levels UPDATE, so it is picked
-- up for free — this comment exists so nobody "optimises" that trigger to
-- watch only on_hand.

COMMENT ON TABLE public.stock_reservations IS
  'Units held but not sold (unpaid order, uncollected pickup). available = inventory_levels.on_hand - reserved.';

COMMIT;

-- ── Rollback ────────────────────────────────────────────────────────────────
-- Restore the pre-Phase-E bodies of reserve_stock_at (pos_02), transfer_stock
-- (pos_11) and _recompute_stock_aggregate (locations_03) as part of backing
-- this out, or the guards keep subtracting a column that no longer matters.
-- BEGIN;
-- DROP FUNCTION IF EXISTS public.sweep_expired_holds(integer);
-- DROP FUNCTION IF EXISTS public.release_stock_hold(uuid, text);
-- DROP FUNCTION IF EXISTS public.commit_stock_hold(uuid, uuid);
-- DROP FUNCTION IF EXISTS public.hold_stock_at(uuid, uuid, uuid, uuid, integer, text, text, integer);
-- DROP TABLE IF EXISTS public.stock_reservations;
-- COMMIT;
