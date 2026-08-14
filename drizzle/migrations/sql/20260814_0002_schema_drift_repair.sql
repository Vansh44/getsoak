-- Canonicalize two definitions that drifted between staging and production.
--
-- 1. Production's sm_credit_note_ref was recreated by returns_04 AFTER the
--    non-truncating identifier migration had run. It therefore went back to
--    bare lpad(), which truncates sequence 12345 to 1234 and can duplicate a
--    legal GST credit-note serial.
-- 2. store_subscriptions.scheduled_plan has equivalent nullable CHECK forms in
--    the two databases. Replacing both with one definition makes future schema
--    drift checks meaningful.

create or replace function public.sm_credit_note_ref(p_store int, p_seq int)
returns text language sql immutable set search_path = '' as $$
  select 'CRN' || public.sm_pad(p_store,4) || public.sm_pad(p_seq,4)
      || public.sm_luhn(public.sm_pad(p_store,4) || public.sm_pad(p_seq,4))::text;
$$;

alter table public.store_subscriptions
  drop constraint if exists store_subscriptions_scheduled_plan_check;

alter table public.store_subscriptions
  add constraint store_subscriptions_scheduled_plan_check
  check (scheduled_plan is null or scheduled_plan in ('basic', 'pro'));

do $$
begin
  if public.sm_credit_note_ref(1001, 12345) <> 'CRN1001123452' then
    raise exception 'sm_credit_note_ref still truncates: got %',
      public.sm_credit_note_ref(1001, 12345);
  end if;
  if public.sm_credit_note_ref(1001, 1) <> 'CRN100100015' then
    raise exception 'sm_credit_note_ref changed an already-issued code: got %',
      public.sm_credit_note_ref(1001, 1);
  end if;
end $$;
