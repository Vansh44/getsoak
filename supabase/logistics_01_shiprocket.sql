-- ============================================================================
-- Logistics v1 — Shopify-style fulfilment orders + shipments, with Shiprocket
-- as the first carrier aggregator.
--
-- Order              what the customer bought
-- Fulfilment order   the work assigned to one stock location
-- Shipment           one physical parcel / AWB created from that work
-- Shipment event     append-only carrier history
--
-- v1 creates one fulfilment order per delivery order because StoreMink does not
-- yet support partial fulfilment. The schema is deliberately one-to-many so
-- split fulfilments do not require carrier columns to be pulled back out of
-- public.orders later.
--
-- Provider credentials and raw payloads are SERVICE-ROLE ONLY. Customer and
-- admin reads go through store/owner-scoped server actions.
-- ============================================================================

alter table public.products
  add column if not exists requires_shipping boolean not null default true,
  add column if not exists weight_grams integer,
  add column if not exists length_cm numeric(10,2),
  add column if not exists width_cm numeric(10,2),
  add column if not exists height_cm numeric(10,2);

alter table public.product_variants
  add column if not exists requires_shipping boolean,
  add column if not exists weight_grams integer,
  add column if not exists length_cm numeric(10,2),
  add column if not exists width_cm numeric(10,2),
  add column if not exists height_cm numeric(10,2);

-- Immutable logistics snapshots. A product can be renamed or reweighed after
-- checkout; an already placed order must still book exactly what was sold.
alter table public.order_items
  add column if not exists sku text,
  add column if not exists requires_shipping boolean not null default true,
  add column if not exists weight_grams integer,
  add column if not exists length_cm numeric(10,2),
  add column if not exists width_cm numeric(10,2),
  add column if not exists height_cm numeric(10,2);

do $$ begin
  alter table public.products add constraint products_weight_nonnegative
    check (weight_grams is null or weight_grams >= 0);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.product_variants add constraint product_variants_weight_nonnegative
    check (weight_grams is null or weight_grams >= 0);
exception when duplicate_object then null; end $$;

create table if not exists public.store_logistics_providers (
  id                    uuid primary key default gen_random_uuid(),
  store_id              uuid not null references public.stores(id) on delete cascade,
  provider              text not null check (provider in ('shiprocket', 'manual')),
  account_email         text,
  credential_secret_enc text,
  token_enc             text,
  token_expires_at      timestamptz,
  webhook_secret_hash   text,
  enabled               boolean not null default true,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (store_id, provider)
);

create table if not exists public.location_logistics_mappings (
  id                    uuid primary key default gen_random_uuid(),
  store_id              uuid not null references public.stores(id) on delete cascade,
  location_id           uuid not null references public.store_locations(id) on delete cascade,
  provider              text not null check (provider = 'shiprocket'),
  external_pickup_code  text not null,
  external_location_id  text,
  synced_at             timestamptz not null default now(),
  unique (location_id, provider),
  unique (store_id, provider, external_pickup_code)
);

create table if not exists public.fulfilment_orders (
  id              uuid primary key default gen_random_uuid(),
  store_id        uuid not null references public.stores(id) on delete cascade,
  order_id        uuid not null references public.orders(id) on delete cascade,
  location_id     uuid references public.store_locations(id) on delete set null,
  status          text not null default 'open'
                  check (status in ('open', 'in_progress', 'on_hold', 'fulfilled', 'cancelled')),
  hold_reason     text,
  assigned_at     timestamptz not null default now(),
  fulfilled_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (order_id, location_id)
);

create index if not exists fulfilment_orders_store_status_idx
  on public.fulfilment_orders(store_id, status, created_at desc);
create index if not exists fulfilment_orders_order_idx
  on public.fulfilment_orders(order_id);

create table if not exists public.fulfilment_order_items (
  fulfilment_order_id uuid not null references public.fulfilment_orders(id) on delete cascade,
  order_item_id       uuid not null references public.order_items(id) on delete cascade,
  quantity            integer not null check (quantity > 0),
  primary key (fulfilment_order_id, order_item_id)
);

