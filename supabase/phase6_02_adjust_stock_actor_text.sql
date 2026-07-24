-- Phase 6 follow-up: adjust_stock(p_actor) uuid -> text
--
-- phase6_01_uid_columns_to_text.sql retyped the uid-holding COLUMNS (including
-- stock_movements.created_by) to text, because Firebase uids are STRINGS, not
-- uuids. But the adjust_stock() RPC still declared its p_actor PARAMETER as
-- uuid, so the app passing a Firebase uid failed at the call boundary with:
--   invalid input syntax for type uuid: "wM8UbZH0N2MBp55mTnaeKHBQjgv1"
-- (this broke every manual stock edit + bulk adjust in /dashboard/inventory).
--
-- reserve_stock / release_stock are unaffected — they write only order_id (a
-- real uuid) and no actor.
--
-- Changing a parameter TYPE changes the function signature, so we DROP the old
-- (…, uuid) overload and recreate as (…, text) rather than CREATE OR REPLACE
-- (which would leave both overloads in place).
--
-- Run as the table/function owner (postgres) via the Cloud SQL proxy, like
-- every other migration in this directory.

DROP FUNCTION IF EXISTS public.adjust_stock(uuid, uuid, uuid, integer, text, text, uuid);

CREATE OR REPLACE FUNCTION public.adjust_stock(
  p_store   uuid,
  p_product uuid,
  p_variant uuid,
  p_delta   integer,
  p_reason  text,
  p_note    text,
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

GRANT EXECUTE ON FUNCTION public.adjust_stock(uuid, uuid, uuid, integer, text, text, text)
  TO authenticated, service_role;

-- Rollback (only valid before any Firebase-uid rows exist; a text uid won't
-- cast back to uuid):
-- DROP FUNCTION IF EXISTS public.adjust_stock(uuid, uuid, uuid, integer, text, text, text);
-- ...then re-run the original (…, p_actor uuid) definition from inventory_rpc.sql.
