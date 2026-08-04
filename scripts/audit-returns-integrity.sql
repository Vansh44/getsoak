-- =============================================================
-- Returns / refunds / store-credit integrity audit  (CODEBASE §26, §28, §29)
--
-- READ ONLY. Run it against any environment; it writes nothing.
--
-- ★ ONE STATEMENT, NO psql META-COMMANDS, so it pastes straight into Cloud
--   SQL Studio, any GUI client, or psql. It began life with `\echo` headers
--   and Studio rejected the whole thing with `syntax error at or near "\"` —
--   a script only some clients can run is a script that doesn't get run.
--   The scope row rides in the same result set for the same reason.
--
--   Cloud SQL Studio:  paste and Run.
--   psql:              psql "$DATABASE_URL" -f scripts/audit-returns-integrity.sql
--
-- ⚠ THE ROLE MATTERS. `app` is RLS-bound and, with no request GUCs set,
-- reads back ZERO rows from every one of these tables — so the audit would
-- print a clean bill of health for a database it cannot see. Run it as
-- `app_service` (BYPASSRLS, what withService uses) or as `postgres`; Cloud
-- SQL Studio connects as whatever user you picked, so run
-- `SET ROLE app_service;` first if that user isn't already one of them. The
-- `scope` row exists to make the mistake obvious: if it reports 0 orders on
-- a live database, the role is wrong, not the data.
--
-- ⚠ ON A DATABASE WITHOUT THE RETURNS MIGRATIONS it fails with
-- `relation "public.order_returns" does not exist`. That error IS an answer,
-- and a good one — returns have never run there, so nothing can be wrong
-- with them. (Production was exactly this on 2026-08-04.)
--
-- ── Why this exists ────────────────────────────────────────────────────────
-- The returns surfaces shipped with six ways for money to leave that
-- shouldn't have (fixed 2026-08-04). Four of them were reachable from a
-- CLIENT — a signed-in shopper with devtools, not just a rogue cashier — so
-- fixing the code answers "can it happen again" but not "did it already".
-- Only the data can answer that.
--
-- Each check is written so a HEALTHY database returns NOTHING — which is why
-- the `scope` row is always returned alongside them. A grid holding only that
-- row means the checks ran and found nothing; an EMPTY grid means something
-- went wrong with the query itself.
--
-- ── The one that leaves no trace ───────────────────────────────────────────
-- `refunds_over_total` and `units_over_returned` catch the damage. But a
-- duplicate-line request that stayed WITHIN the order total is invisible in
-- the totals and only shows up as `duplicate_return_line` — two rows in
-- order_return_items naming the same order item. The application never had a
-- legitimate reason to write that, so any hit is the multiplication bug.
-- =============================================================

WITH
-- Statuses that still hold units. A rejected or cancelled return gave its
-- quantities back, so counting them would flag healthy orders.
open_returns AS (
  SELECT id, order_id, store_id, total
    FROM public.order_returns
   WHERE status IN ('requested', 'approved', 'received', 'completed')
),

-- ── 1. More units came back than were ever sold ─────────────────────────
-- The headline symptom of the per-entry quantity clamp, and of the two-till
-- race. Physically impossible, so any row here is real.
units_over_returned AS (
  SELECT 'units_over_returned' AS finding,
         o.store_id,
         o.order_ref AS ref,
         jsonb_build_object(
           'order_item_id', oi.id,
           'sold', oi.quantity,
           'returned', SUM(ri.quantity)
         ) AS detail
    FROM public.order_items oi
    JOIN public.orders o           ON o.id = oi.order_id
    JOIN public.order_return_items ri ON ri.order_item_id = oi.id
    JOIN open_returns r            ON r.id = ri.return_id
   GROUP BY o.store_id, o.order_ref, oi.id, oi.quantity
  HAVING SUM(ri.quantity) > oi.quantity
),

-- ── 2. More money went back than the order was worth ────────────────────
-- A pending refund counts: it hasn't settled but might (§26). Only `failed`
-- frees its amount. The 0.01 slack keeps rounding out of it.
refunds_over_total AS (
  SELECT 'refunds_over_total' AS finding,
         o.store_id,
         o.order_ref AS ref,
         jsonb_build_object(
           'order_total', o.total,
           'refunded', SUM(rf.amount),
           'excess', ROUND(SUM(rf.amount) - o.total, 2)
         ) AS detail
    FROM public.orders o
    JOIN public.order_refunds rf ON rf.order_id = o.id
   WHERE rf.status <> 'failed'
   GROUP BY o.id, o.store_id, o.order_ref, o.total
  HAVING SUM(rf.amount) > o.total + 0.01
),

-- ── 3. More MONEY went back than money ever paid ────────────────────────
-- orders.total is the full goods value even when part was settled with store
-- credit, so a cash or gateway refund of `total` hands back an amount no
-- instrument received. Only orders that actually used credit can be affected.
money_over_paid AS (
  SELECT 'money_refund_over_paid' AS finding,
         o.store_id,
         o.order_ref AS ref,
         jsonb_build_object(
           'order_total', o.total,
           'store_credit_used', o.store_credit_used,
           'money_paid', ROUND(o.total - o.store_credit_used, 2),
           'money_refunded', SUM(rf.amount)
         ) AS detail
    FROM public.orders o
    JOIN public.order_refunds rf ON rf.order_id = o.id
   WHERE rf.status <> 'failed'
     AND rf.method <> 'store_credit'
     AND o.store_credit_used > 0
   GROUP BY o.id, o.store_id, o.order_ref, o.total, o.store_credit_used
  HAVING SUM(rf.amount) > (o.total - o.store_credit_used) + 0.01
),

