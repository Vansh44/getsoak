-- POS Phase 5 / Locations Phase G — returns and refunds at the till.
--
-- Run as `postgres`, after pos_11.
--
-- ── Two tables, because they are two different facts ────────────────────────
-- Goods coming back and money going back are not the same event and do not
-- always happen together: a return can be refunded across two tenders, and a
-- refund can exist with no return at all (a cancelled order — roadmap Step 2,
-- which reuses `order_refunds` unchanged). Modelling them as one row would
-- force one to lie whenever the other is absent.
--
-- ── Scope of THIS migration ────────────────────────────────────────────────
-- In-store returns of in-store sales, where the money is handed back at the
-- counter — cash from the drawer, or the shop's own card machine. No gateway
-- call is involved, so this does NOT depend on the Razorpay refund work.
-- `gateway_refund_id` and `status` are here so that work (and returning an
-- ONLINE order in store) drops in without a second migration.
--
-- ── No `damaged` inventory bucket yet ──────────────────────────────────────
-- The condition of each returned unit is recorded per line, and only
-- `sellable` units go back on the shelf. A separate `damaged` counter is
-- deliberately NOT added: nothing would read it yet, and a column that only
-- ever accumulates is worse than the ledger rows we already write. Add it with
-- the write-off workflow that consumes it.

BEGIN;

-- ---------------------------------------------------------------------------
-- Goods back
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.order_returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  -- Where the goods physically came back to. NOT the location that sold them:
  -- a chain lets you return to any shop, and that shop's shelf is the one that
  -- gains the stock.
  location_id uuid REFERENCES public.store_locations(id),
  -- The drawer this return belongs to, stamped at the time (pos_10) — so a
  -- cash refund lands in the shift it was actually paid out of.
  shift_id uuid REFERENCES public.pos_shifts(id),
  amount numeric(12,2) NOT NULL DEFAULT 0,
  tax numeric(12,2) NOT NULL DEFAULT 0,
  total numeric(12,2) NOT NULL DEFAULT 0,
  reason text,
  actor text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.order_return_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id uuid NOT NULL REFERENCES public.order_returns(id) ON DELETE CASCADE,
  order_item_id uuid NOT NULL REFERENCES public.order_items(id) ON DELETE CASCADE,
  quantity integer NOT NULL CHECK (quantity > 0),
  amount numeric(12,2) NOT NULL DEFAULT 0,
  tax numeric(12,2) NOT NULL DEFAULT 0,
  total numeric(12,2) NOT NULL DEFAULT 0,
  -- 'sellable' goes back on the shelf; 'damaged' does not. Recorded per LINE
  -- because one return can be both — two tins back, one of them dented.
  condition text NOT NULL DEFAULT 'sellable'
    CHECK (condition IN ('sellable', 'damaged')),
  restocked boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- "How many units of this line have already come back?" — the question every
-- return has to answer before it can allow another one.
CREATE INDEX IF NOT EXISTS order_return_items_line_idx
  ON public.order_return_items (order_item_id);
CREATE INDEX IF NOT EXISTS order_returns_order_idx
  ON public.order_returns (order_id);

-- ---------------------------------------------------------------------------
-- Money back
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.order_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  -- Null when money moves without goods coming back (a cancellation).
  return_id uuid REFERENCES public.order_returns(id) ON DELETE SET NULL,
  location_id uuid REFERENCES public.store_locations(id),
  shift_id uuid REFERENCES public.pos_shifts(id),
  method text NOT NULL,
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  -- For a gateway refund (roadmap Step 2). UNIQUE so replaying a webhook or a
  -- retried call cannot record the same refund twice.
  gateway_refund_id text,
  status text NOT NULL DEFAULT 'completed'
    CHECK (status IN ('pending', 'completed', 'failed')),
  actor text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS order_refunds_gateway_key
  ON public.order_refunds (gateway_refund_id)
  WHERE gateway_refund_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS order_refunds_order_idx
  ON public.order_refunds (order_id);
-- The shift report sums cash refunds out of the drawer.
CREATE INDEX IF NOT EXISTS order_refunds_shift_idx
  ON public.order_refunds (shift_id) WHERE shift_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- RLS — read for store admins, writes service-role only
-- ---------------------------------------------------------------------------
-- Same contract as the rest of POS: nothing client-side may forge a refund.
ALTER TABLE public.order_returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_return_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_refunds ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE tablename = 'order_returns' AND policyname = 'Store admins read returns') THEN
    CREATE POLICY "Store admins read returns" ON public.order_returns
      FOR SELECT USING (public.is_store_admin(store_id));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE tablename = 'order_refunds' AND policyname = 'Store admins read refunds') THEN
    CREATE POLICY "Store admins read refunds" ON public.order_refunds
      FOR SELECT USING (public.is_store_admin(store_id));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE tablename = 'order_return_items' AND policyname = 'Store admins read return items') THEN
    CREATE POLICY "Store admins read return items" ON public.order_return_items
      FOR SELECT USING (EXISTS (
        SELECT 1 FROM public.order_returns r
         WHERE r.id = order_return_items.return_id
           AND public.is_store_admin(r.store_id)
      ));
  END IF;
END $$;

COMMENT ON TABLE public.order_returns IS
  'Goods coming back. Separate from order_refunds because a return can be refunded across several tenders, and a refund can happen with no return (a cancellation).';
COMMENT ON COLUMN public.order_return_items.condition IS
  'sellable goes back on the shelf; damaged does not. Per line, because one return can be both.';
COMMENT ON COLUMN public.order_refunds.gateway_refund_id IS
  'Razorpay refund id (roadmap Step 2). UNIQUE, so a replayed webhook or retried call cannot record the same refund twice.';

COMMIT;

-- ── Rollback ────────────────────────────────────────────────────────────────
-- BEGIN;
-- DROP TABLE IF EXISTS public.order_refunds;
-- DROP TABLE IF EXISTS public.order_return_items;
-- DROP TABLE IF EXISTS public.order_returns;
-- COMMIT;
