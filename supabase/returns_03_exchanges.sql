-- Returns, step 4 — exchanges.
-- docs/returns-exchanges-plan.md §4. Run as `postgres`, after returns_02.
--
-- ── AN EXCHANGE IS A RETURN PLUS A NEW ORDER ───────────────────────────────
-- ★ Not a third entity. Shopify models it this way and the reason is
-- structural: a distinct `exchanges` table means every stock path, tax
-- calculation, invoice, report and customer-history query grows an
-- "…or exchange" branch, forever. Here it is two rows that already exist —
-- an order_returns row and an orders row — plus one foreign key between them.
--
-- ── The replacement is chosen PER LINE ─────────────────────────────────────
-- "Send back the medium, I want the large" is a statement about one line, not
-- about the basket. So the target lives on order_return_items, and a single
-- return can mix exchanged and refunded lines.
--
-- ── The price is SNAPSHOTTED ───────────────────────────────────────────────
-- Weeks can pass between someone asking and the parcel arriving. Re-reading
-- the price at receipt would mean a customer quoted "no extra charge" being
-- billed the difference because the store repriced in the meantime.

BEGIN;

-- The replacement order, once it exists. NULL until the goods come back —
-- v1 does not ship a replacement before the return arrives (there is no card
-- hold primitive here, so an advance exchange has nothing protecting it).
ALTER TABLE public.order_returns
  ADD COLUMN IF NOT EXISTS exchange_order_id uuid
    REFERENCES public.orders(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS order_returns_exchange_idx
  ON public.order_returns (exchange_order_id)
  WHERE exchange_order_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Per-line replacement
-- ---------------------------------------------------------------------------
ALTER TABLE public.order_return_items
  ADD COLUMN IF NOT EXISTS exchange_product_id uuid
    REFERENCES public.products(id) ON DELETE SET NULL;
ALTER TABLE public.order_return_items
  ADD COLUMN IF NOT EXISTS exchange_variant_id uuid
    REFERENCES public.product_variants(id) ON DELETE SET NULL;

-- What the replacement cost WHEN THEY ASKED. See the header: re-reading it at
-- receipt turns a repricing into a surprise bill.
ALTER TABLE public.order_return_items
  ADD COLUMN IF NOT EXISTS exchange_price numeric(12,2);

-- The units set aside for the replacement (stock_reservations.id, held at
-- request time). Kept here so receiving can COMMIT exactly the holds this
-- line created, and rejecting can release them — rather than re-deriving
-- "which reservation was that?" from owner_type/owner_id and hoping.
ALTER TABLE public.order_return_items
  ADD COLUMN IF NOT EXISTS exchange_hold_id uuid;

COMMENT ON COLUMN public.order_returns.exchange_order_id IS
  'The replacement order. An exchange is a return PLUS a new order, not a third kind of thing — a separate exchanges table would add an "or exchange" branch to every stock, tax and reporting path forever.';
COMMENT ON COLUMN public.order_return_items.exchange_price IS
  'The replacement price at REQUEST time. Snapshotted because weeks pass before the goods arrive, and re-reading it would bill a customer for a repricing they were never quoted.';
COMMENT ON COLUMN public.order_return_items.exchange_hold_id IS
  'stock_reservations.id — units put aside when the exchange was requested, so the size they swapped for cannot sell out while the parcel is in transit.';

COMMIT;

-- ── Rollback ────────────────────────────────────────────────────────────────
-- BEGIN;
-- DROP INDEX IF EXISTS public.order_returns_exchange_idx;
-- ALTER TABLE public.order_return_items
--   DROP COLUMN IF EXISTS exchange_hold_id,
--   DROP COLUMN IF EXISTS exchange_price,
--   DROP COLUMN IF EXISTS exchange_variant_id,
--   DROP COLUMN IF EXISTS exchange_product_id;
-- ALTER TABLE public.order_returns DROP COLUMN IF EXISTS exchange_order_id;
-- COMMIT;
