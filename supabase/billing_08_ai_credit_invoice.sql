-- =============================================================
-- §34/§16 — link an AI credit purchase to its invoice.
--
-- `billing_invoices` has carried `kind = 'ai_credits'` since billing_03, and
-- `buildAiCreditsInvoice` / `createAiCreditsInvoice` have existed unused since
-- the invoice repository landed: a credit purchase produced no document at all.
-- That was survivable while merchants could not see ANY invoice; now that
-- /dashboard/plans/invoices lists them, a purchase that appears nowhere is a
-- receipt the merchant cannot produce.
--
-- ★ THE LINK LIVES ON THE PURCHASE, not the invoice. `billing_invoices` is the
-- generic document table and already carries one product-specific column
-- (`addon_target_count`); adding a second would start a pattern of one column per
-- product. The purchase is the thing that HAS an invoice, so it points at one.
--
-- ★ ON DELETE SET NULL, not CASCADE. Deleting an invoice must never delete the
-- record of a payment — and the immutability triggers mean a finalized invoice is
-- not deletable anyway, so this only covers a draft being cleaned up.
--
-- ⚠ Its OWN file: `ai_credits.sql` is applied everywhere, and editing an applied
-- `create table if not exists` is a silent no-op (§15b).
--
-- Run AFTER billing_01..07. Apply as `postgres`. Idempotent.
-- =============================================================

alter table public.ai_credit_purchases
  add column if not exists invoice_id uuid
    references public.billing_invoices(id) on delete set null;

-- One invoice belongs to at most one purchase. Without this a retry that
-- mistakenly reused an invoice id would produce two purchases claiming the same
-- document number — which an audit reads as a duplicated sale.
create unique index if not exists ai_credit_purchases_invoice_key
  on public.ai_credit_purchases (invoice_id)
  where invoice_id is not null;

-- ── Verify, leaving nothing behind ──────────────────────────────────────────
-- Mutations run in a plpgsql subtransaction that is rolled back, so no row
-- persists and no invoice number is burned; results survive in a variable,
-- which is memory rather than transactional state (the billing_verify pattern).
DO $$
DECLARE
  v_store   uuid;
  v_inv     uuid;
  v_results text[] := '{}';
  v_ok      int := 0;
  v_ran     int := 0;
BEGIN
  SELECT id INTO v_store FROM public.stores LIMIT 1;
  IF v_store IS NULL THEN
    RAISE NOTICE 'billing_08: no stores to test against — column applied, checks skipped';
    RETURN;
  END IF;

  BEGIN
    -- 1. A purchase may carry an invoice id.
    v_ran := v_ran + 1;
    INSERT INTO public.billing_invoices (store_id, kind, cycle_seq)
      VALUES (v_store, 'ai_credits', NULL) RETURNING id INTO v_inv;
    INSERT INTO public.ai_credit_purchases
      (store_id, pack_id, credits, amount_inr, invoice_id)
      VALUES (v_store, 'test', 25, 59, v_inv);
    v_ok := v_ok + 1;
    v_results := v_results || 'PASS purchase accepts an invoice_id'::text;

    -- 2. A SECOND purchase cannot claim the same invoice.
    v_ran := v_ran + 1;
    BEGIN
      INSERT INTO public.ai_credit_purchases
        (store_id, pack_id, credits, amount_inr, invoice_id)
        VALUES (v_store, 'test', 25, 59, v_inv);
      v_results := v_results || 'FAIL a second purchase reused the invoice'::text;
    EXCEPTION WHEN unique_violation THEN
      v_ok := v_ok + 1;
      v_results := v_results || 'PASS one invoice, one purchase'::text;
    END;

    -- 3. NULL does not collide — most purchases predate this column.
    v_ran := v_ran + 1;
    INSERT INTO public.ai_credit_purchases (store_id, pack_id, credits, amount_inr)
      VALUES (v_store, 'test', 25, 59);
    INSERT INTO public.ai_credit_purchases (store_id, pack_id, credits, amount_inr)
      VALUES (v_store, 'test', 25, 59);
    v_ok := v_ok + 1;
    v_results := v_results || 'PASS null invoice_id does not collide'::text;

    RAISE EXCEPTION 'rollback_marker';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM <> 'rollback_marker' THEN
        v_results := v_results || ('FAIL unexpected: ' || SQLERRM)::text;
      END IF;
    WHEN others THEN
      v_results := v_results || ('FAIL unexpected: ' || SQLERRM)::text;
  END;

  RAISE NOTICE '%', array_to_string(v_results, E'\n');
  IF v_ok = 3 AND v_ran = 3 THEN
    RAISE NOTICE 'billing_08: ALL PASSED (3/3)';
  ELSE
    RAISE EXCEPTION 'billing_08: % of % checks passed — see notices above', v_ok, v_ran;
  END IF;
END $$;

-- ───────────────────────── ROLLBACK ─────────────────────────
-- BEGIN;
--   DROP INDEX IF EXISTS public.ai_credit_purchases_invoice_key;
--   ALTER TABLE public.ai_credit_purchases DROP COLUMN IF EXISTS invoice_id;
-- COMMIT;
