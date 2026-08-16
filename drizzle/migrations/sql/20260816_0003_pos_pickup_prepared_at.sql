-- Preserve the difference between the date promised at checkout and the moment
-- staff actually confirmed a collection was packed.
--
-- orders.pickup_ready_at is already populated at order creation from the
-- merchant's pickup-ready-days setting. Reusing it as an actual preparation
-- timestamp made the "collected without Mark ready" audit test impossible.

alter table public.orders
  add column if not exists pickup_prepared_at timestamptz;

comment on column public.orders.pickup_prepared_at is
  'When staff actually confirmed a pickup was packed. Equals collected_at when an awaiting order is handed over with the explicit unprepared acknowledgement.';
