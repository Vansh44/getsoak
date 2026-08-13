-- =============================================================
-- §34 — a THIRD invoice kind: `addon`.
--
-- Buying an extra location mid-cycle owes a part-period amount. On the old
-- system Razorpay computed it (`rzpUpdateSubscription` with
-- `schedule_change_at: now`) — which is exactly the call that does not work on a
-- UPI or e-mandate mandate, and the reason this rebuild exists. StoreMink now
-- computes it, so it needs a document to put it on.
--
-- ★ WHY NOT ON THE SUBSCRIPTION INVOICE. A renewal invoice is issued at T−4d for
-- one cycle and is idempotent on `(store_id, kind, cycle_seq)`. A mid-cycle
-- purchase happens at an arbitrary moment, can happen several times in one
-- cycle, and is paid ON SESSION while the merchant is watching. Folding it into
-- the renewal document would mean either editing a finalized invoice (the
-- immutability trigger forbids it, correctly) or deferring the charge to the next
-- renewal — which for a YEARLY merchant is a ₹9,000 surprise eleven months
-- later.
--
-- ★ WHY NO INDEX CHANGE IS NEEDED. `billing_invoices_one_per_cycle` is already
-- partial (`where cycle_seq is not null`), so an addon — which carries no
-- cycle_seq, like `ai_credits` — is outside it. Several addons per cycle are
-- therefore allowed, which is the point: a merchant may add a shop in January
-- and another in February.
--
-- ★ `billing_invoice_items.kind` ALREADY permits 'addon' and 'proration', so the
-- line items need nothing.
--
-- ⚠ Its OWN file, per the §15b rule: `billing_03` has been applied to staging and
-- production, and editing an applied `create table if not exists` is a silent
-- no-op. The constraints below are re-created rather than edited in place, and
-- the new column is `add column if not exists`.
--
-- Run AFTER billing_01..06. Apply as `postgres`.
-- =============================================================

-- ── 1. Allow the kind ───────────────────────────────────────────────────────
alter table public.billing_invoices
  drop constraint if exists billing_invoices_kind_check;
alter table public.billing_invoices
  add constraint billing_invoices_kind_check
  check (kind in ('subscription', 'ai_credits', 'addon'));

-- ── 2. Say what shape it has ────────────────────────────────────────────────
-- A subscription invoice covers a cycle. A credit purchase and an addon do not:
-- both are one-off documents, dated to the day they were paid.
alter table public.billing_invoices
  drop constraint if exists billing_invoices_kind_shape;
alter table public.billing_invoices
  add constraint billing_invoices_kind_shape
  check (
    (kind = 'subscription' and cycle_seq is not null)
    or (kind in ('ai_credits', 'addon') and cycle_seq is null)
  );

-- ── 3. What the addon BUYS ──────────────────────────────────────────────────
-- ★★ THE GRANTED COUNT LIVES ON THE INVOICE, NOT IN THE REQUEST. `confirm` is a
-- public server action, so a client could otherwise report a different number
-- from the one the price was computed for and be granted locations it never paid
-- for. Writing the target when the invoice is created means confirm reads what
-- was PAID FOR, and the client cannot influence it.
--
-- Nullable: only addon invoices have one, and the CHECK below ties the two
-- together so a subscription or credit invoice cannot carry a stray count.
alter table public.billing_invoices
  add column if not exists addon_target_count integer;

alter table public.billing_invoices
  drop constraint if exists billing_invoices_addon_target_shape;
alter table public.billing_invoices
  add constraint billing_invoices_addon_target_shape
  check (
    addon_target_count is null
    or (kind = 'addon' and addon_target_count >= 0 and addon_target_count <= 50)
  );

-- ── 4. Verify, without leaving anything behind ───────────────────────────────
-- The mutations run in a plpgsql subtransaction that is rolled back, so no row
-- persists and no invoice number is burned. Results survive in a variable,
-- because that is memory rather than transactional state (the billing_verify.sql
-- pattern).
DO $$
DECLARE
  v_store   uuid;
  v_results text[] := '{}';
  v_ok      int := 0;
  v_ran     int := 0;
