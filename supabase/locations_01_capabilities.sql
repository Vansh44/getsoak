-- Locations Phase A — capabilities (docs/inventory-fulfilment-roadmap.md §3).
--
-- Run as `postgres`, after pos_11.
--
-- A location gains a set of CAPABILITIES: what it is allowed to do. A warehouse
-- becomes a location with POS switched off; a dark store one that fulfils
-- online but nobody walks into. The registry lives in
-- lib/locations/capabilities.ts.
--
-- ── Why jsonb and not six boolean columns ───────────────────────────────────
-- A seventh capability would otherwise be a migration, a schema.ts change, and
-- a check to forget in every consumer. As jsonb it is one registry entry, and
-- normalizeCapabilities() gives every existing row a sensible value for the new
-- key with no migration at all. Same trade the settings registry already makes
-- (stores.settings.features).
--
-- ⚠ Unlike stores.settings, this column is NOT a place for secrets: the
-- storefront needs to read capabilities to decide whether to offer pickup, so
-- treat it as public.
--
-- ── The backfill is NOT the defaults ────────────────────────────────────────
-- Roadmap invariant 5: a migration may not change what a live store does. The
-- creation defaults (a new shop does not fulfil online) would be wrong applied
-- backwards — they would take existing stores OFF the behaviour they have
-- today. So:
--
--   capability      backfill                        why
--   ─────────────── ─────────────────────────────── ──────────────────────────
--   pos             store has pos.enabled           matches reality
--   online_fulfil   the DEFAULT location only       the reserve_stock wrapper
--                                                   sends every online order
--                                                   there today; anywhere else
--                                                   has never fulfilled one
--   receive_stock   true                            already possible
--   transfer_stock  true                            already possible
--   pickup          FALSE                           genuinely new
--   returns         FALSE                           genuinely new
--
-- The rule: a capability describing behaviour the store ALREADY has is
-- backfilled ON; one that introduces NEW behaviour is backfilled OFF. Only
-- pickup and returns are new — which is exactly the pair the owner asked to be
-- off by default.

BEGIN;

ALTER TABLE public.store_locations
  ADD COLUMN IF NOT EXISTS capabilities jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Shape guard. The app validates too (normalizeCapabilities), but a malformed
-- blob here would break every capability check at that location at once.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'store_locations_capabilities_object'
  ) THEN
    ALTER TABLE public.store_locations
      ADD CONSTRAINT store_locations_capabilities_object
      CHECK (jsonb_typeof(capabilities) = 'object');
  END IF;
END $$;

-- Fixed type list (the owner's decision). Verified against staging first: only
-- 'shop' and 'warehouse' are in use, so nothing existing violates this.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'store_locations_type_check'
  ) THEN
    ALTER TABLE public.store_locations
      ADD CONSTRAINT store_locations_type_check
      CHECK (type IN ('shop', 'warehouse', 'dark_store'));
  END IF;
END $$;

-- Backfill. Only rows that have not been given capabilities already, so a
-- re-run cannot stomp a merchant's choices.
UPDATE public.store_locations l
   SET capabilities = jsonb_build_object(
         'pos',            COALESCE((s.settings -> 'features' ->> 'pos.enabled')::boolean, false),
         'online_fulfil',  l.is_default,
         'pickup',         false,
         'returns',        false,
         'receive_stock',  true,
         'transfer_stock', true
       )
  FROM public.stores s
 WHERE s.id = l.store_id
   AND l.capabilities = '{}'::jsonb;

-- Guard: every location must end up with a capability set, or a location would
-- silently resolve to the type defaults and a shop could lose online fulfilment.
DO $$
DECLARE
  bare integer;
BEGIN
  SELECT count(*) INTO bare
    FROM public.store_locations
   WHERE capabilities = '{}'::jsonb;

  IF bare > 0 THEN
    RAISE EXCEPTION 'Backfill missed % location(s) — they would fall back to type defaults', bare;
  END IF;
END $$;

-- Guard: no store may lose its ability to take an online order. Every store
-- with a location must still have exactly one that fulfils online.
DO $$
DECLARE
  stranded text;
BEGIN
  SELECT string_agg(store_id::text, ', ') INTO stranded
    FROM public.store_locations
   GROUP BY store_id
  HAVING count(*) FILTER (WHERE (capabilities ->> 'online_fulfil')::boolean) = 0;

  IF stranded IS NOT NULL THEN
    RAISE EXCEPTION 'Store(s) left with no online-fulfilment location: %', stranded;
  END IF;
END $$;

COMMENT ON COLUMN public.store_locations.capabilities IS
  'What this location may do. Registry + validation in lib/locations/capabilities.ts. Public — no secrets.';

COMMIT;

-- ── Rollback ────────────────────────────────────────────────────────────────
-- BEGIN;
-- ALTER TABLE public.store_locations DROP CONSTRAINT IF EXISTS store_locations_type_check;
-- ALTER TABLE public.store_locations DROP CONSTRAINT IF EXISTS store_locations_capabilities_object;
-- ALTER TABLE public.store_locations DROP COLUMN IF EXISTS capabilities;
-- COMMIT;
