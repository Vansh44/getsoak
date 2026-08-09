-- Customer cancellation requests, and what a cancellation records.
-- Roadmap Step 2. CODEBASE §27.
--
-- Run as `postgres`. Idempotent: safe to re-run.
--
-- ── Columns, not a table ────────────────────────────────────────────────────
-- A cancellation request is a STATE OF THE ORDER, and there is at most one
-- active request per order. A side table would mean every order read either
-- joins it or silently ignores a whole lifecycle — the same reasoning that put
-- the pickup columns on `orders` rather than beside them (CODEBASE §23).
--
-- ── WHOLE-ORDER ONLY, deliberately ─────────────────────────────────────────
-- Nothing here is per line item, and that is a product decision rather than a
-- shortcut: this system has no partial fulfilment, so an order is cancelled or
-- it is not. Per-item cancellation would need partial refunds, partial restocks
-- and an order that stays open afterwards — which is "refund some items", and
-- belongs with returns. Do not add item-level columns here to approximate it.
--
-- ── The lifecycle ──────────────────────────────────────────────────────────
--   NULL         nobody has asked
--   'requested'  customer asked; the merchant has not decided
--   'declined'   merchant said no — the order stays ACTIVE
--   'approved'   merchant said yes; orders.status is 'cancelled'
--
-- `approved` is recorded even though orders.status already says cancelled,
-- because "cancelled at the customer's request" and "cancelled by the shop" are
-- different facts and only this column can tell them apart afterwards.

BEGIN;

ALTER TABLE public.orders
  -- The request lifecycle. NULL = never asked, which is almost every order.
  ADD COLUMN IF NOT EXISTS cancellation_status text,
  ADD COLUMN IF NOT EXISTS cancellation_requested_at timestamptz,
  -- The CUSTOMER's words, shown to the merchant when they decide.
  ADD COLUMN IF NOT EXISTS cancellation_reason text,
  -- The MERCHANT's words on a decline. Shown to the customer — a silent "no"
  -- is the most complained-about thing a request flow does (CODEBASE §28).
  ADD COLUMN IF NOT EXISTS cancellation_decline_reason text,
  ADD COLUMN IF NOT EXISTS cancellation_decided_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancellation_decided_by text,
  -- Why the order was cancelled, from the fixed list in
  -- lib/orders/cancellation.ts. A code, not free text, so two stores' data can
  -- still be compared.
  ADD COLUMN IF NOT EXISTS cancel_reason text,
  -- ★ INTERNAL ONLY. Never rendered on a storefront page, an invoice, or in any
  -- customer notification. If that ever needs enforcing beyond code review, the
  -- anon grant on this table is the place — not a filter at each call site.
  ADD COLUMN IF NOT EXISTS cancel_staff_note text,
  -- Where the money went when it was cancelled: original | store_credit | later.
  ADD COLUMN IF NOT EXISTS cancel_refund_destination text;

DO $$
BEGIN
  ALTER TABLE public.orders
    ADD CONSTRAINT orders_cancellation_status_check
    CHECK (cancellation_status IS NULL
           OR cancellation_status IN ('requested', 'declined', 'approved'));
EXCEPTION
  WHEN duplicate_object THEN NULL; -- already there; re-running must be safe
END $$;

DO $$
BEGIN
  ALTER TABLE public.orders
    ADD CONSTRAINT orders_cancel_refund_destination_check
    CHECK (cancel_refund_destination IS NULL
           OR cancel_refund_destination IN ('original', 'store_credit', 'later'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- The merchant's review queue reads exactly one thing: orders awaiting a
-- decision, newest first. PARTIAL, because the overwhelming majority of orders
-- have no request at all and indexing them would be paying for nothing.
CREATE INDEX IF NOT EXISTS orders_cancellation_pending_idx
  ON public.orders (store_id, cancellation_requested_at DESC)
  WHERE cancellation_status = 'requested';

COMMENT ON COLUMN public.orders.cancellation_status IS
  'Customer cancellation request lifecycle: NULL (never asked) | requested | declined | approved. Whole-order only — there is deliberately no per-item equivalent (see lib/orders/cancellation.ts).';
COMMENT ON COLUMN public.orders.cancel_staff_note IS
  'Internal note from the merchant on cancellation. MUST NOT be shown to the customer anywhere.';

COMMIT;

-- ── Backfill ────────────────────────────────────────────────────────────────
-- None, and that is the honest state: no order has ever had a cancellation
-- request, because the flow did not exist. Every column is nullable and NULL
-- means "nothing happened", so this migration changes what no live store does
-- (roadmap invariant 1).

-- ── Rollback ────────────────────────────────────────────────────────────────
-- BEGIN;
-- DROP INDEX IF EXISTS public.orders_cancellation_pending_idx;
-- ALTER TABLE public.orders
--   DROP CONSTRAINT IF EXISTS orders_cancellation_status_check,
--   DROP CONSTRAINT IF EXISTS orders_cancel_refund_destination_check;
-- ALTER TABLE public.orders
--   DROP COLUMN IF EXISTS cancellation_status,
--   DROP COLUMN IF EXISTS cancellation_requested_at,
--   DROP COLUMN IF EXISTS cancellation_reason,
--   DROP COLUMN IF EXISTS cancellation_decline_reason,
--   DROP COLUMN IF EXISTS cancellation_decided_at,
--   DROP COLUMN IF EXISTS cancellation_decided_by,
--   DROP COLUMN IF EXISTS cancel_reason,
--   DROP COLUMN IF EXISTS cancel_staff_note,
--   DROP COLUMN IF EXISTS cancel_refund_destination;
-- COMMIT;
