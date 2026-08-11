-- =============================================================
-- Billing subscriptions — the 30-day cycle, grace and downgrade state.
-- Design: docs/billing-architecture.md §3, §4, §7
--
-- Replaces `store_subscriptions`, which modelled RAZORPAY's subscription
-- (its status vocabulary, its plan id, its cycle). This models OURS: what the
-- merchant is entitled to, for which 30-day window, and where the money is.
-- The old table is left in place until the cutover; nothing here reads it.
--
-- SERVICE-ROLE ONLY. Apply as `postgres`. Idempotent.
-- =============================================================

create table if not exists public.billing_subscriptions (
  store_id       uuid primary key references public.stores(id) on delete cascade,
  plan           text not null check (plan in ('free','basic','pro')),
  period         text not null default 'monthly' check (period in ('monthly','yearly')),

  -- ★ OUR state machine, not Razorpay's (§4).
  --   free              nothing owed
  --   active            paid, inside a cycle
  --   past_due          a debit is KNOWN to have failed; grace has started
  --   grace             synonym-free alias of past_due's tail; see note below
  --   downgraded        grace expired unpaid; entitlement is free
  --   cancelled         merchant asked to stop; runs to current_period_end
  state          text not null default 'free'
                   check (state in ('free','active','past_due','grace','downgraded','cancelled')),

  -- ── The cycle ──
  -- ★ A DURATION, never a calendar month. period_end = period_start + 30 days
  -- (or 365 for yearly). Computed in lib/billing/cycle.ts and stored, so the
  -- boundary is a fact rather than something each reader re-derives.
  current_cycle_seq   integer not null default 0 check (current_cycle_seq >= 0),
  current_period_start timestamptz,
  current_period_end   timestamptz,

  -- Extra POS locations this subscription pays for, ON TOP OF the plan's
  -- included count. Additive, never a total (see lib/plans/location-billing.ts).
  billed_locations integer not null default 0
                     check (billed_locations >= 0 and billed_locations <= 50),

  -- Applied at the next cycle boundary. A downgrade or a period switch waits
  -- for the cycle the merchant already paid for (§7) — which is what keeps
  -- refunds out of this system entirely.
  scheduled_plan   text check (scheduled_plan is null or scheduled_plan in ('free','basic','pro')),
  scheduled_period text check (scheduled_period is null or scheduled_period in ('monthly','yearly')),
  scheduled_locations integer check (scheduled_locations is null or
                                     (scheduled_locations >= 0 and scheduled_locations <= 50)),
  cancel_at_period_end boolean not null default false,

  -- ── Grace ──
  -- ★ grace_started_at is set when a payment is KNOWN TO HAVE FAILED — never on
  -- invoice creation (spec §68) and NEVER on an `unknown` outcome (Rule 6). A
  -- provider timeout means we do not know whether money moved; starting a
  -- downgrade clock on that is the worst thing this system could do.
  grace_started_at timestamptz,
  grace_ends_at    timestamptz,
  downgraded_at    timestamptz,

  mandate_id  uuid references public.billing_mandates(id) on delete set null,

  -- ── Operator grants (preserved from the old model, deliberately) ──
  -- A comped store has NO mandate and NO invoice. The renewal worker must skip
  -- it and the downgrade claim must exclude it, or an operator's grant is
  -- revoked by a billing job that was never given anything to collect.
  plan_source     text not null default 'comp' check (plan_source in ('comp','paid','trial')),
  plan_expires_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ★ Grace timestamps travel together or not at all. A row with a start and no
-- end can never expire; one with an end and no start has no auditable origin.
alter table public.billing_subscriptions
  drop constraint if exists billing_subscriptions_grace_pair;
alter table public.billing_subscriptions
  add constraint billing_subscriptions_grace_pair
  check ((grace_started_at is null) = (grace_ends_at is null));

-- ★ A paid state must have a cycle. `active`/`past_due`/`grace` without one is
-- an impossible state (spec §65) — nothing could decide when to renew it.
alter table public.billing_subscriptions
  drop constraint if exists billing_subscriptions_cycle_present;
alter table public.billing_subscriptions
  add constraint billing_subscriptions_cycle_present
  check (
    state not in ('active','past_due','grace')
    or (current_period_start is not null and current_period_end is not null)
  );

-- A cycle cannot end before it starts.
alter table public.billing_subscriptions
  drop constraint if exists billing_subscriptions_cycle_order;
alter table public.billing_subscriptions
  add constraint billing_subscriptions_cycle_order
  check (current_period_end is null or current_period_start is null
         or current_period_end > current_period_start);

-- The renewal worker's scan: whose cycle is close enough to collect for?
-- Partial, because free and downgraded stores are never candidates.
create index if not exists billing_subscriptions_renewal_idx
  on public.billing_subscriptions (current_period_start)
  where state in ('active','past_due','grace');

-- The downgrade worker's scan.
create index if not exists billing_subscriptions_grace_idx
  on public.billing_subscriptions (grace_ends_at)
  where state in ('past_due','grace');

alter table public.billing_subscriptions enable row level security;
revoke all on public.billing_subscriptions from anon, authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- The downgrade claim.
--
-- ★★ ONE STATEMENT, and that is the entire concurrency story. It re-checks the
-- state, the deadline, the comp exemption AND whether the invoice was paid,
-- inside the UPDATE that performs the change — so spec §11 (payment racing
-- downgrade), §37 (payment at the boundary) and §39 (job runs twice) all
-- resolve without a lock, a second query, or a read-then-write window. It is
-- the increment_coupon_usage pattern.
--
-- Zero rows returned means one of: already downgraded, they paid, they are
-- comped, or the deadline has not passed. All four are correct no-ops.
--
-- NOTE this deliberately does NOT force-close an open POS shift — that is done
-- by the caller in the SAME transaction (owner decision, 2026-08-11), because
-- shift closure needs the expected-cash figure that lib/pos/shifts.ts computes.
-- ───────────────────────────────────────────────────────────────────────────
create or replace function public.billing_claim_downgrade(
  p_store uuid,
  p_now   timestamptz default now()
)
returns boolean language plpgsql security definer set search_path = '' as $$
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
     -- An operator grant is not a billing obligation.
     and s.plan_source <> 'comp'
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
end; $$;

grant execute on function public.billing_claim_downgrade(uuid, timestamptz) to service_role;

-- ───────────────────────── ROLLBACK ─────────────────────────
-- ⚠ Do NOT drop this once it is the live entitlement source: `stores.plan` is
-- what every gate reads, and dropping the subscription that justifies it leaves
-- paid stores with no renewal path and no expiry. Migrate entitlement back to
-- store_subscriptions FIRST.
--
-- BEGIN;
--   DROP FUNCTION IF EXISTS public.billing_claim_downgrade(uuid, timestamptz);
--   DROP TABLE IF EXISTS public.billing_subscriptions;
-- COMMIT;
