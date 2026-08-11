-- =============================================================
-- Move existing subscribers from store_subscriptions onto the new system (§34).
--
-- One row in production at the time of writing (`echos`, Pro monthly, cycle to
-- 2026-09-06), so this is a migration rather than a project. Idempotent: safe to
-- re-run, and it never touches a store that already has a billing_subscriptions
-- row.
--
-- ★★ THE MANDATE CANNOT COME WITH THEM. A Razorpay Subscription's mandate is a
-- different product from a recurring token, so there is no authorisation to
-- carry over — `mandate_id` stays NULL and the merchant re-authorises, or pays
-- manually, at their next renewal. That is true whatever we do here, which is
-- why the cutover costs nothing extra on that front.
--
-- ★ NO INVOICE IS CREATED for the cycle they are already in. They paid for it
-- through the old system, and issuing a document for it would burn a number in
-- the gapless GST series for something never sent. The renewal worker creates
-- the NEXT cycle's invoice at T−4d, as it would for anyone.
--
-- ⚠ CANCEL THE GATEWAY SUBSCRIPTION SEPARATELY. This only moves our records.
-- Razorpay will keep charging an `active` subscription on its own schedule, so
-- until it is cancelled at the gateway a migrated store can be billed twice —
-- once by Razorpay's timer and once by our worker. Do that FIRST:
--
--   Razorpay Dashboard → Subscriptions → cancel (at cycle end)
--
-- Run AFTER billing_01..05. Apply as `postgres`.
-- =============================================================

DO $$
DECLARE
  r         record;
  v_moved   int := 0;
  v_skipped int := 0;
BEGIN
  FOR r IN
    SELECT ss.store_id, ss.plan, ss.period, ss.status,
           ss.current_start, ss.current_end, ss.billed_locations,
           st.plan AS store_plan, st.plan_source
      FROM public.store_subscriptions ss
      JOIN public.stores st ON st.id = ss.store_id
     WHERE ss.rzp_subscription_id IS NOT NULL
       -- The states that mean a live subscription (lib/payments/plan-change.ts
       -- LIVE_MANDATE). `created` is deliberately excluded: an abandoned upgrade
       -- modal leaves that behind forever and it never billed anyone.
       AND ss.status IN ('authenticated', 'active', 'pending', 'halted')
  LOOP
    -- Already migrated, or enrolled directly on the new system. Leave alone.
    IF EXISTS (
      SELECT 1 FROM public.billing_subscriptions bs WHERE bs.store_id = r.store_id
    ) THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    -- ★ A cycle is required for any paid state (billing_subscriptions_cycle_present).
    -- Without both timestamps we cannot say what they paid for, and guessing a
    -- period would either bill them early or give away service.
    IF r.current_start IS NULL OR r.current_end IS NULL THEN
      RAISE WARNING 'billing migrate: store % has no cycle on its old subscription — migrate by hand', r.store_id;
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    -- ★ An operator comp is NOT a paid subscription. Moving one across would
    -- turn a grant into a billable obligation, and the renewal worker skips
    -- comped stores precisely so that cannot happen.
    IF r.plan_source = 'comp' THEN
      RAISE WARNING 'billing migrate: store % is on an operator comp — not migrating', r.store_id;
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    INSERT INTO public.billing_accounts (store_id)
      VALUES (r.store_id)
      ON CONFLICT (store_id) DO NOTHING;

    INSERT INTO public.billing_subscriptions (
      store_id, plan, period, state,
      current_cycle_seq, current_period_start, current_period_end,
      billed_locations, plan_source, mandate_id
    ) VALUES (
      r.store_id,
      r.plan,
      CASE WHEN r.period = 'yearly' THEN 'yearly' ELSE 'monthly' END,
      -- `active`: they have paid for the cycle they are in. The worker picks
      -- them up at T−4d before it ends, like any other subscriber.
      'active',
      1,
      r.current_start,
      r.current_end,
      COALESCE(r.billed_locations, 0),
      'paid',
      NULL          -- see the mandate note above
    );

    -- The audit trail records the move. `source` is billing|operator|system —
    -- NEVER 'paid', which belongs to stores.plan_source and is rejected by the
    -- CHECK (the incident in CODEBASE.md §15).
    INSERT INTO public.plan_events (store_id, from_plan, to_plan, source, actor, note)
      VALUES (r.store_id, r.store_plan, r.plan, 'system', 'billing-migration',
              'migrated from store_subscriptions to billing_subscriptions');

    v_moved := v_moved + 1;
  END LOOP;

  RAISE NOTICE 'billing migrate: % moved, % skipped', v_moved, v_skipped;
END $$;

-- What moved, for eyeballing afterwards.
SELECT s.slug,
       bs.plan,
       bs.period,
       bs.state,
       bs.current_period_end,
       bs.mandate_id IS NULL AS needs_reauthorisation
  FROM public.billing_subscriptions bs
  JOIN public.stores s ON s.id = bs.store_id
 ORDER BY s.slug;

-- ───────────────────────── ROLLBACK ─────────────────────────
-- Only safe while the new system has issued NO invoice for these stores. Once it
-- has, deleting the subscription orphans a real financial document.
--
-- BEGIN;
--   DELETE FROM public.billing_subscriptions bs
--    WHERE NOT EXISTS (SELECT 1 FROM public.billing_invoices i WHERE i.store_id = bs.store_id);
-- COMMIT;
