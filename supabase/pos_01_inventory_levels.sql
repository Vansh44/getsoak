-- =============================================================
-- POS Phase 0 (2/3) — inventory_levels + the aggregate cache
--
-- inventory_levels is the per-location source of truth for stock. To keep the
-- ENTIRE existing app untouched, products.stock / product_variants.stock become
-- a TRIGGER-MAINTAINED AGGREGATE = SUM(on_hand) across a SKU's locations. The
-- storefront, lib/inventory/status.ts, the shop pages, the cart clamp and the
-- current inventory dashboard all keep reading products.stock exactly as before.
--
-- Why this works with zero app changes: post-create stock writes ALREADY flow
-- only through the reserve_stock / release_stock / adjust_stock RPCs (the product
-- editor never writes stock — see app/actions/product-actions.ts). pos_02 makes
-- those RPCs location-aware; the seed triggers here capture a NEW product's
-- initial stock at its default location. So every mutation path lands in
-- inventory_levels, and the aggregate trigger mirrors the total back to
-- products.stock.
--
-- ⚠ Run as `postgres` AFTER pos_00_locations.sql. Idempotent.
-- =============================================================

-- -------------------------------------------------------------
-- 1. inventory_levels table
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inventory_levels (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id    UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  location_id UUID NOT NULL REFERENCES store_locations(id) ON DELETE CASCADE,
  product_id  UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_id  UUID REFERENCES product_variants(id) ON DELETE CASCADE,
  on_hand     INTEGER NOT NULL DEFAULT 0,
  reserved    INTEGER NOT NULL DEFAULT 0,       -- reserved for later (online holds); unused in v1
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per (location, product, variant-or-null). NULLs are distinct in a
-- plain UNIQUE, so COALESCE a sentinel to enforce single-row-per-SKU-per-location.
CREATE UNIQUE INDEX IF NOT EXISTS inventory_levels_unique
  ON inventory_levels (
    location_id,
    product_id,
    COALESCE(variant_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );
CREATE INDEX IF NOT EXISTS inventory_levels_store_idx ON inventory_levels (store_id);
CREATE INDEX IF NOT EXISTS inventory_levels_product_idx ON inventory_levels (product_id, variant_id);
CREATE INDEX IF NOT EXISTS inventory_levels_location_idx ON inventory_levels (location_id);

-- RLS: store admins read; writes go ONLY through the SECURITY DEFINER RPCs
-- (pos_02), so no INSERT/UPDATE/DELETE policy exists (the stock_movements model).
ALTER TABLE inventory_levels ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Store admins read inventory_levels" ON inventory_levels;
CREATE POLICY "Store admins read inventory_levels"
  ON inventory_levels FOR SELECT
  USING ((SELECT is_store_admin(store_id)));

-- -------------------------------------------------------------
-- 2. stock_movements — carry the location
-- -------------------------------------------------------------
ALTER TABLE stock_movements
  ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES store_locations(id) ON DELETE SET NULL;

-- -------------------------------------------------------------
-- 3. Aggregate cache: products.stock / variants.stock = SUM(on_hand)
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._recompute_stock_aggregate(p_product uuid, p_variant uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_sum integer;
BEGIN
  IF p_variant IS NOT NULL THEN
    SELECT COALESCE(SUM(on_hand), 0) INTO v_sum
      FROM public.inventory_levels WHERE variant_id = p_variant;
    UPDATE public.product_variants SET stock = v_sum WHERE id = p_variant;
  ELSE
    SELECT COALESCE(SUM(on_hand), 0) INTO v_sum
      FROM public.inventory_levels
     WHERE product_id = p_product AND variant_id IS NULL;
    UPDATE public.products SET stock = v_sum WHERE id = p_product;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_stock_aggregate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public._recompute_stock_aggregate(OLD.product_id, OLD.variant_id);
  ELSE
    PERFORM public._recompute_stock_aggregate(NEW.product_id, NEW.variant_id);
    -- Defensive: a row that changed SKU key must refresh its OLD key too.
    IF TG_OP = 'UPDATE'
       AND (OLD.product_id <> NEW.product_id
            OR OLD.variant_id IS DISTINCT FROM NEW.variant_id) THEN
      PERFORM public._recompute_stock_aggregate(OLD.product_id, OLD.variant_id);
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS inventory_levels_sync_aggregate ON inventory_levels;
CREATE TRIGGER inventory_levels_sync_aggregate
  AFTER INSERT OR UPDATE OR DELETE ON inventory_levels
  FOR EACH ROW EXECUTE FUNCTION public.sync_stock_aggregate();

-- -------------------------------------------------------------
-- 4. Seed triggers: a NEW product/variant gets a default-location level row
--    carrying its initial stock, so the aggregate invariant holds from birth.
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.seed_inventory_level_product()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_loc uuid;
BEGIN
  v_loc := public.pos_ensure_default_location(NEW.store_id);
  INSERT INTO public.inventory_levels (store_id, location_id, product_id, variant_id, on_hand)
  VALUES (NEW.store_id, v_loc, NEW.id, NULL, COALESCE(NEW.stock, 0))
  ON CONFLICT (location_id, product_id, COALESCE(variant_id, '00000000-0000-0000-0000-000000000000'::uuid))
    DO NOTHING;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.seed_inventory_level_variant()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_loc uuid;
BEGIN
  v_loc := public.pos_ensure_default_location(NEW.store_id);
  INSERT INTO public.inventory_levels (store_id, location_id, product_id, variant_id, on_hand)
  VALUES (NEW.store_id, v_loc, NEW.product_id, NEW.id, COALESCE(NEW.stock, 0))
  ON CONFLICT (location_id, product_id, COALESCE(variant_id, '00000000-0000-0000-0000-000000000000'::uuid))
    DO NOTHING;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS products_seed_inventory_level ON products;
CREATE TRIGGER products_seed_inventory_level
  AFTER INSERT ON products
  FOR EACH ROW EXECUTE FUNCTION public.seed_inventory_level_product();

DROP TRIGGER IF EXISTS variants_seed_inventory_level ON product_variants;
CREATE TRIGGER variants_seed_inventory_level
  AFTER INSERT ON product_variants
  FOR EACH ROW EXECUTE FUNCTION public.seed_inventory_level_variant();

-- -------------------------------------------------------------
-- 5. Backfill existing products + variants into the Main location.
--    (pos_00 guaranteed every store has a default location.) The aggregate
--    trigger fires per insert and re-writes products.stock = SUM = the same
--    value, so no stock number changes. ON CONFLICT DO NOTHING makes re-runs
--    safe and never clobbers live levels.
-- -------------------------------------------------------------
INSERT INTO public.inventory_levels (store_id, location_id, product_id, variant_id, on_hand)
SELECT p.store_id, l.id, p.id, NULL, p.stock
  FROM public.products p
  JOIN public.store_locations l ON l.store_id = p.store_id AND l.is_default
ON CONFLICT (location_id, product_id, COALESCE(variant_id, '00000000-0000-0000-0000-000000000000'::uuid))
  DO NOTHING;

INSERT INTO public.inventory_levels (store_id, location_id, product_id, variant_id, on_hand)
SELECT v.store_id, l.id, v.product_id, v.id, v.stock
  FROM public.product_variants v
  JOIN public.store_locations l ON l.store_id = v.store_id AND l.is_default
ON CONFLICT (location_id, product_id, COALESCE(variant_id, '00000000-0000-0000-0000-000000000000'::uuid))
  DO NOTHING;

-- -------------------------------------------------------------
-- 6. Verification guard — FAIL the migration if the aggregate invariant
--    (products/variants.stock == SUM(on_hand)) doesn't hold after backfill.
-- -------------------------------------------------------------
DO $$
DECLARE
  v_bad_products integer;
  v_bad_variants integer;
BEGIN
  SELECT count(*) INTO v_bad_products
    FROM public.products p
   WHERE p.stock <> (
     SELECT COALESCE(SUM(on_hand), 0) FROM public.inventory_levels il
      WHERE il.product_id = p.id AND il.variant_id IS NULL
   );

  SELECT count(*) INTO v_bad_variants
    FROM public.product_variants v
   WHERE v.stock <> (
     SELECT COALESCE(SUM(on_hand), 0) FROM public.inventory_levels il
      WHERE il.variant_id = v.id
   );

  IF v_bad_products > 0 OR v_bad_variants > 0 THEN
    RAISE EXCEPTION 'inventory_levels backfill drift: % product(s), % variant(s) mismatch',
      v_bad_products, v_bad_variants;
  END IF;
END;
$$;

-- =============================================================
-- Rollback:
--   DROP TRIGGER IF EXISTS variants_seed_inventory_level ON product_variants;
--   DROP TRIGGER IF EXISTS products_seed_inventory_level ON products;
--   DROP TRIGGER IF EXISTS inventory_levels_sync_aggregate ON inventory_levels;
--   DROP FUNCTION IF EXISTS public.seed_inventory_level_variant();
--   DROP FUNCTION IF EXISTS public.seed_inventory_level_product();
--   DROP FUNCTION IF EXISTS public.sync_stock_aggregate();
--   DROP FUNCTION IF EXISTS public._recompute_stock_aggregate(uuid, uuid);
--   ALTER TABLE stock_movements DROP COLUMN IF EXISTS location_id;
--   DROP TABLE IF EXISTS inventory_levels CASCADE;
-- (products.stock/variants.stock retain their last aggregated values.)
-- =============================================================
