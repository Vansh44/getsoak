-- =============================================================
-- Atomic inventory stock operations
--
-- Three SECURITY DEFINER RPCs that atomically update stock counts
-- and insert audit rows into stock_movements. All inventory writes
-- go through these functions — no direct INSERT/UPDATE policies
-- exist on stock_movements.
--
-- reserve_stock()  — called at checkout to decrement stock.
-- release_stock()  — called on cancellation / refund to return stock.
-- adjust_stock()   — manual admin adjustment (recount, damage, etc.).
--
-- Each function handles both product-level and variant-level stock
-- depending on whether p_variant is NULL.
--
-- SECURITY DEFINER so the functions can bypass RLS and directly
-- mutate products, product_variants, and stock_movements. Callers
-- must supply valid IDs; the UPDATE … WHERE id = … AND store_id = …
-- guard ensures cross-store isolation.
--
-- Idempotent: safe to re-run (CREATE OR REPLACE).
-- =============================================================

-- -------------------------------------------------------------
-- 1. reserve_stock — decrement stock on sale
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reserve_stock(
  p_store   uuid,
  p_product uuid,
  p_variant uuid,
  p_qty     integer,
  p_order   uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_new_stock integer;
  v_reserved  boolean;
  v_tracked   boolean;
BEGIN
  IF p_variant IS NOT NULL THEN
    -- Check if inventory tracking is enabled for this variant.
    SELECT track_inventory INTO v_tracked
      FROM public.product_variants
     WHERE id = p_variant
       AND store_id = p_store;

    IF v_tracked IS NOT TRUE THEN
      -- Untracked variant = infinite stock; nothing to decrement.
      RETURN true;
    END IF;

    UPDATE public.product_variants
       SET stock = stock - p_qty
     WHERE id = p_variant
       AND store_id = p_store
       AND (allow_backorder OR stock >= p_qty)
    RETURNING stock, true INTO v_new_stock, v_reserved;

    IF COALESCE(v_reserved, false) THEN
      INSERT INTO public.stock_movements
        (store_id, product_id, variant_id, delta, reason, balance_after, order_id)
      VALUES
        (p_store, p_product, p_variant, -p_qty, 'sale', v_new_stock, p_order);
    END IF;
  ELSE
    -- Product-level stock.
    SELECT track_inventory INTO v_tracked
      FROM public.products
     WHERE id = p_product
       AND store_id = p_store;

    IF v_tracked IS NOT TRUE THEN
      RETURN true;
    END IF;

    UPDATE public.products
       SET stock = stock - p_qty
     WHERE id = p_product
       AND store_id = p_store
       AND (allow_backorder OR stock >= p_qty)
    RETURNING stock, true INTO v_new_stock, v_reserved;

    IF COALESCE(v_reserved, false) THEN
      INSERT INTO public.stock_movements
        (store_id, product_id, variant_id, delta, reason, balance_after, order_id)
      VALUES
        (p_store, p_product, NULL, -p_qty, 'sale', v_new_stock, p_order);
    END IF;
  END IF;

  RETURN COALESCE(v_reserved, false);
END;
$$;

-- -------------------------------------------------------------
-- 2. release_stock — return stock on cancellation / refund
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.release_stock(
  p_store   uuid,
  p_product uuid,
  p_variant uuid,
  p_qty     integer,
  p_order   uuid,
  p_reason  text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_new_stock integer;
  v_tracked   boolean;
BEGIN
  IF p_variant IS NOT NULL THEN
    SELECT track_inventory INTO v_tracked
      FROM public.product_variants
     WHERE id = p_variant
       AND store_id = p_store;

    IF v_tracked IS NOT TRUE THEN
      RETURN;
    END IF;

    UPDATE public.product_variants
       SET stock = stock + p_qty
     WHERE id = p_variant
       AND store_id = p_store
    RETURNING stock INTO v_new_stock;

    INSERT INTO public.stock_movements
      (store_id, product_id, variant_id, delta, reason, balance_after, order_id)
    VALUES
      (p_store, p_product, p_variant, p_qty, p_reason, v_new_stock, p_order);
  ELSE
    SELECT track_inventory INTO v_tracked
      FROM public.products
     WHERE id = p_product
       AND store_id = p_store;

    IF v_tracked IS NOT TRUE THEN
      RETURN;
    END IF;

    UPDATE public.products
       SET stock = stock + p_qty
     WHERE id = p_product
       AND store_id = p_store
    RETURNING stock INTO v_new_stock;

    INSERT INTO public.stock_movements
      (store_id, product_id, variant_id, delta, reason, balance_after, order_id)
    VALUES
      (p_store, p_product, NULL, p_qty, p_reason, v_new_stock, p_order);
  END IF;
END;
$$;

-- -------------------------------------------------------------
-- 3. adjust_stock — manual admin adjustment
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.adjust_stock(
  p_store   uuid,
  p_product uuid,
  p_variant uuid,
  p_delta   integer,
  p_reason  text,
  p_note    text,
  -- p_actor is a user id. Since Phase 6 (Firebase) uids are STRINGS, not uuids,
  -- this is text and stock_movements.created_by is text (see
  -- phase6_01_uid_columns_to_text.sql + phase6_02_adjust_stock_actor_text.sql).
  p_actor   text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_new_stock integer;
BEGIN
  IF p_variant IS NOT NULL THEN
    UPDATE public.product_variants
       SET stock = GREATEST(0, stock + p_delta)
     WHERE id = p_variant
       AND store_id = p_store
    RETURNING stock INTO v_new_stock;

    INSERT INTO public.stock_movements
      (store_id, product_id, variant_id, delta, reason, balance_after, note, created_by)
    VALUES
      (p_store, p_product, p_variant, p_delta, p_reason, v_new_stock, p_note, p_actor);
  ELSE
    UPDATE public.products
       SET stock = GREATEST(0, stock + p_delta)
     WHERE id = p_product
       AND store_id = p_store
    RETURNING stock INTO v_new_stock;

    INSERT INTO public.stock_movements
      (store_id, product_id, variant_id, delta, reason, balance_after, note, created_by)
    VALUES
      (p_store, p_product, NULL, p_delta, p_reason, v_new_stock, p_note, p_actor);
  END IF;

  RETURN v_new_stock;
END;
$$;

-- -------------------------------------------------------------
-- 4. Grants
-- -------------------------------------------------------------
GRANT EXECUTE ON FUNCTION public.reserve_stock(uuid, uuid, uuid, integer, uuid)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.release_stock(uuid, uuid, uuid, integer, uuid, text)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.adjust_stock(uuid, uuid, uuid, integer, text, text, text)
  TO authenticated, service_role;
