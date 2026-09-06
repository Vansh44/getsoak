-- Stop treating a subscription's own `plan_source = 'comp'` as "do not bill".
-- Rationale: docs/comped-plans-spec.md §7.
--
-- ★★ THE EXEMPTION IS OBSOLETE, NOT MERELY REDUNDANT. It exists because the old
-- design conflated two facts in one word. Now that a comp is an entitlement
-- OVERLAY (migration 0077), holding a free upgrade never implies the merchant
-- has stopped paying for their own plan — the subscription underneath is real
-- and must still be collected, or a comp becomes a silent payment holiday.
--
-- ★★ AND KEEPING IT IS A LATENT BUG, which is the stronger argument.
-- `billing_subscriptions.plan_source` DEFAULTS to 'comp' (billing_02 line 65).
-- `enrol.ts` only writes 'paid' at ACTIVATION, so any row whose activation never
-- completed keeps the default — and this predicate then makes it permanently
-- immune to downgrade. A merchant who half-enrolled would never be invoiced,
-- never chased and never moved off the plan, with nothing reporting it.
--
-- ★ ALL FOUR SITES MOVE TOGETHER. The other three are Drizzle predicates in
-- lib/billing/renewal-worker.ts (claimDue, evaluateCycleTurns, and the downgrade
-- candidate query). Removing only those would be worse than removing none: a
-- comped subscription would be invoiced, chased through grace, selected for
-- downgrade — and then silently refused HERE, at the atomic claim.
--
-- ⚠ VERIFIED INERT BEFORE WRITING THIS. No subscription in either database has
-- `plan_source = 'comp'` (checked 2026-09-06, production and staging), so this
-- changes no merchant's billing today. It removes a trap, not a behaviour.
--
-- Everything else about the claim is byte-identical to the live definition,
-- including the SECURITY DEFINER, the empty search_path, the strict `<` on the
-- deadline and the paid/processing invoice check.
CREATE OR REPLACE FUNCTION public.billing_claim_downgrade(
  p_store uuid,
  p_now timestamp with time zone DEFAULT now()
)
  RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
AS $function$
declare v_store uuid;
begin
  update public.billing_subscriptions s
     set state            = 'downgraded',
         plan             = 'free',
         billed_locations = 0,
         scheduled_plan   = null,
         scheduled_period = null,
         scheduled_locations = null,
         grace_started_at = null,
         grace_ends_at    = null,
         downgraded_at    = p_now,
         updated_at       = p_now
   where s.store_id = p_store
     and s.state in ('past_due','grace')
     and s.grace_ends_at is not null
     -- Strictly past the deadline: at exactly grace_ends_at the merchant still
     -- has the full 48 hours they were promised (lib/billing/cycle.ts).
     and s.grace_ends_at < p_now
     -- ★ The comp exemption that used to sit here is GONE. A comped plan is an
     -- overlay resolved at read time and never a reason to skip collection.
     -- ★ The payment check. Anything settled for the current cycle wins.
     and not exists (
       select 1 from public.billing_invoices i
        where i.store_id = s.store_id
          and i.kind = 'subscription'
          and i.cycle_seq = s.current_cycle_seq
          and i.status in ('paid','processing')
     )
  returning s.store_id into v_store;

  return v_store is not null;
end; $function$;
