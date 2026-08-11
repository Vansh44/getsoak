-- =============================================================
-- Payment attempts, account credits, webhook durability, reconciliation.
-- Design: docs/billing-architecture.md §5
--
-- SERVICE-ROLE ONLY. Apply as `postgres`. Idempotent.
-- =============================================================

-- ── Payment attempts ────────────────────────────────────────────────────────
-- One row per attempt to collect an invoice. Never overwritten: a failed
-- attempt followed by a successful one is two rows, because "why was this
-- merchant charged twice / not charged" is only answerable if both survive.
--
-- ★ This is lib/payments/issue-refund.ts generalised — the only path in the
-- codebase that already handles "we never learned the outcome" correctly.
create table if not exists public.billing_payment_attempts (
  id         uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.billing_invoices(id) on delete cascade,
  store_id   uuid not null references public.stores(id) on delete cascade,

  -- ★★ OURS, minted BEFORE the gateway call, and sent to Razorpay as both the
  -- idempotency header and inside `notes`. You cannot key on a provider id you
  -- do not have yet, and a timeout is indistinguishable from a success you
  -- never read. The `notes` copy is what reconciliation matches on.
  idempotency_key text not null unique,

  mode text not null check (mode in ('automatic','manual')),

  -- ★ MONOTONIC (§4). captured/refunded are terminal, and `failed` is only
  -- reachable from a non-terminal state — so a late payment.failed arriving
  -- after payment.captured is rejected by the state machine itself, with no
  -- timestamps and no argument about whose clock is right.
  --
  -- `unknown` is a first-class state, not an error. It is what a timeout
  -- produces and the only exit is provider verification (Rule 1).
  state text not null default 'created'
          check (state in ('created','processing','authorized','captured',
                           'failed','cancelled','refunded','unknown')),

  amount_paise bigint not null check (amount_paise > 0),
  currency     text not null default 'INR' check (currency = 'INR'),

  -- Which instrument was used. Null for a manual payment on a fresh checkout.
  mandate_id uuid references public.billing_mandates(id) on delete set null,

  provider            text not null default 'razorpay' check (provider = 'razorpay'),
  provider_order_id   text,
  provider_payment_id text,
  provider_token_id   text,

  failure_code   text,
  failure_reason text,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  resolved_at timestamptz
);

-- ★★ THE ANSWER TO SPEC §28 AND §36. Three clicks on Pay, or an automatic
-- retry racing a manual payment, cannot produce two in-flight attempts — the
-- second INSERT fails at the database. Frontend debouncing is a courtesy; this
-- is the guarantee.
create unique index if not exists billing_payment_attempts_one_in_flight
  on public.billing_payment_attempts (invoice_id)
  where state in ('created','processing','authorized');

-- One gateway payment maps to exactly one attempt (spec §47: never trust a
-- Razorpay payment id alone, and never let two of ours claim the same one).
create unique index if not exists billing_payment_attempts_provider_payment_key
  on public.billing_payment_attempts (provider, provider_payment_id)
  where provider_payment_id is not null;

create index if not exists billing_payment_attempts_invoice_idx
  on public.billing_payment_attempts (invoice_id, created_at desc);

-- The reconciliation sweep's scan: anything we never got an answer for.
create index if not exists billing_payment_attempts_unresolved_idx
  on public.billing_payment_attempts (updated_at)
  where state in ('processing','authorized','unknown');

-- A resolved attempt has a resolution time; an unresolved one does not.
alter table public.billing_payment_attempts
  drop constraint if exists billing_payment_attempts_resolved_shape;
alter table public.billing_payment_attempts
  add constraint billing_payment_attempts_resolved_shape
  check (
    (state in ('captured','failed','cancelled','refunded') and resolved_at is not null)
    or (state in ('created','processing','authorized','unknown') and resolved_at is null)
  );

-- ── Account credits ─────────────────────────────────────────────────────────
-- Append-only, mirroring customer_credit_ledger (§29), which already solves
-- this shape. Needed because a payment that lands AFTER a downgrade settles
-- nothing — the invoice is uncollectible — so the money becomes credit against
-- their next subscription rather than a service period they never received.
create table if not exists public.billing_credits (
  id         uuid primary key default gen_random_uuid(),
  store_id   uuid not null references public.stores(id) on delete cascade,
  delta_paise bigint not null check (delta_paise <> 0),
  kind       text not null check (kind in ('late_payment','goodwill','adjustment','applied')),
  -- What caused it. Unique per (kind, ref) so a replayed webhook credits once.
  ref        text,
  note       text,
  invoice_id uuid references public.billing_invoices(id) on delete set null,
  created_by text,
  created_at timestamptz not null default now()
);

create unique index if not exists billing_credits_ref_key
  on public.billing_credits (store_id, kind, ref)
  where ref is not null;

create index if not exists billing_credits_store_idx
  on public.billing_credits (store_id, created_at desc);

-- ── Webhook durability ──────────────────────────────────────────────────────
-- ★ EXTENDS the existing billing_webhook_events (subscriptions_01_schema.sql),
-- which already has `event_id text primary key` — the right idempotency key.
-- Its own file, additively, per the rule that a CREATE TABLE IF NOT EXISTS
-- already applied to an environment must never be edited (subscriptions_02).
--
-- What was missing:
--   payload            — without it an event can be re-RECEIVED but never REPLAYED
--   status/attempts    — so processing can move off the request path
--   signature_verified — evidence, not an assumption
alter table public.billing_webhook_events
  add column if not exists payload jsonb not null default '{}'::jsonb;
