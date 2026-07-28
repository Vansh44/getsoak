-- POS Phase 4 — move stock between a store's locations.
--
-- Run as `postgres`, after pos_10.
--
-- Everything else in the inventory model changes stock at ONE location
-- (adjust_stock_at, reserve_stock_at). A transfer is the first operation that
-- touches two, and it is the one where a half-completed write actually
-- destroys inventory: decrement the source, fail to increment the destination,
-- and the units are simply gone from the store's books.
--
-- A plpgsql function body runs in a single transaction, so both legs commit or
-- neither does. That is the whole reason this is one RPC rather than two
-- adjust_stock_at calls from the application — the app has no cross-statement
-- transaction over the pool (see the rollback chains in placeOrder /
-- placePosSale, which exist precisely because of that).
--
-- The source decrement is CONDITIONAL on having the stock (`on_hand >= p_qty`),
-- so two managers transferring the last 5 units at the same moment cannot both
-- succeed. `reserved` is unused in v1 — reserve_stock_at decrements on_hand
-- directly — so on_hand IS the available quantity, and no separate
-- availability calculation is needed here. If `reserved` is ever brought into
-- use, THIS guard has to become `on_hand - reserved >= p_qty` or a transfer
-- will be able to ship units already promised to an online order.

BEGIN;

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
  IF p_qty IS NULL OR p_qty <= 0 THEN
    RETURN false;
  END IF;

  -- Moving stock to where it already is would write two ledger rows that
  -- cancel out and imply an event that never happened.
  IF p_from = p_to THEN
    RETURN false;
  END IF;

  -- Both ends must belong to the calling store. SECURITY DEFINER bypasses RLS,
  -- so this function cannot lean on the caller's scope for tenancy.
  IF NOT EXISTS (
    SELECT 1 FROM public.store_locations
     WHERE id = p_from AND store_id = p_store
  ) OR NOT EXISTS (
    SELECT 1 FROM public.store_locations
     WHERE id = p_to AND store_id = p_store
  ) THEN
    RETURN false;
  END IF;

  -- Take from the source FIRST, and only if it actually has the units. No row
  -- updated ⇒ insufficient stock ⇒ nothing else happens.
  UPDATE public.inventory_levels
     SET on_hand = on_hand - p_qty, updated_at = now()
   WHERE store_id = p_store
     AND location_id = p_from
     AND product_id = p_product
     AND variant_id IS NOT DISTINCT FROM p_variant
     AND on_hand >= p_qty
  RETURNING on_hand INTO v_from_new;

  IF v_from_new IS NULL THEN
    RETURN false;
  END IF;

  -- The destination may never have carried this SKU.
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

  -- Two ledger rows, one per end, so each location's history explains its own
  -- balance without having to know the other side existed.
  INSERT INTO public.stock_movements
    (store_id, product_id, variant_id, location_id, delta, reason, balance_after, note, created_by)
  VALUES
    (p_store, p_product, p_variant, p_from, -p_qty, 'transfer_out', v_from_new, p_note, p_actor),
    (p_store, p_product, p_variant, p_to,    p_qty, 'transfer_in',  v_to_new,   p_note, p_actor);

  RETURN true;
END;
$$;

COMMENT ON FUNCTION public.transfer_stock(uuid, uuid, uuid, uuid, uuid, integer, text, text) IS
  'Atomically move p_qty of a SKU between two of a store''s locations. Returns false when the source lacks the stock, the ends are equal, or either location is not the store''s.';

COMMIT;

-- ── Rollback ────────────────────────────────────────────────────────────────
-- BEGIN;
-- DROP FUNCTION IF EXISTS public.transfer_stock(uuid, uuid, uuid, uuid, uuid, integer, text, text);
-- COMMIT;
