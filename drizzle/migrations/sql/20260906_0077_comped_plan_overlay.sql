-- Comped plans as an ENTITLEMENT OVERLAY, never a billing operation.
-- Full design and the decisions behind it: docs/comped-plans-spec.md.
--
-- ★★ WHY THIS IS FIVE NEW COLUMNS AND NOT A CHANGE TO THE THREE THAT EXIST.
-- `stores.plan_expires_at` is ALREADY overloaded: for an operator comp it means
-- "the grant ends here", and for a paid subscription it means "the current
-- cycle ends here" (lib/billing/enrol.ts sets `planExpiresAt: cycle.end` on
-- every activation, and each renewal pushes it out). One column, two meanings.
-- So writing a comp into it destroys the paid meaning, and the store lands on
-- FREE when the comp lapses even though its subscription is live and paid —
-- `/api/cron/plan-expiry` writes `plan = 'free', plan_expires_at = null` for any
-- expired non-free plan without ever consulting billing_subscriptions.
--
-- Keeping the comp in its own columns makes expiry FREE: there is nothing to
-- revert, because the paid entitlement underneath was never touched. That
-- property is the whole reason for the design.
--
-- ★ GRANT AND WINDOW ARE SEPARATE, and that is what earns the merchant's click a
-- place in the flow. The operator sets `comp_plan` + `comp_duration_days` (the
-- DURATION); accepting sets `comp_starts_at`/`comp_expires_at` (the WINDOW), so
-- a free month counts from the day it is taken up rather than burning down
-- unseen from the day it was granted.
--
-- ★ NO `comp_note` OR `comp_granted_by` COLUMN HERE, deliberately. The
-- "Read stores" RLS policy grants SELECT on this table to `public`, so anything
-- added is world-readable — the same rule that keeps secrets out of
-- `stores.settings` (CODEBASE.md convention #9). Which plan a store is on is
-- already public; who comped it and why is not, and that belongs in
-- `plan_events`, which exists, is service-role only and already carries `actor`
-- and `note`. ⚠ Its `source` vocabulary is 'operator' | 'billing' | 'system' —
-- NOT the 'comp' | 'paid' | 'trial' of stores.plan_source. A comp grant audits
-- as `source = 'operator'`; writing 'comp' is rejected by that CHECK and, in a
-- shared transaction, would roll the grant back (CODEBASE.md §15).
--
-- ★ PURELY ADDITIVE. No backfill of existing comps and no drop of the dead
-- `billing_subscriptions.plan_expires_at` column: the first changes what a live
-- merchant may do and is reviewed by hand, the second is independently
-- reversible and should not have to be undone to roll this back.
ALTER TABLE public.stores
  ADD COLUMN IF NOT EXISTS comp_plan          text,
  ADD COLUMN IF NOT EXISTS comp_duration_days integer,
  ADD COLUMN IF NOT EXISTS comp_offered_at    timestamptz,
  ADD COLUMN IF NOT EXISTS comp_starts_at     timestamptz,
  ADD COLUMN IF NOT EXISTS comp_expires_at    timestamptz;

-- 'free' is deliberately absent: comping a store onto Free is not a gift, and
-- the resolver ranks it below every paid plan anyway, so it could only ever be
-- a typo that looks like an intent.
ALTER TABLE public.stores
  DROP CONSTRAINT IF EXISTS stores_comp_plan_check,
  ADD CONSTRAINT stores_comp_plan_check
    CHECK (comp_plan IS NULL OR comp_plan IN ('basic', 'pro'));

ALTER TABLE public.stores
  DROP CONSTRAINT IF EXISTS stores_comp_duration_check,
  ADD CONSTRAINT stores_comp_duration_check
    CHECK (comp_duration_days IS NULL OR comp_duration_days BETWEEN 1 AND 365);

-- ★★ THE WINDOW IS ALL-OR-NOTHING. A half-written window is the one state the
-- resolver cannot read safely: `comp_expires_at` with no `comp_plan` would
-- expire something that was never granted, and `comp_starts_at` with no
-- `comp_expires_at` would be an entitlement with no end. The activation write
-- sets both in one statement, so the only way to reach a half state is a direct
-- edit — which is exactly what a constraint is for.
ALTER TABLE public.stores
  DROP CONSTRAINT IF EXISTS stores_comp_window_complete,
  ADD CONSTRAINT stores_comp_window_complete CHECK (
    (comp_starts_at IS NULL AND comp_expires_at IS NULL)
    OR (
      comp_plan IS NOT NULL
      AND comp_starts_at IS NOT NULL
      AND comp_expires_at IS NOT NULL
      AND comp_expires_at > comp_starts_at
    )
  );

-- Partial, mirroring stores_plan_expiry_idx: the expiry sweep only ever asks
-- about rows that have a window, and comps are a small minority of stores.
CREATE INDEX IF NOT EXISTS stores_comp_expiry_idx
  ON public.stores (comp_expires_at)
  WHERE comp_expires_at IS NOT NULL;