BEGIN
  SELECT id INTO v_store FROM public.stores LIMIT 1;
  IF v_store IS NULL THEN
    RAISE NOTICE 'billing_07: no stores to test against — constraints applied, checks skipped';
    RETURN;
  END IF;

  -- 4a. An addon with NO cycle_seq is accepted.
  BEGIN
    v_ran := v_ran + 1;
    INSERT INTO public.billing_invoices (store_id, kind, cycle_seq)
      VALUES (v_store, 'addon', NULL);
    v_ok := v_ok + 1;
    v_results := v_results || 'PASS addon with null cycle_seq accepted'::text;
    RAISE EXCEPTION 'rollback_marker';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM <> 'rollback_marker' THEN
        v_results := v_results || ('FAIL addon rejected: ' || SQLERRM)::text;
      END IF;
    WHEN others THEN
      v_results := v_results || ('FAIL addon rejected: ' || SQLERRM)::text;
  END;

  -- 4b. An addon WITH a cycle_seq is refused — it is not a periodic document.
  BEGIN
    v_ran := v_ran + 1;
    INSERT INTO public.billing_invoices (store_id, kind, cycle_seq)
      VALUES (v_store, 'addon', 7);
    v_results := v_results || 'FAIL addon with cycle_seq was ACCEPTED'::text;
    RAISE EXCEPTION 'rollback_marker';
  EXCEPTION
    WHEN check_violation THEN
      v_ok := v_ok + 1;
      v_results := v_results || 'PASS addon with cycle_seq refused'::text;
    WHEN raise_exception THEN
      IF SQLERRM <> 'rollback_marker' THEN
        v_results := v_results || ('FAIL unexpected: ' || SQLERRM)::text;
      END IF;
    WHEN others THEN
      v_results := v_results || ('FAIL unexpected: ' || SQLERRM)::text;
  END;

  -- 4c. An unknown kind is still refused.
  BEGIN
    v_ran := v_ran + 1;
    INSERT INTO public.billing_invoices (store_id, kind, cycle_seq)
      VALUES (v_store, 'not_a_kind', NULL);
    v_results := v_results || 'FAIL unknown kind was ACCEPTED'::text;
    RAISE EXCEPTION 'rollback_marker';
  EXCEPTION
    WHEN check_violation THEN
      v_ok := v_ok + 1;
      v_results := v_results || 'PASS unknown kind refused'::text;
    WHEN raise_exception THEN
      IF SQLERRM <> 'rollback_marker' THEN
        v_results := v_results || ('FAIL unexpected: ' || SQLERRM)::text;
      END IF;
    WHEN others THEN
      v_results := v_results || ('FAIL unexpected: ' || SQLERRM)::text;
  END;

  -- 4d. A target count on a NON-addon invoice is refused.
  BEGIN
    v_ran := v_ran + 1;
    INSERT INTO public.billing_invoices (store_id, kind, cycle_seq, addon_target_count)
      VALUES (v_store, 'ai_credits', NULL, 3);
    v_results := v_results || 'FAIL target count on ai_credits was ACCEPTED'::text;
    RAISE EXCEPTION 'rollback_marker';
  EXCEPTION
    WHEN check_violation THEN
      v_ok := v_ok + 1;
      v_results := v_results || 'PASS target count only on addon'::text;
    WHEN raise_exception THEN
      IF SQLERRM <> 'rollback_marker' THEN
        v_results := v_results || ('FAIL unexpected: ' || SQLERRM)::text;
      END IF;
    WHEN others THEN
      v_results := v_results || ('FAIL unexpected: ' || SQLERRM)::text;
  END;

  RAISE NOTICE '%', array_to_string(v_results, E'\n');
  -- ★ Asserts all four RAN, so a half-dead run cannot render as green.
  IF v_ok = 4 AND v_ran = 4 THEN
    RAISE NOTICE 'billing_07: ALL PASSED (4/4)';
  ELSE
    RAISE EXCEPTION 'billing_07: % of % checks passed — see notices above', v_ok, v_ran;
  END IF;
END $$;

-- ───────────────────────── ROLLBACK ─────────────────────────
-- Only safe while no addon invoice exists; the narrowed CHECK would reject them.
--
-- BEGIN;
--   DELETE FROM public.billing_invoices WHERE kind = 'addon';
--   ALTER TABLE public.billing_invoices
--     DROP CONSTRAINT IF EXISTS billing_invoices_kind_check;
--   ALTER TABLE public.billing_invoices
--     ADD CONSTRAINT billing_invoices_kind_check
--     CHECK (kind in ('subscription','ai_credits'));
--   ALTER TABLE public.billing_invoices
--     DROP CONSTRAINT IF EXISTS billing_invoices_addon_target_shape;
--   ALTER TABLE public.billing_invoices DROP COLUMN IF EXISTS addon_target_count;
--   ALTER TABLE public.billing_invoices
--     DROP CONSTRAINT IF EXISTS billing_invoices_kind_shape;
--   ALTER TABLE public.billing_invoices
--     ADD CONSTRAINT billing_invoices_kind_shape
--     CHECK ((kind = 'subscription' and cycle_seq is not null)
--        or  (kind = 'ai_credits'   and cycle_seq is null));
-- COMMIT;
