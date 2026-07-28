-- Locations Phase B2 — bind dashboard admins to locations.
--
-- Run as `postgres`, after locations_01.
--
-- ── The gap ─────────────────────────────────────────────────────────────────
-- Two staff models exist and only one of them knows about locations:
--
--   pos_staff  → location-bound via pos_staff_locations  (a Delhi cashier
--                cannot ring a sale on the Mumbai till)
--   admins     → bound to a store and NOTHING else
--
-- So `getOrders` has no location filter, and every dashboard admin sees every
-- order regardless of where they work. Location is a SECOND TENANCY DIMENSION,
-- cross-cutting in exactly the way store_id is, and it needs the same
-- treatment: one binding, one resolver, and every list query deriving its
-- filter from the viewer.
--
-- ── The decision ────────────────────────────────────────────────────────────
-- Staff see only their location(s). Owners, superadmins and platform operators
-- see everything.
--
-- NO ROWS = UNRESTRICTED. An admin with no bindings sees the whole store, which
-- is exactly today's behaviour — so this migration changes nothing until a
-- merchant deliberately assigns someone to a location. Same shape as
-- `pos_layouts` (no row = show everything) and PLAN_LIMITS (null = unlimited).

BEGIN;

CREATE TABLE IF NOT EXISTS public.admin_locations (
  admin_id    text NOT NULL REFERENCES public.admins(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES public.store_locations(id) ON DELETE CASCADE,
  store_id    uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (admin_id, location_id)
);

CREATE INDEX IF NOT EXISTS admin_locations_admin_idx
  ON public.admin_locations (admin_id);
CREATE INDEX IF NOT EXISTS admin_locations_store_idx
  ON public.admin_locations (store_id);

-- Deliberately NOT backfilled. A row here RESTRICTS, so seeding every admin
-- with every location would be a no-op at best and a maintenance trap at worst
-- (add a location, and every existing admin silently fails to see it unless
-- something remembers to fan out). Absence means unrestricted; that is the
-- whole design.

ALTER TABLE public.admin_locations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Store admins manage admin_locations" ON public.admin_locations;
CREATE POLICY "Store admins manage admin_locations"
ON public.admin_locations FOR ALL
TO authenticated
USING (( SELECT public.is_store_admin(admin_locations.store_id) ))
WITH CHECK (( SELECT public.is_store_admin(admin_locations.store_id) ));

COMMENT ON TABLE public.admin_locations IS
  'Restricts a dashboard admin to specific locations. NO ROWS = unrestricted (sees the whole store).';

COMMIT;

-- ── Rollback ────────────────────────────────────────────────────────────────
-- BEGIN;
-- DROP TABLE IF EXISTS public.admin_locations;
-- COMMIT;
