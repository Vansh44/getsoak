-- =============================================================
-- Billing foundation — platform tax config, per-store billing identity,
-- and payment mandates.  Design: docs/billing-architecture.md
--
--   platform_billing_settings  singleton. StoreMink's OWN tax identity, edited
--                              by an operator. Tax is OFF until a GSTIN exists.
--   billing_accounts           one per store: who the invoice is addressed to.
--   billing_mandates           an authorised payment instrument (token), and
--                              the ceiling it was authorised for.
--
-- All three are SERVICE-ROLE ONLY (the plan_events / ai_credits pattern).
-- Financial records are never client-writable, and billing_accounts carries a
-- merchant's legal name, address and GSTIN.
--
-- ⚠ `stores.settings` is ANON-READABLE (multitenant_03_rls.sql grants SELECT on
-- every active store to anon). None of this may ever move there.
--
-- Apply as `postgres`. Idempotent: safe to re-run.
-- =============================================================

-- ── Platform tax identity ───────────────────────────────────────────────────
-- One row, enforced by a boolean primary key with a CHECK — the cheapest
-- singleton in Postgres and it cannot be defeated by a second insert.
--
-- ★ tax_enabled defaults FALSE. There is no platform GSTIN yet (owner,
-- 2026-08-11), so invoices must render correctly with no tax and no GSTIN
-- block. Turning it on is NEVER retroactive: invoices are immutable once
-- finalized (billing_03), so an April invoice cannot sprout GST in September.
create table if not exists public.platform_billing_settings (
  id             boolean primary key default true check (id),
  legal_name     text,
  gstin          text,
  address        jsonb not null default '{}'::jsonb,
  -- Place-of-supply ORIGIN. Compared against the merchant's state to decide
  -- CGST+SGST (intra) vs IGST (inter) — lib/billing/gst.ts.
  state_code     text,
  tax_enabled    boolean not null default false,
  -- Basis points, so 18% is 1800 and no float ever touches a tax rate.
  tax_rate_bps   integer not null default 1800
                   check (tax_rate_bps >= 0 and tax_rate_bps <= 10000),
  invoice_prefix text not null default 'SM' check (invoice_prefix <> ''),
  updated_at     timestamptz not null default now(),
  updated_by     text
);

-- ★ Refuse to enable tax without a GSTIN. An invoice charging GST while naming
-- no GSTIN is not a valid tax invoice, and the merchant cannot claim input tax
-- credit against it — so this is a data-integrity rule, not a UI nicety.
alter table public.platform_billing_settings
  drop constraint if exists platform_billing_tax_needs_gstin;
alter table public.platform_billing_settings
  add constraint platform_billing_tax_needs_gstin
  check (tax_enabled = false or (gstin is not null and gstin <> ''));

-- ★★ STATE CODES ARE NUMERIC GST CODES ("07" Delhi, "29" Karnataka), never
-- two-letter abbreviations. lib/billing/gst.ts `normalizeStateCode` rejects
-- anything non-numeric, and `isIntraState` then falls back to INTRA-state — a
-- sensible default for a POS walk-in, and the WRONG one here: StoreMink sits in
-- one state while merchants are nationwide, so inter-state is the common case.
-- An operator typing "DL" would silently charge CGST+SGST instead of IGST on
-- every invoice: the wrong tax, filed wrongly, with no error anywhere. So the
-- format is enforced by the database rather than trusted to a text input.
alter table public.platform_billing_settings
  drop constraint if exists platform_billing_state_code_numeric;
alter table public.platform_billing_settings
  add constraint platform_billing_state_code_numeric
  check (state_code is null or state_code ~ '^[0-9]{2}$');

insert into public.platform_billing_settings (id) values (true)
  on conflict (id) do nothing;

