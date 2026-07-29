-- Locations Phase F.1 — which postcodes a shop offers collection to.
--
-- Run as `postgres`, after locations_06.
--
-- A merchant with a warehouse in Pune and a shop in Mumbai does not want a
-- Chennai shopper offered "collect in store". Without this, `pickupLocationsFor`
-- filters on capability, plan and stock only — geography plays no part, so
-- every pickup-capable shop is offered to everyone.
--
-- ── Why a column and not the capabilities blob ──────────────────────────────
-- `store_locations.capabilities` is a registry of BOOLEANS — normalizeCapabilities
-- coerces every value, so a string array put there would be flattened to `true`
-- on the next read. This is configuration FOR a capability, not a capability.
--
-- ── Why text[] and not a rules table ────────────────────────────────────────
-- It is read on the checkout render path and never joined, searched or counted.
-- A table would buy referential integrity over strings that reference nothing.
--
-- ── The backfill is NULL, and that is the whole safety story ────────────────
-- Empty = "unconfigured" = offered everywhere, which is exactly today's
-- behaviour (lib/locations/pincodes.ts). A migration may not change what a live
-- store does, and a merchant who never opens this screen must keep selling
-- precisely as they did yesterday.

BEGIN;

ALTER TABLE public.store_locations
  ADD COLUMN IF NOT EXISTS pickup_pincodes text[];

COMMENT ON COLUMN public.store_locations.pickup_pincodes IS
  'Postcode rules for customer pickup: exact (400001), prefix (400*) or range (400001-400104). NULL/empty = offered everywhere. Parsed and matched by lib/locations/pincodes.ts. PUBLIC — the storefront reads it at checkout.';

COMMIT;

-- ── Rollback ────────────────────────────────────────────────────────────────
-- BEGIN;
-- ALTER TABLE public.store_locations DROP COLUMN IF EXISTS pickup_pincodes;
-- COMMIT;
