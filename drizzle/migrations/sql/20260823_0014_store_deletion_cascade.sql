-- A store deletion is a permanent tenant purge. Three historical/log tables
-- used ON DELETE SET NULL, which preserved personal and payment data after the
-- tenant was gone. Make every direct stores(id) relationship cascade.

alter table public.billing_reconciliation_items
  drop constraint if exists billing_reconciliation_items_store_id_fkey;
alter table public.billing_reconciliation_items
  add constraint billing_reconciliation_items_store_id_fkey
  foreign key (store_id) references public.stores(id) on delete cascade;

alter table public.platform_announcement_recipients
  drop constraint if exists platform_announcement_recipients_store_id_fkey;
alter table public.platform_announcement_recipients
  add constraint platform_announcement_recipients_store_id_fkey
  foreign key (store_id) references public.stores(id) on delete cascade;

-- Store-policy acceptances are normally append-only. Allow their deletion only
-- while their parent store is being cascade-deleted; direct deletes and every
-- update retain the existing immutability rules.
create or replace function public.legal_acceptances_append_only()
returns trigger
language plpgsql
as $$
begin
  if TG_OP = 'DELETE' then
    if OLD.store_id is not null
       and not exists (
         select 1 from public.stores where id = OLD.store_id
       ) then
      return OLD;
    end if;
    raise exception 'legal_acceptances is append-only';
  end if;

  if OLD.document_id is not null then
    raise exception 'legal_acceptances is append-only';
  end if;

  if NEW.user_id     is distinct from OLD.user_id
  or NEW.store_id    is distinct from OLD.store_id
  or NEW.policy_slug is distinct from OLD.policy_slug
  or NEW.actor_type  is distinct from OLD.actor_type then
    raise exception 'legal_acceptances: identity of an acceptance cannot change';
  end if;

  return NEW;
end;
$$;

alter table public.legal_acceptances
  drop constraint if exists legal_acceptances_store_id_fkey;
alter table public.legal_acceptances
  add constraint legal_acceptances_store_id_fkey
  foreign key (store_id) references public.stores(id) on delete cascade;
