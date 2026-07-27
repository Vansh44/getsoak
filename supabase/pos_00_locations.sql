-- =============================================================
-- POS Phase 0 (1/3) — store_locations
--
-- Physical/warehouse locations per store. EVERY store has exactly one
-- is_default 'Main' location (auto-created); POS (pro plan) can add more.
-- This is the foundation of multi-location inventory: inventory_levels
-- (pos_01) hangs off these rows, and the location-aware stock RPCs
-- (pos_02) default to the store's Main location so all existing inventory
-- and checkout code keeps working unchanged.
--
-- ⚠ Run as `postgres` against the target Cloud SQL instance (through the
-- Cloud SQL Auth Proxy), like every other migration. New public-schema
-- tables/functions created by postgres inherit app_user/app_service grants
-- from the ALTER DEFAULT PRIVILEGES in drizzle/manual/0000_compat_setup.sql;
-- explicit function grants are still added for clarity. Idempotent.
-- =============================================================

CREATE TABLE IF NOT EXISTS store_locations (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id       UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  type           TEXT NOT NULL DEFAULT 'shop' CHECK (type IN ('shop', 'warehouse')),
  address        JSONB,
  gstin          TEXT,                       -- state-wise GST registration (India GST)
  state_code     TEXT,                       -- GST state code (2-digit), for place-of-supply
  receipt_prefix TEXT,                        -- e.g. 'DEL' — per-location POS receipt numbers
  is_default     BOOLEAN NOT NULL DEFAULT false,
  active         BOOLEAN NOT NULL DEFAULT true,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS store_locations_store_idx
  ON store_locations (store_id, sort_order);

-- At most one default location per store.
CREATE UNIQUE INDEX IF NOT EXISTS store_locations_one_default
  ON store_locations (store_id) WHERE is_default;

-- ---- RLS: store admins manage their own store's locations; NOT public ----
-- The storefront never reads locations; the location-aware RPCs run under the
-- service role (BYPASSRLS) or as SECURITY DEFINER, so admin-only is safe.
ALTER TABLE store_locations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Store admins manage store_locations" ON store_locations;
CREATE POLICY "Store admins manage store_locations"
  ON store_locations FOR ALL
  USING ((SELECT is_store_admin(store_id)))
  WITH CHECK ((SELECT is_store_admin(store_id)));

-- -------------------------------------------------------------
-- pos_ensure_default_location — return a store's Main location id,
-- creating it if missing. Self-healing: called by the inventory seed
-- triggers (pos_01) and the compat stock RPCs (pos_02), so any store —
-- existing, new, POS or not — always has exactly one default location.
-- SECURITY DEFINER so it can insert regardless of the caller's RLS scope.
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_ensure_default_location(p_store uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_id uuid;
BEGIN
  SELECT id INTO v_id
    FROM public.store_locations
   WHERE store_id = p_store AND is_default
   LIMIT 1;

  IF v_id IS NULL THEN
    INSERT INTO public.store_locations (store_id, name, type, is_default, active, sort_order)
    VALUES (p_store, 'Main', 'shop', true, true, 0)
    ON CONFLICT (store_id) WHERE is_default DO NOTHING
    RETURNING id INTO v_id;

    -- Lost a race to create it → read the winner.
    IF v_id IS NULL THEN
      SELECT id INTO v_id
        FROM public.store_locations
       WHERE store_id = p_store AND is_default
       LIMIT 1;
    END IF;
  END IF;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.pos_ensure_default_location(uuid)
  TO app_user, app_service;

-- -------------------------------------------------------------
-- Backfill: give every existing store a Main location.
-- -------------------------------------------------------------
INSERT INTO public.store_locations (store_id, name, type, is_default, active, sort_order)
SELECT s.id, 'Main', 'shop', true, true, 0
  FROM public.stores s
 WHERE NOT EXISTS (
   SELECT 1 FROM public.store_locations l
    WHERE l.store_id = s.id AND l.is_default
 );

-- =============================================================
-- Rollback:
--   DROP FUNCTION IF EXISTS public.pos_ensure_default_location(uuid);
--   DROP TABLE IF EXISTS store_locations CASCADE;
-- =============================================================