-- ── 4. One return naming the same line twice ────────────────────────────
-- ★ The fingerprint of the per-entry clamp, and the ONLY check that catches
-- an exploit which stayed inside the order total. Nothing in the application
-- has ever had a reason to write two rows for one order item in one return.
duplicate_return_line AS (
  SELECT 'duplicate_return_line' AS finding,
         r.store_id,
         o.order_ref AS ref,
         jsonb_build_object(
           'return_id', r.id,
           'order_item_id', ri.order_item_id,
           'rows', COUNT(*),
           'units', SUM(ri.quantity)
         ) AS detail
    FROM public.order_return_items ri
    JOIN public.order_returns r ON r.id = ri.return_id
    JOIN public.orders o        ON o.id = r.order_id
   GROUP BY r.store_id, r.id, o.order_ref, ri.order_item_id
  HAVING COUNT(*) > 1
),

-- ── 5. Credit given back twice on one order ─────────────────────────────
-- Refund-as-credit AND a cancel reinstatement for the same order. The
-- per-(kind, ref) idempotency can't see this: one row is a `refund` keyed on
-- the refund, the other a `reinstate` keyed on the order.
double_credit AS (
  SELECT 'credit_returned_twice' AS finding,
         o.store_id,
         o.order_ref AS ref,
         jsonb_build_object(
           'customer_id', l.customer_id,
           'refunded_as_credit', (
             SELECT SUM(amount) FROM public.order_refunds
              WHERE order_id = o.id AND method = 'store_credit'
                AND status = 'completed'
           ),
           'reinstated', l.delta
         ) AS detail
    FROM public.customer_credit_ledger l
    JOIN public.orders o ON o.id::text = l.ref
   WHERE l.kind = 'reinstate'
     AND EXISTS (
           SELECT 1 FROM public.order_refunds rf
            WHERE rf.order_id = o.id
              AND rf.method = 'store_credit'
              AND rf.status = 'completed'
         )
),

-- ── 6. A balance that its own ledger doesn't explain ────────────────────
-- The balance is a cached sum of the append-only ledger. Any drift means
-- something wrote it outside the two RPCs, which is the one thing §29 says
-- must never happen.
credit_drift AS (
  SELECT 'credit_balance_drift' AS finding,
         b.store_id,
         b.customer_id AS ref,
         jsonb_build_object(
           'balance', b.balance,
           'ledger_sum', COALESCE(SUM(l.delta), 0)
         ) AS detail
    FROM public.customer_credit_balances b
    LEFT JOIN public.customer_credit_ledger l
           ON l.store_id = b.store_id AND l.customer_id = b.customer_id
   GROUP BY b.store_id, b.customer_id, b.balance
  HAVING b.balance <> COALESCE(SUM(l.delta), 0)
),

-- ── 7. An exchange that also quotes a refund ────────────────────────────
-- A like-for-like swap settles to zero. A non-zero total on a return with
-- swap lines is either a genuinely cheaper replacement (fine — check the
-- amount) or the over-quoting bug. Advisory, so review rather than assume.
exchange_with_refund AS (
  SELECT 'exchange_quotes_refund' AS finding,
         r.store_id,
         o.order_ref AS ref,
         jsonb_build_object(
           'return_id', r.id,
           'quoted_refund', r.total,
           'goods_value', r.amount,
           'actually_refunded', COALESCE((
             SELECT SUM(rf.amount) FROM public.order_refunds rf
              WHERE rf.return_id = r.id AND rf.status = 'completed'
           ), 0)
         ) AS detail
    FROM public.order_returns r
    JOIN public.orders o ON o.id = r.order_id
   WHERE r.total > 0
     AND EXISTS (
           SELECT 1 FROM public.order_return_items ri
            WHERE ri.return_id = r.id AND ri.exchange_variant_id IS NOT NULL
         )
),

-- ── The scope row — ALWAYS returned ─────────────────────────────────────
-- So an empty grid is never ambiguous. It answers "did this look at
-- anything?" before you read the absence of findings as good news.
scope AS (
  SELECT 'scope' AS finding,
         NULL::uuid AS store_id,
         NULL::text AS ref,
         jsonb_build_object(
           'database', current_database(),
           'role', current_user,
           'orders', (SELECT COUNT(*) FROM public.orders),
           'returns', (SELECT COUNT(*) FROM public.order_returns),
           'return_lines', (SELECT COUNT(*) FROM public.order_return_items),
           'refunds', (SELECT COUNT(*) FROM public.order_refunds),
           'refunded_value', (SELECT COALESCE(SUM(amount), 0)
                                FROM public.order_refunds WHERE status <> 'failed'),
           'credit_entries', (SELECT COUNT(*) FROM public.customer_credit_ledger),
           'credit_outstanding', (SELECT COALESCE(SUM(balance), 0)
                                    FROM public.customer_credit_balances)
         ) AS detail
)

SELECT *
  FROM (
        SELECT * FROM scope
  UNION ALL SELECT * FROM units_over_returned
  UNION ALL SELECT * FROM refunds_over_total
  UNION ALL SELECT * FROM money_over_paid
  UNION ALL SELECT * FROM duplicate_return_line
  UNION ALL SELECT * FROM double_credit
  UNION ALL SELECT * FROM credit_drift
  UNION ALL SELECT * FROM exchange_with_refund
       ) rows
 -- Scope first, then findings alphabetically. The UNION is wrapped in a FROM
 -- because a UNION's own ORDER BY takes only bare result column names, never
 -- an expression. And the column is `finding`, not `check`: `check` survives
 -- as a column ALIAS but is parsed as the CHECK keyword the moment you sort
 -- by it.
 ORDER BY (finding <> 'scope'), finding, store_id, ref;
