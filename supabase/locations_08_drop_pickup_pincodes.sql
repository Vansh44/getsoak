-- Locations — remove merchant-typed pickup postcode rules (supersedes locations_07).
--
-- Run as `postgres`.
--
-- locations_07 let a merchant list the postcodes each shop collects to, and the
-- checkout hid the pickup option from anyone outside them. That was the wrong
-- mechanism, and the code arguing for it also argued against it: the checkout
-- needed a "Collecting somewhere else?" escape hatch precisely BECAUSE
-- hand-typed lists have gaps — and a shopper's DELIVERY postcode is a guess at
-- where they are, never a fact about where they will drive. People collect near
-- work, near family, on a route home.
--
-- The better model (ALDO, Shopify, IKEA): offer pickup to everyone, list every
-- shop that has the goods, and let the SHOPPER search by postcode or city. They
-- know where they'll be; the merchant cannot. Excluding a specific shop is
-- already possible — turn off its `pickup` capability.
--
-- Nothing is lost by dropping the column: it only ever decided what was
-- OFFERED, never what was permitted, so no order state depends on it.

BEGIN;

ALTER TABLE public.store_locations DROP COLUMN IF EXISTS pickup_pincodes;

COMMIT;

-- ── Rollback (restores an empty column; the rules themselves are gone) ──────
-- BEGIN;
-- ALTER TABLE public.store_locations ADD COLUMN IF NOT EXISTS pickup_pincodes text[];
-- COMMIT;
