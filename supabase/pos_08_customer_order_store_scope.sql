-- Tenant-scope the CUSTOMER order-read policies.
--
-- Run as `postgres` (owner of the tables + the auth schema), like every other
-- migration in this dir.
--
-- ── The gap ─────────────────────────────────────────────────────────────────
-- "Customers can view own orders" was USING (customer_id = auth.uid()) with NO
-- store predicate, and "Customers can view own order items" inlined the same
-- condition. A Firebase uid is global, so those policies said: you may read any
-- order anywhere on the platform that carries your uid — regardless of which
-- store it belongs to.
--
-- That only becomes a disclosure if a foreign customer_id ever lands on an
-- order. app/actions/pos-sale-actions.ts placePosSale did exactly that: it took
-- customerId straight from the client and wrote it with no ownership check, so
-- a register could file its sale against another store's customer. That write
-- is now verified against (id, store_id) in the action — this migration closes
-- the READ side, so the database stops depending on every current and future
-- writer getting it right.
--
-- Impact today was latent, not live: there is no customer-facing order-history
-- page, and /checkout/invoice/[orderId] already guards
-- `data.storeId !== storeId -> notFound()`. The point of this change is that
-- adding an order-history page — an entirely ordinary storefront feature —
-- must not silently turn a stale bad row into a cross-tenant leak.
--
-- ── The predicate ───────────────────────────────────────────────────────────
-- RLS has no request-host context, but it doesn't need any: `users.id` is the
-- PRIMARY KEY, so one uid maps to exactly one users row and therefore exactly
-- one store. A customer's own store IS derivable from their uid alone.
--
-- orders.customer_id carries an FK to users(id), so any non-null customer_id
-- has a users row and this can never spuriously deny a legitimate read. A NULL
-- customer_id (a POS walk-in, pos_06) matches neither the old policy nor the
-- new one, which is correct — nobody's account owns a walk-in sale.
--
-- Delegating to a SECURITY DEFINER helper follows the convention in
-- CODEBASE.md §5.2: policies call a helper rather than inlining a table lookup.
-- SECURITY DEFINER also sidesteps RLS-on-RLS recursion through users.

BEGIN;

-- The store a customer belongs to, or NULL when the caller has no users row
-- (staff, platform operators, anonymous). NULL makes the comparisons below
-- false, which is the safe direction.
CREATE OR REPLACE FUNCTION public.auth_customer_store_id()
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT store_id FROM public.users WHERE id = auth.uid();
$$;

REVOKE ALL ON FUNCTION public.auth_customer_store_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auth_customer_store_id() TO authenticated, anon;

COMMENT ON FUNCTION public.auth_customer_store_id() IS
  'The calling customer''s store, from their uid alone (users.id is the PK, so one uid = one store). NULL when the caller is not a customer.';

DROP POLICY IF EXISTS "Customers can view own orders" ON public.orders;
CREATE POLICY "Customers can view own orders"
ON public.orders FOR SELECT
TO authenticated
USING (
  customer_id = (SELECT auth.uid())
  AND store_id = (SELECT public.auth_customer_store_id())
);

DROP POLICY IF EXISTS "Customers can view own order items" ON public.order_items;
CREATE POLICY "Customers can view own order items"
ON public.order_items FOR SELECT
TO authenticated
USING (
  order_id IN (
    SELECT id FROM public.orders
    WHERE customer_id = (SELECT auth.uid())
      AND store_id = (SELECT public.auth_customer_store_id())
  )
);

-- Guard, in the spirit of the assertion ending
-- platform_admin_01_order_policies.sql. Note it canNOT catch a revert of the
-- two policies above — this migration recreates them a few lines earlier, so
-- re-running it would repair them before any check could see the damage.
--
-- What it DOES catch is the regression that actually threatens this fix: ANY
-- policy on orders/order_items that keys off customer_id without also being
-- store-scoped. That covers the two above (proving the CREATEs took effect and
-- that Postgres rendered the qual as expected) AND any third customer policy
-- added later — which is precisely how this gap would come back.
DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(format('%s."%s"', tablename, policyname), ', ')
    INTO bad
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename IN ('orders', 'order_items')
    AND qual LIKE '%customer_id%'
    AND qual NOT LIKE '%auth_customer_store_id%'
    -- Admin policies legitimately reach orders by store_id, not customer_id,
    -- and are scoped by is_store_admin() instead.
    AND qual NOT LIKE '%is_store_admin%';

  IF bad IS NOT NULL THEN
    RAISE EXCEPTION
      'Customer order policy is not store-scoped (add auth_customer_store_id()): %', bad;
  END IF;
END $$;

COMMIT;

-- ── Rollback ────────────────────────────────────────────────────────────────
-- Restores the pre-migration (uid-only) policies from
-- phase6_01_uid_columns_to_text.sql. Only for backing this change out — it
-- reopens the cross-tenant read.
--
-- BEGIN;
-- DROP POLICY IF EXISTS "Customers can view own orders" ON public.orders;
-- CREATE POLICY "Customers can view own orders" ON public.orders
--   AS PERMISSIVE FOR SELECT TO authenticated
--   USING ((customer_id = auth.uid()));
--
-- DROP POLICY IF EXISTS "Customers can view own order items" ON public.order_items;
-- CREATE POLICY "Customers can view own order items" ON public.order_items
--   AS PERMISSIVE FOR SELECT TO authenticated
--   USING ((order_id IN ( SELECT orders.id FROM public.orders
--     WHERE (orders.customer_id = auth.uid()))));
--
-- DROP FUNCTION IF EXISTS public.auth_customer_store_id();
-- COMMIT;
