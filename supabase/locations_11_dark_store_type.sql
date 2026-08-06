-- ---------------------------------------------------------------------------
-- store_locations.type — actually allow 'dark_store'.
--
-- ★★ AN `IF NOT EXISTS` GUARD CHECKS THE NAME, NOT THE DEFINITION.
--
-- pos_00_locations.sql creates the table with an INLINE column check:
--     type TEXT NOT NULL DEFAULT 'shop' CHECK (type IN ('shop', 'warehouse'))
-- Postgres auto-names that constraint `store_locations_type_check`.
--
-- locations_01_capabilities.sql then tried to widen it to include 'dark_store',
-- wrapped in `IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname =
-- 'store_locations_type_check')`. The name was ALREADY taken by the inline
-- check, so the widening was a silent no-op — the migration reported success
-- and changed nothing. Both prod and staging still carried the two-value list.
--
-- The failure surfaced only at the UI: lib/locations/capabilities.ts offers
-- three types, the "Add location" dialog renders all three, and picking
-- "Dark store" died on
--     new row for relation "store_locations" violates check constraint
--     "store_locations_type_check"
-- — a raw Postgres error shown to a merchant, for an option the product itself
-- put in front of them.
--
-- This is the same shape as the `subscriptions_01_schema.sql` incident recorded
-- in CODEBASE §15b: re-running an idempotent-looking migration whose CONTENT had
-- changed. The guard is not wrong; it just cannot see that the constraint it
-- found is not the constraint the file describes. Anything that CHANGES an
-- existing object needs its own file that drops and recreates it — never an
-- edit to the file that first created it.
--
-- Safe to run repeatedly. Widening a CHECK cannot invalidate an existing row:
-- every value currently stored ('shop' / 'warehouse') is still permitted.
--
-- RUN AS: postgres (owner of store_locations), via the Cloud SQL proxy.
-- ---------------------------------------------------------------------------

BEGIN;

ALTER TABLE public.store_locations
  DROP CONSTRAINT IF EXISTS store_locations_type_check;

ALTER TABLE public.store_locations
  ADD CONSTRAINT store_locations_type_check
  CHECK (type IN ('shop', 'warehouse', 'dark_store'));

-- Guard: fail loudly if the constraint still doesn't admit the value the app
-- offers. A migration that silently does nothing is what got us here.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'store_locations_type_check'
       AND pg_get_constraintdef(oid) LIKE '%dark_store%'
  ) THEN
    RAISE EXCEPTION
      'store_locations_type_check does not admit dark_store — the widening did not apply';
  END IF;
END $$;

COMMIT;

-- ── Rollback ────────────────────────────────────────────────────────────────
-- Only safe while no row uses the new value; the DELETE guard makes that
-- explicit rather than letting the ALTER fail with a constraint violation.
-- BEGIN;
-- UPDATE public.store_locations SET type = 'warehouse' WHERE type = 'dark_store';
-- ALTER TABLE public.store_locations DROP CONSTRAINT IF EXISTS store_locations_type_check;
-- ALTER TABLE public.store_locations
--   ADD CONSTRAINT store_locations_type_check CHECK (type IN ('shop', 'warehouse'));
-- COMMIT;