-- ── Per-store billing identity ──────────────────────────────────────────────
-- Separate from `stores` because it is the BILL-TO party and must not be
-- anon-readable, and separate from the subscription because it outlives one:
-- a store that cancels and re-subscribes keeps its billing identity.
create table if not exists public.billing_accounts (
  store_id      uuid primary key references public.stores(id) on delete cascade,
  billing_email text,
  legal_name    text,
  address       jsonb not null default '{}'::jsonb,
  -- The MERCHANT's GSTIN. Printed on their invoice so they can claim ITC.
  gstin         text,
  state_code    text,
  -- INR only today. Present so a second currency is a migration, not a rewrite.
  currency      text not null default 'INR' check (currency = 'INR'),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Same numeric-GST-code rule as the platform side, and for the same reason:
-- this is the PLACE OF SUPPLY, so a malformed value picks the wrong tax head.
alter table public.billing_accounts
  drop constraint if exists billing_accounts_state_code_numeric;
alter table public.billing_accounts
  add constraint billing_accounts_state_code_numeric
  check (state_code is null or state_code ~ '^[0-9]{2}$');

-- ── Mandates ────────────────────────────────────────────────────────────────
-- An authorised payment instrument. One row per authorisation attempt, so the
-- history of a merchant's instruments is preserved rather than overwritten —
-- a revoked mandate is evidence, and reconciliation may need to read it.
--
-- ⚠ NO CARD DATA. Ever. The provider token is the only thing stored, and it is
-- useless without our API keys.
create table if not exists public.billing_mandates (
  id                   uuid primary key default gen_random_uuid(),
  store_id             uuid not null references public.stores(id) on delete cascade,
  provider             text not null default 'razorpay' check (provider = 'razorpay'),
  provider_customer_id text,
  -- Razorpay's token id. Unique per provider: one token is one mandate.
  provider_token_id    text,
  method               text not null default 'unknown'
                         check (method in ('card','upi','emandate','nach','unknown')),
  -- ★ `unknown` triggers VERIFICATION, never an assumption (spec §17). A fresh
  -- authorisation is `pending` until the token reports confirmed.
  status               text not null default 'pending'
                         check (status in ('pending','active','expired','revoked','failed','unknown')),
  -- ★ Read back from the token, NOT computed by us. The superseded
  -- mandateMaxPaise() invented a global ₹2,00,000 ceiling from the top plan;
  -- what matters is what this merchant actually authorised.
  max_amount_paise     bigint check (max_amount_paise is null or max_amount_paise > 0),
  authenticated_at     timestamptz,
  expires_at           timestamptz,
  revoked_at           timestamptz,
  -- Provider fields needed for reconciliation only. Never credentials.
  provider_metadata    jsonb not null default '{}'::jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- One provider token is one mandate row. Partial, because a token id does not
-- exist until the authorisation succeeds.
create unique index if not exists billing_mandates_token_key
  on public.billing_mandates (provider, provider_token_id)
  where provider_token_id is not null;

-- ★ At most ONE active mandate per store. Two active mandates means two
-- instruments that could each be debited for the same invoice, and nothing in
-- the collection path would know which. Enforced here rather than in code
-- (invariant 3: exactly-once is a constraint, not a check-then-act).
create unique index if not exists billing_mandates_one_active
  on public.billing_mandates (store_id)
  where status = 'active';

create index if not exists billing_mandates_store_idx
  on public.billing_mandates (store_id, created_at desc);

-- ── RLS: service-role only ──────────────────────────────────────────────────
alter table public.platform_billing_settings enable row level security;
alter table public.billing_accounts          enable row level security;
alter table public.billing_mandates          enable row level security;

revoke all on public.platform_billing_settings from anon, authenticated;
revoke all on public.billing_accounts          from anon, authenticated;
revoke all on public.billing_mandates          from anon, authenticated;

-- ───────────────────────── ROLLBACK ─────────────────────────
-- Safe: nothing here has been applied to any environment yet, and no money has
-- moved through it. Dropping billing_mandates orphans no gateway state — the
-- tokens continue to exist at Razorpay and must be revoked there separately if
-- that is the intent.
--
-- BEGIN;
--   DROP TABLE IF EXISTS public.billing_mandates;
--   DROP TABLE IF EXISTS public.billing_accounts;
--   DROP TABLE IF EXISTS public.platform_billing_settings;
-- COMMIT;
