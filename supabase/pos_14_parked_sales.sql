-- Parked (held) sales — suspend a transaction and serve the next customer.
-- CODEBASE §22. Run as `postgres`. Idempotent: safe to re-run.
--
-- ── ★★ WHY THIS IS A TABLE AND NOT localStorage ────────────────────────────
-- A park has to survive the thing it exists for. The till IDLE-LOCKS after ten
-- minutes (§22) and `posLock` clears the session — which is exactly the window
-- in which a parked sale matters, because the cashier walked away to fetch
-- something. It also has to be resumable from a DIFFERENT till: one cashier
-- parks, another finishes it when the customer comes back to a free counter.
-- Neither works in browser storage.
--
-- ── ★★ A PARK DOES NOT HOLD STOCK, AND THAT IS DELIBERATE ──────────────────
-- The units stay sellable. Holding them (§23's holdStock) was considered and
-- rejected: a cashier could park ten carts and empty the shelf on paper, an
-- abandoned park would strand stock until something swept it, and the shop
-- would reorder goods it still has. A park is a note to self, not a promise to
-- a customer.
--
-- The consequence is honest and already handled: `placePosSale` re-reads every
-- price and reserves stock atomically at completion, so a resumed sale whose
-- goods sold out meanwhile fails there with the existing "only N left" message,
-- against live data. Nothing about parking is trusted at the point money moves.
--
-- ── ★ PRICES ARE NOT STORED ────────────────────────────────────────────────
-- Only what was CHOSEN — the products, their quantities, the discounts, the
-- customer. A parked sale can sit for hours; storing the price would let a
-- resumed cart charge yesterday's, which is the same reason placePosSale
-- ignores client prices in the first place.

BEGIN;

CREATE TABLE IF NOT EXISTS public.pos_parked_sales (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id       uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  -- ★ Per LOCATION, not per device or per cashier: a parked sale belongs to the
  -- SHOP. Whoever is free when the customer returns should be able to finish
  -- it, which is the whole point of parking rather than asking them to wait.
  location_id    uuid NOT NULL REFERENCES public.store_locations(id) ON DELETE CASCADE,
  -- What the cashier calls it — "blue jacket", a name, a phone. Optional,
  -- because at a queue the fastest park is one that asks nothing.
  label          text,
  -- [{productId, variantId, quantity, lineDiscount}] — CHOICES, never prices.
  lines          jsonb NOT NULL,
  order_discount numeric(10, 2) NOT NULL DEFAULT 0,
  customer_id    text,
  customer_gstin text,
  note           text,
  -- Who parked it, so a busy shop can tell three held carts apart.
  parked_by      text,
  parked_by_name text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- The list is always "what is parked at THIS counter, newest first".
CREATE INDEX IF NOT EXISTS pos_parked_sales_location_idx
  ON public.pos_parked_sales (location_id, created_at DESC);
-- Retention (§32) would filter on created_at alone, which the composite above
-- cannot serve.
CREATE INDEX IF NOT EXISTS pos_parked_sales_created_idx
  ON public.pos_parked_sales (created_at);

-- Service-role only, like every other POS table: every write goes through a
-- resolved operator, and there is no client that should read this directly.
ALTER TABLE public.pos_parked_sales ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pos_parked_sales FROM anon, authenticated;

COMMENT ON TABLE public.pos_parked_sales IS
  'Suspended till transactions (§22). Holds CHOICES, never prices — placePosSale re-reads both price and stock at completion. Does NOT reserve stock: a park is a note to self, not a promise, and holding would let one cashier empty a shelf on paper.';

COMMIT;

-- ── Rollback ────────────────────────────────────────────────────────────────
-- Safe: nothing references this table, and a lost park costs a re-scan.
--
-- BEGIN;
-- DROP TABLE IF EXISTS public.pos_parked_sales;
-- COMMIT;