alter table public.billing_webhook_events
  add column if not exists signature_verified boolean not null default false;
alter table public.billing_webhook_events
  add column if not exists status text not null default 'received';
alter table public.billing_webhook_events
  add column if not exists attempts integer not null default 0;
alter table public.billing_webhook_events
  add column if not exists last_error text;
alter table public.billing_webhook_events
  add column if not exists processed_at timestamptz;
alter table public.billing_webhook_events
  add column if not exists lease_until timestamptz;

do $$ begin
  alter table public.billing_webhook_events
    add constraint billing_webhook_events_status_check
    check (status in ('received','processed','failed','ignored'));
exception when duplicate_object then null;
end $$;

-- ★ The claim index for the worker — the data_jobs pattern. Processing moves
-- OFF the webhook request, so a slow processor never makes Razorpay see a
-- timeout, and the marker row IS the queue row: a failure just leaves it
-- claimable again, which removes the compensating-delete hazard the old
-- handler had (a swallowed delete failure meant an event marked processed and
-- never applied).
create index if not exists billing_webhook_events_claimable_idx
  on public.billing_webhook_events (received_at)
  where status in ('received','failed');

-- Retention: the old table had a text PK, no timestamp index and no pruning
-- path, so it grew forever. Give the §32 sweep something to use.
create index if not exists billing_webhook_events_received_idx
  on public.billing_webhook_events (received_at);

-- ── Reconciliation ──────────────────────────────────────────────────────────
-- ★ Ambiguity lands here and is never guessed (Rule 10). Every row is a
-- question a human or a verification job must answer.
create table if not exists public.billing_reconciliation_items (
  id       uuid primary key default gen_random_uuid(),
  -- Nullable: an orphan gateway payment may not map to a store yet, which is
  -- precisely why it needs reviewing (spec §46, §47).
  store_id uuid references public.stores(id) on delete set null,
  kind     text not null check (kind in
             ('unknown_payment','orphan_payment','amount_mismatch',
              'missing_webhook','state_conflict','wrong_association','credit_grant_failed')),
  status   text not null default 'open'
             check (status in ('open','resolved','manual_review','ignored')),

  invoice_id uuid references public.billing_invoices(id) on delete set null,
  attempt_id uuid references public.billing_payment_attempts(id) on delete set null,
  provider_payment_id text,
  provider_order_id   text,

  expected_paise bigint,
  observed_paise bigint,

  detail jsonb not null default '{}'::jsonb,

  resolved_by     text,
  resolved_at     timestamptz,
  resolution_note text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- ★ One open item per (kind, provider payment). The detectors are sweeps that
-- re-run continuously, so without this a single unresolved mismatch would
-- create a new row every pass and bury the queue it exists to surface.
create unique index if not exists billing_reconciliation_open_key
  on public.billing_reconciliation_items (kind, provider_payment_id)
  where status = 'open' and provider_payment_id is not null;

create index if not exists billing_reconciliation_open_idx
  on public.billing_reconciliation_items (created_at)
  where status in ('open','manual_review');

-- A resolved item says who resolved it. An open one does not claim to be.
alter table public.billing_reconciliation_items
  drop constraint if exists billing_reconciliation_resolved_shape;
alter table public.billing_reconciliation_items
  add constraint billing_reconciliation_resolved_shape
  check ((status = 'resolved') = (resolved_at is not null));

alter table public.billing_payment_attempts     enable row level security;
alter table public.billing_credits              enable row level security;
alter table public.billing_reconciliation_items enable row level security;
revoke all on public.billing_payment_attempts     from anon, authenticated;
revoke all on public.billing_credits              from anon, authenticated;
revoke all on public.billing_reconciliation_items from anon, authenticated;

-- ───────────────────────── ROLLBACK ─────────────────────────
-- ⚠ FINANCIAL RECORDS. billing_payment_attempts is the only record of what was
-- asked of the gateway and what came back; billing_credits is money owed to
-- merchants. Export before dropping (rule 5).
--
-- The billing_webhook_events columns are additive and safe to drop — the
-- event_id PK that provides dedup predates this file and stays.
--
-- BEGIN;
--   DROP TABLE IF EXISTS public.billing_reconciliation_items;
--   DROP TABLE IF EXISTS public.billing_credits;
--   DROP TABLE IF EXISTS public.billing_payment_attempts;
--   DROP INDEX IF EXISTS public.billing_webhook_events_claimable_idx;
--   DROP INDEX IF EXISTS public.billing_webhook_events_received_idx;
--   ALTER TABLE public.billing_webhook_events
--     DROP CONSTRAINT IF EXISTS billing_webhook_events_status_check,
--     DROP COLUMN IF EXISTS lease_until,
--     DROP COLUMN IF EXISTS processed_at,
--     DROP COLUMN IF EXISTS last_error,
--     DROP COLUMN IF EXISTS attempts,
--     DROP COLUMN IF EXISTS status,
--     DROP COLUMN IF EXISTS signature_verified,
--     DROP COLUMN IF EXISTS payload;
-- COMMIT;
