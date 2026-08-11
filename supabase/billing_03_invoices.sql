-- =============================================================
-- Invoices — the payment obligation, its line items, and a gapless GST
-- document series.  Design: docs/billing-architecture.md §5, §6
--
-- ⚠ APPLY ORDER: this file must be applied BEFORE calling
-- billing_claim_downgrade() from billing_02 — that function reads
-- billing_invoices. plpgsql resolves table names at call time, not at CREATE
-- time, so applying billing_02 first succeeds and then fails at runtime.
--
-- Depends on public.sm_pad() (identifiers_05_no_truncate.sql).
--
-- SERVICE-ROLE ONLY. Apply as `postgres`. Idempotent.
-- =============================================================

-- ── The document series ─────────────────────────────────────────────────────
-- ★ Platform-level, NOT store_counters. StoreMink is the supplier on these
-- invoices, not the merchant, so one series covers the whole platform.
--
-- ★ Per FINANCIAL YEAR, because that is the unit GST requires to be gapless and
-- consecutive. India's FY runs 1 April – 31 March, and the boundary is computed
-- in IST — the filing timezone — not in UTC, or an invoice raised at 04:00 IST
-- on 1 April would be filed in the wrong year.
create table if not exists public.billing_invoice_counters (
  fy_label text primary key,
  next_seq integer not null default 1 check (next_seq >= 1)
);

alter table public.billing_invoice_counters enable row level security;
revoke all on public.billing_invoice_counters from anon, authenticated;

-- '2026-27' for any instant between 1 Apr 2026 and 31 Mar 2027, IST.
create or replace function public.billing_fy_label(p_ts timestamptz)
returns text language sql immutable set search_path = '' as $$
  select case
    when extract(month from (p_ts at time zone 'Asia/Kolkata')) >= 4
      then to_char((p_ts at time zone 'Asia/Kolkata'), 'YYYY') || '-' ||
           to_char(((p_ts at time zone 'Asia/Kolkata') + interval '1 year'), 'YY')
    else to_char(((p_ts at time zone 'Asia/Kolkata') - interval '1 year'), 'YYYY') || '-' ||
         to_char((p_ts at time zone 'Asia/Kolkata'), 'YY')
  end;
$$;

-- Allocate the next number in a financial year. Single UPDATE … RETURNING —
-- the next_order_no / next_credit_note_no pattern, so two concurrent
-- finalizations can never take the same number.
create or replace function public.billing_next_invoice_no(p_fy text)
returns integer language plpgsql security definer set search_path = '' as $$
declare v integer;
begin
  insert into public.billing_invoice_counters (fy_label) values (p_fy)
    on conflict (fy_label) do nothing;
  update public.billing_invoice_counters
     set next_seq = next_seq + 1
   where fy_label = p_fy
  returning next_seq - 1 into v;
  return v;
end; $$;

grant execute on function public.billing_next_invoice_no(text) to service_role;

