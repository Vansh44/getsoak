-- POS Phase 2 — the manager-arranged register layout.
--
-- Run as `postgres` (owner of the tables), like every other migration here.
--
-- A manager decides WHICH products appear on the register grid and in WHAT
-- order, per location: the counter at a busy till wants its twelve fast movers
-- in reach, not an alphabetical dump of the whole catalogue.
--
-- Per (store, location), not per user: this is the shop's till arrangement,
-- set by a manager FOR the cashiers, so it cannot live in localStorage the way
-- the analytics dashboard's personal widget layout does. Locations also carry
-- different assortments and their own stock, so one store-wide layout would be
-- wrong the moment a second shop opens.
--
-- `items` is an ordered jsonb array of {"productId": uuid, "variantId": uuid|null}.
-- Deliberately NOT foreign-keyed: a deleted product should quietly drop out of
-- the grid, not block the delete or wedge the layout. The register resolves
-- entries against the live catalogue and skips whatever no longer exists.
--
-- NO ROW = NO LAYOUT = SHOW EVERYTHING. That default matters: this migration
-- must not blank the grid of any store already using the register.

BEGIN;

CREATE TABLE IF NOT EXISTS public.pos_layouts (
  store_id    uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES public.store_locations(id) ON DELETE CASCADE,
  items       jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text,
  PRIMARY KEY (location_id)
);

CREATE INDEX IF NOT EXISTS idx_pos_layouts_store ON public.pos_layouts (store_id);

-- Guard the shape at the DB edge: the app validates too, but a malformed blob
-- here would break every register at that location at once.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pos_layouts_items_is_array'
  ) THEN
    ALTER TABLE public.pos_layouts
      ADD CONSTRAINT pos_layouts_items_is_array
      CHECK (jsonb_typeof(items) = 'array');
  END IF;
END $$;

-- Service-role only, matching the rest of the POS tables (pos_staff,
-- pos_devices, pos_audit_log). Every read and write goes through
-- pos-layout-actions.ts, which resolves the operator server-side and checks
-- the `edit_layout` capability — a client must never be able to rearrange, or
-- read, another location's till.
ALTER TABLE public.pos_layouts ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.pos_layouts IS
  'Manager-arranged register grid per location. No row = show the whole catalogue.';
COMMENT ON COLUMN public.pos_layouts.items IS
  'Ordered [{productId, variantId}]. Not FK-checked: stale entries are skipped at render.';

COMMIT;

-- ── Rollback ────────────────────────────────────────────────────────────────
-- BEGIN;
-- DROP TABLE IF EXISTS public.pos_layouts;
-- COMMIT;
