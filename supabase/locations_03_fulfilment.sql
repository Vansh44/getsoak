-- Locations Phase D — where online orders are fulfilled from.
--
-- Run as `postgres`, after locations_02.
--
-- ── The bug this closes ─────────────────────────────────────────────────────
-- The storefront reads products.stock, which the sync trigger maintains as the
-- SUM across EVERY location. But online checkout calls the reserve_stock
-- wrapper, which always targets the store's DEFAULT location. So:
--
--   Delhi (default) 0, Mumbai 10  →  website says "10 in stock"  →  order FAILS
--
-- Two halves, both needed or the store still lies:
--
--   1. ROUTING — checkout resolves a real fulfilment location instead of always
--      using the default (application side; this file provides the rules).
--   2. TRUTH IN THE WINDOW — the storefront must show what can actually be sold
--      online, not the company-wide total. That is `online_stock` below.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Fulfilment rules — one row per store
-- ---------------------------------------------------------------------------
-- `strategy` names a resolver in lib/fulfilment/strategies.ts. v1 registers
-- `priority` only; nearest / most_stock / cheapest each become a file that
-- registers itself, with NO schema change here — that is the point of storing
-- a strategy id rather than a set of columns.
--
-- `priority` is an ordered jsonb array of location ids. Not FK-checked, and
-- deliberately so: a deleted location should silently drop out of the order,
-- not block the delete or wedge every checkout.
CREATE TABLE IF NOT EXISTS public.store_fulfilment_rules (
  store_id   uuid PRIMARY KEY REFERENCES public.stores(id) ON DELETE CASCADE,
  strategy   text NOT NULL DEFAULT 'priority',
  priority   jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- A shop that is closed or deactivated should be skipped rather than
  -- failing the order. On by default because the alternative surprises nobody.
  skip_inactive boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT store_fulfilment_rules_priority_array
    CHECK (jsonb_typeof(priority) = 'array')
);

ALTER TABLE public.store_fulfilment_rules ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.store_fulfilment_rules IS
  'Which locations fulfil online orders, and in what order. NO ROW = fall back to the default location (today''s behaviour).';

-- ---------------------------------------------------------------------------
-- 2. online_stock — what the STOREFRONT may promise
-- ---------------------------------------------------------------------------
-- products.stock stays exactly as it is: the sum across every location, which
-- the dashboard and POS both want. online_stock is the same sum restricted to
-- locations that carry the `online_fulfil` capability.
--
-- Materialised rather than computed per read, for the same reason products.stock
-- is: the storefront reads it on every product card, and roadmap invariant 2
-- says never recompute a balance at read time.
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS online_stock integer NOT NULL DEFAULT 0;
ALTER TABLE public.product_variants
  ADD COLUMN IF NOT EXISTS online_stock integer NOT NULL DEFAULT 0;

-- Extend the existing recompute to maintain BOTH figures in one pass. Same
-- function name, so the inventory_levels trigger picks this up unchanged.
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
           COALESCE(SUM(l.on_hand) FILTER (
             WHERE (loc.capabilities ->> 'online_fulfil')::boolean IS TRUE
               AND loc.active
           ), 0)
      INTO v_sum, v_online
      FROM public.inventory_levels l
      JOIN public.store_locations loc ON loc.id = l.location_id
     WHERE l.variant_id = p_variant;
    UPDATE public.product_variants
       SET stock = v_sum, online_stock = v_online
     WHERE id = p_variant;
  ELSE
    SELECT COALESCE(SUM(l.on_hand), 0),
           COALESCE(SUM(l.on_hand) FILTER (
             WHERE (loc.capabilities ->> 'online_fulfil')::boolean IS TRUE
               AND loc.active
           ), 0)
      INTO v_sum, v_online
      FROM public.inventory_levels l
      JOIN public.store_locations loc ON loc.id = l.location_id
     WHERE l.product_id = p_product AND l.variant_id IS NULL;
    UPDATE public.products
       SET stock = v_sum, online_stock = v_online
     WHERE id = p_product;
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. Toggling a capability must refresh what that shop contributes
-- ---------------------------------------------------------------------------
-- Without this, switching `online_fulfil` on for the Mumbai shop would leave
-- every product's online_stock stale until something else happened to touch
-- that SKU's levels — so the merchant enables fulfilment and the website
-- carries on saying "out of stock".
CREATE OR REPLACE FUNCTION public.resync_location_online_stock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  r record;
BEGIN
  IF (OLD.capabilities ->> 'online_fulfil') IS NOT DISTINCT FROM (NEW.capabilities ->> 'online_fulfil')
     AND OLD.active IS NOT DISTINCT FROM NEW.active THEN
    RETURN NULL;
  END IF;

  FOR r IN
    SELECT DISTINCT product_id, variant_id
      FROM public.inventory_levels
     WHERE location_id = NEW.id
  LOOP
    PERFORM public._recompute_stock_aggregate(r.product_id, r.variant_id);
  END LOOP;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS store_locations_resync_online_stock ON public.store_locations;
CREATE TRIGGER store_locations_resync_online_stock
  AFTER UPDATE ON public.store_locations
  FOR EACH ROW EXECUTE FUNCTION public.resync_location_online_stock();

-- ---------------------------------------------------------------------------
-- 4. Backfill + guard
-- ---------------------------------------------------------------------------
UPDATE public.products p
   SET online_stock = COALESCE((
     SELECT SUM(l.on_hand)
       FROM public.inventory_levels l
       JOIN public.store_locations loc ON loc.id = l.location_id
      WHERE l.product_id = p.id
        AND l.variant_id IS NULL
        AND (loc.capabilities ->> 'online_fulfil')::boolean IS TRUE
        AND loc.active
   ), 0);

UPDATE public.product_variants v
   SET online_stock = COALESCE((
     SELECT SUM(l.on_hand)
       FROM public.inventory_levels l
       JOIN public.store_locations loc ON loc.id = l.location_id
      WHERE l.variant_id = v.id
        AND (loc.capabilities ->> 'online_fulfil')::boolean IS TRUE
        AND loc.active
   ), 0);

-- online_stock can never exceed stock: it is the same sum over a subset of
-- locations. If it does, the capability join or a FILTER is wrong.
DO $$
DECLARE
  bad integer;
BEGIN
  SELECT count(*) INTO bad FROM public.products WHERE online_stock > stock;
  IF bad > 0 THEN
    RAISE EXCEPTION 'online_stock exceeds stock on % product(s)', bad;
  END IF;
  SELECT count(*) INTO bad FROM public.product_variants WHERE online_stock > stock;
  IF bad > 0 THEN
    RAISE EXCEPTION 'online_stock exceeds stock on % variant(s)', bad;
  END IF;
END $$;

COMMENT ON COLUMN public.products.online_stock IS
  'Stock at locations that fulfil online orders. What the storefront may promise; products.stock stays the all-locations total.';

COMMIT;

-- ── Rollback ────────────────────────────────────────────────────────────────
-- Note: restoring the ORIGINAL _recompute_stock_aggregate (pos_01) is part of
-- backing this out, or the trigger will keep writing a column that is gone.
-- BEGIN;
-- DROP TRIGGER IF EXISTS store_locations_resync_online_stock ON public.store_locations;
-- DROP FUNCTION IF EXISTS public.resync_location_online_stock();
-- ALTER TABLE public.products DROP COLUMN IF EXISTS online_stock;
-- ALTER TABLE public.product_variants DROP COLUMN IF EXISTS online_stock;
-- DROP TABLE IF EXISTS public.store_fulfilment_rules;
-- -- then re-run the _recompute_stock_aggregate definition from pos_01.
-- COMMIT;
