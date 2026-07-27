-- =============================================================
-- POS Phase 0 (3/3) — location-aware stock RPCs + backward-compat wrappers
--
-- The three atomic stock functions gain a location dimension, operating on
-- inventory_levels.on_hand (pos_01) instead of products.stock directly. The
-- aggregate trigger mirrors the change back to products.stock, so behaviour is
-- identical for a single-location store.
--
--   reserve_stock_at()  — decrement on sale (conditional; false if short)
--   release_stock_at()  — return stock on cancel/refund
--   adjust_stock_at()   — manual admin adjustment (+ ledger)
--
-- The OLD signatures (reserve_stock / release_stock / adjust_stock) are REPLACED
-- with thin wrappers that target the store's default location, so every existing
-- caller (checkout-actions, order-actions, inventory-actions) keeps working with
-- ZERO code change.
--
-- ⚠ Run as `postgres` AFTER pos_01_inventory_levels.sql. Idempotent.
-- =============================================================

-- -------------------------------------------------------------
-- 1. reserve_stock_at — decrement on sale
-- -------------------------------------------------------------
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

  -- Untracked SKU = infinite stock; nothing to decrement.
  IF v_tracked IS NOT TRUE THEN
    RETURN true;
  END IF;

  -- Ensure a level row exists at this location (so backorder can drive it
  -- negative). For the default location the seed trigger already made one.
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
     AND (v_backorder OR on_hand >= p_qty)
  RETURNING on_hand INTO v_new;

  -- No row updated ⇒ insufficient stock (and not backorderable).
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

-- -------------------------------------------------------------
-- 2. release_stock_at — return stock on cancel/refund
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.release_stock_at(
  p_store    uuid,
  p_location uuid,
  p_product  uuid,
  p_variant  uuid,
  p_qty      integer,
  p_order    uuid,
  p_reason   text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tracked boolean;
  v_new     integer;
BEGIN
  IF p_variant IS NOT NULL THEN
    SELECT track_inventory INTO v_tracked
      FROM public.product_variants WHERE id = p_variant AND store_id = p_store;
  ELSE
    SELECT track_inventory INTO v_tracked
      FROM public.products WHERE id = p_product AND store_id = p_store;
  END IF;

  IF v_tracked IS NOT TRUE THEN
    RETURN;
  END IF;

  INSERT INTO public.inventory_levels (store_id, location_id, product_id, variant_id, on_hand)
  VALUES (p_store, p_location, p_product, p_variant, 0)
  ON CONFLICT (location_id, product_id, COALESCE(variant_id, '00000000-0000-0000-0000-000000000000'::uuid))
    DO NOTHING;

  UPDATE public.inventory_levels
     SET on_hand = on_hand + p_qty, updated_at = now()
   WHERE store_id = p_store
     AND location_id = p_location
     AND product_id = p_product
     AND variant_id IS NOT DISTINCT FROM p_variant
  RETURNING on_hand INTO v_new;

  INSERT INTO public.stock_movements
    (store_id, product_id, variant_id, location_id, delta, reason, balance_after, order_id)
  VALUES
    (p_store, p_product, p_variant, p_location, p_qty, p_reason, v_new, p_order);
END;
$$;

-- -------------------------------------------------------------
-- 3. adjust_stock_at — manual admin adjustment
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.adjust_stock_at(
  p_store    uuid,
  p_location uuid,
  p_product  uuid,
  p_variant  uuid,
  p_delta    integer,
  p_reason   text,
  p_note     text,
  p_actor    text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_new integer;
BEGIN
  INSERT INTO public.inventory_levels (store_id, location_id, product_id, variant_id, on_hand)
  VALUES (p_store, p_location, p_product, p_variant, 0)
  ON CONFLICT (location_id, product_id, COALESCE(variant_id, '00000000-0000-0000-0000-000000000000'::uuid))
    DO NOTHING;

  UPDATE public.inventory_levels
     SET on_hand = GREATEST(0, on_hand + p_delta), updated_at = now()
   WHERE store_id = p_store
     AND location_id = p_location
     AND product_id = p_product
     AND variant_id IS NOT DISTINCT FROM p_variant
  RETURNING on_hand INTO v_new;

  INSERT INTO public.stock_movements
    (store_id, product_id, variant_id, location_id, delta, reason, balance_after, note, created_by)
  VALUES
    (p_store, p_product, p_variant, p_location, p_delta, p_reason, v_new, p_note, p_actor);

  RETURN v_new;
END;
$$;

-- -------------------------------------------------------------
-- 4. Backward-compat wrappers — SAME signatures as before, now delegating to
--    the *_at variants at the store's default location. Every existing caller
--    keeps working unchanged.
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reserve_stock(
  p_store uuid, p_product uuid, p_variant uuid, p_qty integer, p_order uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN public.reserve_stock_at(
    p_store, public.pos_ensure_default_location(p_store),
    p_product, p_variant, p_qty, p_order);
END;
$$;

CREATE OR REPLACE FUNCTION public.release_stock(
  p_store uuid, p_product uuid, p_variant uuid, p_qty integer, p_order uuid, p_reason text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.release_stock_at(
    p_store, public.pos_ensure_default_location(p_store),
    p_product, p_variant, p_qty, p_order, p_reason);
END;
$$;

CREATE OR REPLACE FUNCTION public.adjust_stock(
  p_store uuid, p_product uuid, p_variant uuid, p_delta integer,
  p_reason text, p_note text, p_actor text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN public.adjust_stock_at(
    p_store, public.pos_ensure_default_location(p_store),
    p_product, p_variant, p_delta, p_reason, p_note, p_actor);
END;
$$;

-- -------------------------------------------------------------
-- 5. Grants (app_user + app_service are the real login-mapped roles).
-- -------------------------------------------------------------
GRANT EXECUTE ON FUNCTION public.reserve_stock_at(uuid, uuid, uuid, uuid, integer, uuid)      TO app_user, app_service;
GRANT EXECUTE ON FUNCTION public.release_stock_at(uuid, uuid, uuid, uuid, integer, uuid, text) TO app_user, app_service;
GRANT EXECUTE ON FUNCTION public.adjust_stock_at(uuid, uuid, uuid, uuid, integer, text, text, text) TO app_user, app_service;
GRANT EXECUTE ON FUNCTION public.reserve_stock(uuid, uuid, uuid, integer, uuid)      TO app_user, app_service;
GRANT EXECUTE ON FUNCTION public.release_stock(uuid, uuid, uuid, integer, uuid, text) TO app_user, app_service;
GRANT EXECUTE ON FUNCTION public.adjust_stock(uuid, uuid, uuid, integer, text, text, text) TO app_user, app_service;

-- =============================================================
-- Rollback: restore the pre-POS single-scalar functions from
-- supabase/inventory_rpc.sql (re-run that file), then:
--   DROP FUNCTION IF EXISTS public.reserve_stock_at(uuid, uuid, uuid, uuid, integer, uuid);
--   DROP FUNCTION IF EXISTS public.release_stock_at(uuid, uuid, uuid, uuid, integer, uuid, text);
--   DROP FUNCTION IF EXISTS public.adjust_stock_at(uuid, uuid, uuid, uuid, integer, text, text, text);
-- (Re-running inventory_rpc.sql restores reserve_stock/release_stock/adjust_stock
--  to operate directly on products.stock again.)
-- =============================================================
