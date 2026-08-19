-- One gateway payment settles ONE sale (roadmap Step 12, CODEBASE §18/§22).
-- Run as `postgres`. Idempotent: safe to re-run.
--
-- ── What this closes ───────────────────────────────────────────────────────
-- `razorpay` has been in TENDER_METHODS since the till was built, with no
-- gateway call behind it anywhere — accepted, recorded, and counted in shift
-- reconciliation as money the gateway never received. Step 12 makes the tender
-- real: placePosSale now reads the payment back from Razorpay with the store's
-- own credentials and refuses anything that is not a CAPTURED INR payment for
-- the exact tender amount.
--
-- ── ★★ WHY A CONSTRAINT AND NOT JUST THE CHECK IN THE ACTION ───────────────
-- Verification proves the money was taken. It does NOT prove the money has not
-- ALREADY been spent settling a different sale — a captured payment stays
-- captured, so re-presenting the same reference verifies perfectly every time.
-- The action does check `order_payments` first, but that is a read followed by
-- a write: two tills posting the same reference in the same moment both pass.
--
-- A partial unique index makes the second one impossible, which is the rule
-- §34 states as "constraints, not application logic" and the same shape as
-- `billing_payment_attempts_one_in_flight` and the one-open-shift-per-location
-- index in pos_10.
--
-- ── ★ WHY IT IS PARTIAL, AND SCOPED PER STORE ──────────────────────────────
-- • `method = 'razorpay'` only. `card` and `upi` are EXTERNAL-terminal records
--   whose `reference` is a slip number a human types (§7 of docs/pos-plan.md);
--   two of those legitimately collide, and cash has no reference at all.
-- • `reference is not null` keeps every referenceless tender out of the index.
-- • Per STORE, because each merchant has their OWN Razorpay account (BYO, §18)
--   and payment ids are only unique within one account. A global index would
--   let one merchant's id collide with another's — a cross-tenant failure in
--   the one direction tenancy rules exist to prevent.

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS order_payments_gateway_ref_key
  ON public.order_payments (store_id, reference)
  WHERE method = 'razorpay' AND reference IS NOT NULL;

COMMENT ON INDEX public.order_payments_gateway_ref_key IS
  'One captured gateway payment settles ONE sale (§18 Step 12). Partial: card/upi references are human-typed slip numbers that legitimately repeat, and cash has none. Per store because BYO Razorpay ids are only unique within one merchant account.';

COMMIT;

-- ── Verify ──────────────────────────────────────────────────────────────────
-- Expect exactly one row.
--
-- SELECT indexname FROM pg_indexes
--  WHERE schemaname = 'public' AND indexname = 'order_payments_gateway_ref_key';

-- ── Rollback ────────────────────────────────────────────────────────────────
-- ⚠ Dropping this leaves the app-level check as the only replay guard, which a
-- concurrent pair of sales can slip past. Only do it if a legitimate duplicate
-- reference is genuinely blocking a merchant, and fix the cause.
--
-- BEGIN;
-- DROP INDEX IF EXISTS public.order_payments_gateway_ref_key;
-- COMMIT;