create table if not exists public.shipments (
  id                    uuid primary key default gen_random_uuid(),
  store_id              uuid not null references public.stores(id) on delete cascade,
  order_id              uuid not null references public.orders(id) on delete cascade,
  fulfilment_order_id   uuid not null references public.fulfilment_orders(id) on delete cascade,
  location_id           uuid references public.store_locations(id) on delete set null,
  connection_id         uuid references public.store_logistics_providers(id) on delete set null,
  provider              text not null check (provider in ('shiprocket', 'manual')),
  status                text not null default 'draft' check (status in (
                          'draft', 'booking', 'ready_to_ship', 'pickup_scheduled',
                          'picked_up', 'in_transit', 'out_for_delivery',
                          'delivered', 'ndr', 'rto_initiated', 'rto_in_transit',
                          'rto_delivered', 'cancelled', 'lost', 'damaged', 'error'
                        )),
  idempotency_key       text not null unique,
  external_order_id     text,
  external_shipment_id  text,
  awb                   text,
  courier_id            text,
  courier_name          text,
  tracking_url          text,
  label_url             text,
  manifest_url          text,
  weight_grams          integer not null check (weight_grams > 0),
  length_cm             numeric(10,2) not null check (length_cm > 0),
  width_cm              numeric(10,2) not null check (width_cm > 0),
  height_cm             numeric(10,2) not null check (height_cm > 0),
  shipping_cost         numeric(12,2),
  cod_amount            numeric(12,2) not null default 0,
  estimated_delivery_at timestamptz,
  pickup_scheduled_at   timestamptz,
  picked_up_at          timestamptz,
  delivered_at          timestamptz,
  ndr_reason            text,
  last_error            text,
  operation_token       text,
  operation_lease_until timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create unique index if not exists shipments_provider_awb_idx
  on public.shipments(provider, awb)
  where provider = 'shiprocket' and awb is not null;
create unique index if not exists shipments_external_shipment_idx
  on public.shipments(connection_id, external_shipment_id)
  where connection_id is not null and external_shipment_id is not null;
create index if not exists shipments_order_idx on public.shipments(order_id, created_at);
create index if not exists shipments_store_status_idx on public.shipments(store_id, status, created_at desc);

create table if not exists public.shipment_items (
  shipment_id  uuid not null references public.shipments(id) on delete cascade,
  order_item_id uuid not null references public.order_items(id) on delete cascade,
  quantity      integer not null check (quantity > 0),
  primary key (shipment_id, order_item_id)
);

create table if not exists public.shipment_events (
  id               uuid primary key default gen_random_uuid(),
  shipment_id      uuid not null references public.shipments(id) on delete cascade,
  store_id         uuid not null references public.stores(id) on delete cascade,
  event_hash       text not null unique,
  status           text not null,
  external_status  text,
  external_code    text,
  description      text,
  location         text,
  occurred_at      timestamptz not null,
  payload          jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now()
);

create index if not exists shipment_events_shipment_time_idx
  on public.shipment_events(shipment_id, occurred_at desc);

alter table public.store_logistics_providers enable row level security;
alter table public.location_logistics_mappings enable row level security;
alter table public.fulfilment_orders enable row level security;
alter table public.fulfilment_order_items enable row level security;
alter table public.shipments enable row level security;
alter table public.shipment_items enable row level security;
alter table public.shipment_events enable row level security;

revoke all on public.store_logistics_providers from anon, authenticated;
revoke all on public.location_logistics_mappings from anon, authenticated;
revoke all on public.fulfilment_orders from anon, authenticated;
revoke all on public.fulfilment_order_items from anon, authenticated;
revoke all on public.shipments from anon, authenticated;
revoke all on public.shipment_items from anon, authenticated;
revoke all on public.shipment_events from anon, authenticated;

-- Existing delivery orders gain the same work object checkout creates for new
-- orders. Only location-routed orders are backfilled; legacy null-location rows
-- are self-healed when a merchant first books them.
insert into public.fulfilment_orders (store_id, order_id, location_id, status)
select o.store_id, o.id, o.location_id,
       case
         when o.status in ('delivered', 'completed') then 'fulfilled'
         when o.status = 'cancelled' then 'cancelled'
         when o.status in ('processing', 'shipped') then 'in_progress'
         else 'open'
       end
from public.orders o
where o.fulfilment_type = 'delivery' and o.location_id is not null
on conflict (order_id, location_id) do nothing;

insert into public.fulfilment_order_items (fulfilment_order_id, order_item_id, quantity)
select f.id, i.id, i.quantity
from public.fulfilment_orders f
join public.order_items i on i.order_id = f.order_id
on conflict (fulfilment_order_id, order_item_id) do nothing;

-- Rollback (data destructive; run only deliberately):
-- drop table if exists public.shipment_events, public.shipment_items,
--   public.shipments, public.fulfilment_order_items, public.fulfilment_orders,
--   public.location_logistics_mappings, public.store_logistics_providers cascade;
