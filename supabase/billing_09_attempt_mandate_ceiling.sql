-- =============================================================
-- §34 — persist the exact mandate ceiling offered at checkout.
--
-- The authorisation order is created before the mandate exists. Confirmation
-- reads the token back from Razorpay, but the payment response does not carry
-- token.max_amount. Recomputing later can drift after a reprice/tax change and
-- accepting it from the browser would let the browser choose a debit ceiling.
-- Store the exact server-computed value on the durable attempt instead.
--
-- Apply as `postgres` before deploying the matching application code.
-- Idempotent; additive; existing ordinary attempts remain NULL.
-- =============================================================

alter table public.billing_payment_attempts
  add column if not exists mandate_max_paise bigint;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'billing_payment_attempts_mandate_max_check'
      and conrelid = 'public.billing_payment_attempts'::regclass
  ) then
    alter table public.billing_payment_attempts
      add constraint billing_payment_attempts_mandate_max_check
      check (mandate_max_paise is null or mandate_max_paise > 0);
  end if;
end $$;

-- Fail the migration if the durable column/constraint are not really present.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'billing_payment_attempts'
      and column_name = 'mandate_max_paise'
      and data_type = 'bigint'
  ) then
    raise exception 'billing_09: mandate_max_paise missing';
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'billing_payment_attempts_mandate_max_check'
      and conrelid = 'public.billing_payment_attempts'::regclass
  ) then
    raise exception 'billing_09: mandate max constraint missing';
  end if;
  raise notice 'billing_09: ALL PASSED (2/2)';
end $$;

-- ROLLBACK (only before any mandate-authorisation attempt uses the column):
-- alter table public.billing_payment_attempts
--   drop constraint if exists billing_payment_attempts_mandate_max_check,
--   drop column if exists mandate_max_paise;
