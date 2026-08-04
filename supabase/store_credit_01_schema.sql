-- =============================================================
-- Store credit — a customer balance a store owes, spendable at checkout.
-- Roadmap Step 4 / returns-exchanges-plan Step 7. Run as `postgres`.
--
-- ── Why this exists ────────────────────────────────────────────────────────
-- Two paths have been waiting on it:
--   • COD refunds. Nothing was captured, so there is no instrument to send
--     money back to (§3.3). Store credit settles instantly with no bank
--     details, no gateway and no KYC — and it is the cheapest option for the
--     merchant, who keeps the cash.
--   • Exchanges where the replacement costs less: the balance can go to
--     credit instead of a payout.
-- It is always OFFERED, never forced. A customer who wants their money back
-- and is handed a coupon is a customer who complains, and for a defective
-- product that position is legally shaky.
--
-- ── ★ A BALANCE IS MONEY ───────────────────────────────────────────────────
-- So this follows ai_credits.sql exactly, which already solves this problem
-- here: an append-only ledger is the truth, the balance is a cached sum, every
-- mutation is a single conditional UPDATE, and the balance can never go
-- negative (CHECK). Issuing is idempotent per (kind, ref) so a double-confirm
-- credits once.
--
-- ── Scoped per (store, customer) ───────────────────────────────────────────
-- Credit at one store is not spendable at another — the tenancy rule, and also
-- what a merchant would expect, since it is their money. `customer_id` is TEXT
-- because a Firebase uid is a string (phase6_01_uid_columns_to_text.sql).
--
-- Money is numeric(12,2) like every other money column here. Postgres numeric
-- is exact decimal, so there is no float drift to guard against; the paise
-- arithmetic in lib/ exists because JS numbers are floats, not because SQL is.

BEGIN;

CREATE TABLE IF NOT EXISTS public.customer_credit_balances (
  store_id    uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  customer_id text NOT NULL,
  balance     numeric(12,2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, customer_id)
);

-- The truth. The balance above is a cached sum of this.
CREATE TABLE IF NOT EXISTS public.customer_credit_ledger (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id    uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  customer_id text NOT NULL,
  -- Positive issues, negative spends. Never zero.
  delta       numeric(12,2) NOT NULL CHECK (delta <> 0),
  kind        text NOT NULL CHECK (kind IN (
                -- money the store owed and settled as credit
                'refund',
                -- a goodwill gesture, or compensation
                'grant',
                -- paid for an order with it
                'spend',
                -- an order paid with credit was cancelled or refunded, so the
                -- credit comes back. Its own kind, not a second 'grant': a
                -- report that can't tell reinstatement from generosity will
                -- overstate what the store gave away.
                'reinstate',
                -- reserved so the column doesn't need a migration when
                -- expiry lands. Nothing writes it yet.
                'expire'
              )),
  -- What caused it: an order_refunds.id, an orders.id, an operator's email.
  ref         text,
  note        text,
  actor       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ★ Idempotent issue. A refund confirmed twice (the client callback AND the
-- reconcile sweep both seeing the same settlement) must credit once.
CREATE UNIQUE INDEX IF NOT EXISTS customer_credit_ledger_ref_key
  ON public.customer_credit_ledger (store_id, customer_id, kind, ref)
  WHERE ref IS NOT NULL;

-- "Show me this customer's history", newest first.
CREATE INDEX IF NOT EXISTS customer_credit_ledger_customer_idx
  ON public.customer_credit_ledger (store_id, customer_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- What an order paid with credit
-- ---------------------------------------------------------------------------
-- ★ CREDIT IS A PAYMENT, NOT A DISCOUNT — so `orders.total` stays the FULL
-- value of the goods and this records how much of it was settled with credit.
--
-- Netting it off the total instead would be quietly wrong in three places at
-- once: the invoice would understate the sale, GST would be computed on a base
-- that isn't what was sold, and the credit note would reverse the wrong
-- amount. A customer paying ₹200 of a ₹500 order with credit still bought ₹500
-- of goods, and the tax authority's share doesn't shrink because of how they
-- settled it.
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS store_credit_used numeric(12,2) NOT NULL DEFAULT 0
    CHECK (store_credit_used >= 0);

COMMENT ON COLUMN public.orders.store_credit_used IS
  'How much of `total` was settled with store credit. `total` remains the FULL value of the goods — credit is a payment, not a discount, and netting it off would understate the sale on the invoice and compute GST on the wrong base.';

-- ---------------------------------------------------------------------------
-- RLS — customers READ their own; every write is service-role
-- ---------------------------------------------------------------------------
-- A shopper must be able to see what they have, at checkout and on their
-- orders page. Nothing client-side may write it, for obvious reasons.
ALTER TABLE public.customer_credit_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_credit_ledger   ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.customer_credit_balances FROM anon;
REVOKE ALL ON public.customer_credit_ledger   FROM anon;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE tablename='customer_credit_balances'
                    AND policyname='Customers read their own credit') THEN
    -- Scoped by store as well as uid, the pos_08 pairing: a Firebase uid is
    -- global, so uid alone would expose a balance held at another store.
    CREATE POLICY "Customers read their own credit"
      ON public.customer_credit_balances FOR SELECT
      USING (customer_id = auth.uid()
             AND store_id = public.auth_customer_store_id());
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE tablename='customer_credit_ledger'
                    AND policyname='Customers read their own credit history') THEN
    CREATE POLICY "Customers read their own credit history"
      ON public.customer_credit_ledger FOR SELECT
      USING (customer_id = auth.uid()
             AND store_id = public.auth_customer_store_id());
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE tablename='customer_credit_balances'
                    AND policyname='Store admins read credit') THEN
    CREATE POLICY "Store admins read credit"
      ON public.customer_credit_balances FOR SELECT
      USING (public.is_store_admin(store_id));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE tablename='customer_credit_ledger'
                    AND policyname='Store admins read credit history') THEN
    CREATE POLICY "Store admins read credit history"
      ON public.customer_credit_ledger FOR SELECT
      USING (public.is_store_admin(store_id));
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- RPCs — the increment_coupon_usage single-conditional-UPDATE pattern
-- ---------------------------------------------------------------------------

