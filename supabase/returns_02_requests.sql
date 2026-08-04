-- Returns, step 3 — a return can now be REQUESTED and reviewed.
-- docs/returns-exchanges-plan.md §7.3. Run as `postgres`, after
-- pos_12_returns.sql and returns_01_product_policy.sql.
--
-- ── A NEW FILE, because pos_12 has already run ─────────────────────────────
-- Editing its CREATE TABLE IF NOT EXISTS is a silent no-op (§15b). Everything
-- here is additive.
--
-- ── Why order_returns grows a lifecycle instead of getting a sibling ───────
-- A till return and a posted-back return are the SAME fact — goods coming
-- back — reached by different routes. A separate `return_requests` table would
-- mean every reader (the refund maths, the restock, the customer's history,
-- any future report) either joins both or silently ignores one of them. What
-- differs is only how much of the lifecycle each route actually traverses.
--
-- ★ THE DEFAULT IS 'completed', AND THAT IS LOAD-BEARING.
-- Every existing row is a till return that was finished the moment it was
-- written — goods in hand, money out of the drawer. Defaulting to 'requested'
-- would retroactively reopen every return the shop has ever taken, and
-- pos-return-actions.ts (which does not set the column) would start filing
-- completed counter refunds as pending paperwork. Invariant 1.

BEGIN;

-- ---------------------------------------------------------------------------
-- order_returns — the request lifecycle
-- ---------------------------------------------------------------------------
--   requested → approved → received → completed
--             ↘ rejected
--             ↘ cancelled  (withdrawn by the customer)
-- `received` is separate from `completed` because goods arriving and money
-- going back are different events (pos_12's founding observation) and a
-- merchant may inspect before refunding.
ALTER TABLE public.order_returns
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'completed';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'order_returns_status_check'
  ) THEN
    ALTER TABLE public.order_returns
      ADD CONSTRAINT order_returns_status_check CHECK (status IN (
        'requested', 'approved', 'rejected', 'received', 'completed', 'cancelled'
      ));
  END IF;
END $$;

-- How it got here. 'pos' = rung at a counter (everything that already exists);
-- 'online' = the customer asked from their order page.
ALTER TABLE public.order_returns
  ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'pos';

-- Who asked. NULL for a till return — the customer is standing there.
ALTER TABLE public.order_returns
  ADD COLUMN IF NOT EXISTS requested_by text;

-- A key from lib/returns/reasons.ts. The free-text `reason` column already on
-- this table stays as the customer's own words; this is the one that DECIDES
-- things (whether fees apply, who pays postage), so it is separate and
-- constrained rather than parsed out of prose.
ALTER TABLE public.order_returns
  ADD COLUMN IF NOT EXISTS reason_code text;

-- Evidence for a damage claim — GCS URLs, same bucket as everything else.
ALTER TABLE public.order_returns
  ADD COLUMN IF NOT EXISTS photos jsonb NOT NULL DEFAULT '[]'::jsonb;

-- What was deducted, snapshotted at DECISION time. Not recomputed on read:
-- the store's restocking percentage can change next week, and a customer was
-- quoted a number when they sent the parcel.
ALTER TABLE public.order_returns
  ADD COLUMN IF NOT EXISTS restocking_fee numeric(12,2) NOT NULL DEFAULT 0;
ALTER TABLE public.order_returns
  ADD COLUMN IF NOT EXISTS return_shipping_fee numeric(12,2) NOT NULL DEFAULT 0;

ALTER TABLE public.order_returns
  ADD COLUMN IF NOT EXISTS reviewed_by text;
ALTER TABLE public.order_returns
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
-- Shown to the CUSTOMER, so a rejection is never a silent no.
ALTER TABLE public.order_returns
  ADD COLUMN IF NOT EXISTS review_note text;
ALTER TABLE public.order_returns
  ADD COLUMN IF NOT EXISTS received_at timestamptz;