-- ── Invoices ────────────────────────────────────────────────────────────────
create table if not exists public.billing_invoices (
  id       uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,

  -- ★ Subscription and AI-credit invoices share this table so they share the
  -- payment machinery, the numbering series and the audit trail — but they are
  -- NEVER the same document. A credit purchase must not appear on a
  -- subscription invoice (spec §1) and `cycle_seq` stays null for it.
  kind     text not null check (kind in ('subscription','ai_credits')),

  status   text not null default 'draft'
             check (status in ('draft','open','processing','paid',
                               'uncollectible','void','refunded','partially_refunded')),

  -- ── Money. Integer paise, always. ──
  subtotal_paise bigint not null default 0 check (subtotal_paise >= 0),
  discount_paise bigint not null default 0 check (discount_paise >= 0),
  tax_paise      bigint not null default 0 check (tax_paise >= 0),
  total_paise    bigint not null default 0 check (total_paise >= 0),
  currency       text   not null default 'INR' check (currency = 'INR'),

  -- ── The document ──
  -- Null until finalized. Allocated by trigger, never by app code.
  invoice_no  integer,
  invoice_ref text,
  fy_label    text,

  -- ── Subscription period this covers ──
  -- ★ cycle_seq is the idempotency key for a renewal invoice.
  cycle_seq    integer check (cycle_seq is null or cycle_seq >= 0),
  period_start timestamptz,
  period_end   timestamptz,

  -- Tax snapshot, so a later operator change cannot rewrite history.
  tax_rate_bps    integer,
  place_of_supply text,
  supplier_gstin  text,
  customer_gstin  text,

  finalized_at timestamptz,
  due_at       timestamptz,
  paid_at      timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ★★ THE ANSWER TO SPEC §35. Two renewal workers cannot both create an invoice
-- for the same cycle, regardless of isolation level or worker coordination —
-- the second INSERT fails. NULLs do not collide, so ai_credits invoices (which
-- carry no cycle_seq) are unaffected and unlimited.
create unique index if not exists billing_invoices_one_per_cycle
  on public.billing_invoices (store_id, kind, cycle_seq)
  where cycle_seq is not null;

-- The document number is unique platform-wide once allocated.
create unique index if not exists billing_invoices_ref_key
  on public.billing_invoices (invoice_ref)
  where invoice_ref is not null;

create index if not exists billing_invoices_store_idx
  on public.billing_invoices (store_id, created_at desc);

-- The collection worker's scan: what is owed and not yet settled?
create index if not exists billing_invoices_open_idx
  on public.billing_invoices (due_at)
  where status in ('open','processing');

-- ★ A finalized invoice HAS a number; a draft does not. Both directions, so
-- neither a numbered draft nor an unnumbered finalized invoice can exist.
alter table public.billing_invoices
  drop constraint if exists billing_invoices_number_iff_finalized;
alter table public.billing_invoices
  add constraint billing_invoices_number_iff_finalized
  check ((finalized_at is null) = (invoice_ref is null));

-- Totals must add up. Not a nicety: an invoice whose parts disagree with its
-- total is the one document nobody can reconcile afterwards.
alter table public.billing_invoices
  drop constraint if exists billing_invoices_total_adds_up;
alter table public.billing_invoices
  add constraint billing_invoices_total_adds_up
  check (total_paise = subtotal_paise - discount_paise + tax_paise);

-- A subscription invoice covers a period; a credit purchase does not.
alter table public.billing_invoices
  drop constraint if exists billing_invoices_kind_shape;
alter table public.billing_invoices
  add constraint billing_invoices_kind_shape
  check (
    (kind = 'subscription' and cycle_seq is not null)
    or (kind = 'ai_credits' and cycle_seq is null)
  );

-- ── Line items ──────────────────────────────────────────────────────────────
create table if not exists public.billing_invoice_items (
  id         uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.billing_invoices(id) on delete cascade,
  -- Every line must be explainable (spec §13).
  kind       text not null check (kind in
               ('base_plan','location','addon','proration','discount','tax','account_credit','ai_credits')),
  description       text not null,
  quantity          integer not null default 1 check (quantity > 0),
  unit_amount_paise bigint not null,
  amount_paise      bigint not null,
  -- Position, so a printed invoice is stable across reads.
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists billing_invoice_items_invoice_idx
  on public.billing_invoice_items (invoice_id, sort_order);

alter table public.billing_invoices      enable row level security;
alter table public.billing_invoice_items enable row level security;
revoke all on public.billing_invoices      from anon, authenticated;
revoke all on public.billing_invoice_items from anon, authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- Number allocation — on FINALIZATION, by trigger.
--
-- ★★ Not on draft creation, and not in app code. A draft that is abandoned
-- would burn a number, and a gap is exactly what an audit flags — the same
-- reasoning that puts the credit-note serial on settlement (returns_04). And
-- `finalized_at IS NULL` in the guard makes it exactly-once, so a re-finalize
-- keeps the original number rather than leaving the first as a gap.
--
-- Routed through sm_pad(), never bare lpad(): lpad TRUNCATES as well as pads
-- and silently produced duplicate order references past 9999
-- (identifiers_05_no_truncate.sql). An invoice series with duplicates is worse.
-- ───────────────────────────────────────────────────────────────────────────
create or replace function public.billing_allocate_invoice_no()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_fy     text;
  v_seq    integer;
  v_prefix text;
begin
  if new.finalized_at is null or new.invoice_ref is not null then
    return new;
  end if;

  v_fy  := public.billing_fy_label(new.finalized_at);
  v_seq := public.billing_next_invoice_no(v_fy);

  select coalesce(invoice_prefix, 'SM') into v_prefix
    from public.platform_billing_settings where id = true;

  new.invoice_no  := v_seq;
  new.fy_label    := v_fy;
  new.invoice_ref := coalesce(v_prefix, 'SM') || '/' || v_fy || '/' ||
                     public.sm_pad(v_seq, 5);
  return new;
end; $$;

drop trigger if exists billing_invoices_allocate_no on public.billing_invoices;
create trigger billing_invoices_allocate_no
  before insert or update of finalized_at on public.billing_invoices
  for each row execute function public.billing_allocate_invoice_no();

-- ───────────────────────────────────────────────────────────────────────────
-- Immutability (spec §23).
--
-- ★ Once finalized, the financial amount cannot change. Something that happens
-- afterwards becomes a NEW document — a credit note, an adjustment, another
-- invoice — never an edit to this one. STATUS may still move (open → paid →
-- refunded); money may not.
-- ───────────────────────────────────────────────────────────────────────────
create or replace function public.billing_invoices_guard_immutable()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.finalized_at is null then
    return new;
  end if;

  if new.subtotal_paise is distinct from old.subtotal_paise
     or new.discount_paise is distinct from old.discount_paise
     or new.tax_paise      is distinct from old.tax_paise
     or new.total_paise    is distinct from old.total_paise
     or new.currency       is distinct from old.currency
     or new.kind           is distinct from old.kind
     or new.store_id       is distinct from old.store_id
     or new.cycle_seq      is distinct from old.cycle_seq
     or new.invoice_ref    is distinct from old.invoice_ref
     or new.invoice_no     is distinct from old.invoice_no
     or new.tax_rate_bps   is distinct from old.tax_rate_bps then
    raise exception
      'billing_invoices: % is finalized; issue an adjustment instead of editing it',
      old.invoice_ref;
  end if;
  return new;
end; $$;

drop trigger if exists billing_invoices_immutable on public.billing_invoices;
create trigger billing_invoices_immutable
  before update on public.billing_invoices
  for each row execute function public.billing_invoices_guard_immutable();

-- Line items are frozen with their parent. A finalized invoice whose lines can
-- still be edited is not immutable in any meaningful sense.
create or replace function public.billing_items_guard_immutable()
returns trigger language plpgsql set search_path = '' as $$
declare v_ref text; v_final timestamptz; v_invoice uuid;
begin
  v_invoice := coalesce(new.invoice_id, old.invoice_id);
  select finalized_at, invoice_ref into v_final, v_ref
    from public.billing_invoices where id = v_invoice;
  if v_final is not null then
    raise exception
      'billing_invoice_items: invoice % is finalized; its lines cannot change',
      coalesce(v_ref, v_invoice::text);
  end if;
  return coalesce(new, old);
end; $$;

drop trigger if exists billing_invoice_items_immutable on public.billing_invoice_items;
create trigger billing_invoice_items_immutable
  before insert or update or delete on public.billing_invoice_items
  for each row execute function public.billing_items_guard_immutable();

-- ───────────────────────── ROLLBACK ─────────────────────────
-- ⚠ These are FINANCIAL RECORDS. Dropping them destroys the invoice history and
-- the GST document series, which is exactly what rule 5 forbids. Export first.
--
-- BEGIN;
--   DROP TRIGGER IF EXISTS billing_invoice_items_immutable ON public.billing_invoice_items;
--   DROP TRIGGER IF EXISTS billing_invoices_immutable ON public.billing_invoices;
--   DROP TRIGGER IF EXISTS billing_invoices_allocate_no ON public.billing_invoices;
--   DROP FUNCTION IF EXISTS public.billing_items_guard_immutable();
--   DROP FUNCTION IF EXISTS public.billing_invoices_guard_immutable();
--   DROP FUNCTION IF EXISTS public.billing_allocate_invoice_no();
--   DROP TABLE IF EXISTS public.billing_invoice_items;
--   DROP TABLE IF EXISTS public.billing_invoices;
--   DROP FUNCTION IF EXISTS public.billing_next_invoice_no(text);
--   DROP FUNCTION IF EXISTS public.billing_fy_label(timestamptz);
--   DROP TABLE IF EXISTS public.billing_invoice_counters;
-- COMMIT;