-- Credit a customer. Returns FALSE when this (kind, ref) was already credited,
-- which is a no-op rather than an error: the caller retried, and retrying must
-- be safe.
CREATE OR REPLACE FUNCTION public.add_customer_credit(
  p_store    uuid,
  p_customer text,
  p_amount   numeric,
  p_kind     text,
  p_ref      text,
  p_note     text DEFAULT NULL,
  p_actor    text DEFAULT NULL
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'add_customer_credit: amount must be positive';
  END IF;

  BEGIN
    INSERT INTO public.customer_credit_ledger
      (store_id, customer_id, delta, kind, ref, note, actor)
    VALUES (p_store, p_customer, p_amount, p_kind, p_ref, p_note, p_actor);
  EXCEPTION WHEN unique_violation THEN
    RETURN false;  -- already credited for this ref
  END;

  INSERT INTO public.customer_credit_balances (store_id, customer_id, balance, updated_at)
    VALUES (p_store, p_customer, p_amount, now())
  ON CONFLICT (store_id, customer_id) DO UPDATE
    SET balance = public.customer_credit_balances.balance + excluded.balance,
        updated_at = now();

  RETURN true;
END; $$;

-- ★ Spend, atomically. The `balance >= p_amount` predicate lives INSIDE the
-- UPDATE, so two checkouts racing on the same balance cannot both pass a
-- prior check-then-act and overdraw it. Returns FALSE when there isn't
-- enough — the caller then charges the full amount by other means.
CREATE OR REPLACE FUNCTION public.try_spend_customer_credit(
  p_store    uuid,
  p_customer text,
  p_amount   numeric,
  p_ref      text,
  p_note     text DEFAULT NULL
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v numeric;
BEGIN
  IF p_amount <= 0 THEN
    RETURN false;
  END IF;

  UPDATE public.customer_credit_balances
     SET balance = balance - p_amount, updated_at = now()
   WHERE store_id = p_store AND customer_id = p_customer
     AND balance >= p_amount
  RETURNING balance INTO v;

  IF v IS NULL THEN
    RETURN false;  -- no balance row, or not enough in it
  END IF;

  INSERT INTO public.customer_credit_ledger
    (store_id, customer_id, delta, kind, ref, note)
  VALUES (p_store, p_customer, -p_amount, 'spend', p_ref, p_note);
  RETURN true;
END; $$;

GRANT EXECUTE ON FUNCTION public.add_customer_credit(uuid, text, numeric, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.try_spend_customer_credit(uuid, text, numeric, text, text) TO service_role;

COMMENT ON TABLE public.customer_credit_ledger IS
  'Append-only truth for store credit; customer_credit_balances is a cached sum of it. Issuing is idempotent per (store, customer, kind, ref) so a double-confirmed refund credits once.';
COMMENT ON COLUMN public.customer_credit_ledger.kind IS
  'reinstate is distinct from grant on purpose: a report that cannot tell a returned spend from a goodwill gesture will overstate what the store gave away.';

COMMIT;

-- ── Rollback ────────────────────────────────────────────────────────────────
-- BEGIN;
-- DROP FUNCTION IF EXISTS public.try_spend_customer_credit(uuid, text, numeric, text, text);
-- DROP FUNCTION IF EXISTS public.add_customer_credit(uuid, text, numeric, text, text, text, text);
-- DROP TABLE IF EXISTS public.customer_credit_ledger;
-- DROP TABLE IF EXISTS public.customer_credit_balances;
-- COMMIT;