-- The review queue: open requests for a store, oldest first.
CREATE INDEX IF NOT EXISTS order_returns_open_idx
  ON public.order_returns (store_id, created_at)
  WHERE status IN ('requested', 'approved', 'received');

-- "What has this customer already asked for?" — the request path's own version
-- of the per-line question order_return_items_line_idx answers.
CREATE INDEX IF NOT EXISTS order_returns_requested_by_idx
  ON public.order_returns (requested_by)
  WHERE requested_by IS NOT NULL;

-- ---------------------------------------------------------------------------
-- RLS — customers may READ their own returns
-- ---------------------------------------------------------------------------
-- Writes stay service-role (pos_12's contract, and convention #12's model):
-- nothing client-side may forge a return or move it along its lifecycle. But a
-- shopper has to be able to see what happened to their own request, so SELECT
-- opens up — scoped BOTH by the owning order's customer_id AND by store, the
-- same pairing pos_08_customer_order_store_scope.sql applies to orders: a
-- Firebase uid is global, so uid alone would expose a return filed on another
-- store while browsing this one.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE tablename = 'order_returns'
       AND policyname = 'Customers read their own returns'
  ) THEN
    CREATE POLICY "Customers read their own returns" ON public.order_returns
      FOR SELECT USING (EXISTS (
        SELECT 1 FROM public.orders o
         WHERE o.id = order_returns.order_id
           AND o.customer_id = auth.uid()
           AND o.store_id = order_returns.store_id
      ));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE tablename = 'order_return_items'
       AND policyname = 'Customers read their own return items'
  ) THEN
    CREATE POLICY "Customers read their own return items" ON public.order_return_items
      FOR SELECT USING (EXISTS (
        SELECT 1 FROM public.order_returns r
          JOIN public.orders o ON o.id = r.order_id
         WHERE r.id = order_return_items.return_id
           AND o.customer_id = auth.uid()
           AND o.store_id = r.store_id
      ));
  END IF;
END $$;

COMMENT ON COLUMN public.order_returns.status IS
  'requested → approved → received → completed, or rejected/cancelled. DEFAULT completed because every pre-existing row is a till return that was finished when written — defaulting to requested would reopen every return the shop has ever taken.';
COMMENT ON COLUMN public.order_returns.reason_code IS
  'A key from lib/returns/reasons.ts. Decides whether fees apply and who pays postage — kept apart from the free-text `reason`, which is the customer''s own words.';
COMMENT ON COLUMN public.order_returns.restocking_fee IS
  'Snapshotted at decision time, never recomputed: the store''s percentage can change next week, and the customer was quoted a number when they posted the parcel.';

COMMIT;

-- ── Rollback ────────────────────────────────────────────────────────────────
-- BEGIN;
-- DROP POLICY IF EXISTS "Customers read their own return items" ON public.order_return_items;
-- DROP POLICY IF EXISTS "Customers read their own returns" ON public.order_returns;
-- DROP INDEX IF EXISTS public.order_returns_requested_by_idx;
-- DROP INDEX IF EXISTS public.order_returns_open_idx;
-- ALTER TABLE public.order_returns DROP CONSTRAINT IF EXISTS order_returns_status_check;
-- ALTER TABLE public.order_returns
--   DROP COLUMN IF EXISTS received_at,
--   DROP COLUMN IF EXISTS review_note,
--   DROP COLUMN IF EXISTS reviewed_at,
--   DROP COLUMN IF EXISTS reviewed_by,
--   DROP COLUMN IF EXISTS return_shipping_fee,
--   DROP COLUMN IF EXISTS restocking_fee,
--   DROP COLUMN IF EXISTS photos,
--   DROP COLUMN IF EXISTS reason_code,
--   DROP COLUMN IF EXISTS requested_by,
--   DROP COLUMN IF EXISTS channel,
--   DROP COLUMN IF EXISTS status;
-- COMMIT;
