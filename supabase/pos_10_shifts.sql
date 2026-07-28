-- POS Phase 3 — shifts & cash reconciliation (docs/pos-plan.md Phase 3).
--
-- Run as `postgres`, after pos_09.
--
-- A shift is one accounting period for a location's cash drawer: opened with a
-- counted float, closed with a counted drawer, and the difference between what
-- the system expected and what was actually there is the VARIANCE — the number
-- that tells a merchant whether they have a till-skimming problem or a
-- miscounting one.
--
-- ── Why per LOCATION, not per device ────────────────────────────────────────
-- Physically a drawer belongs to a till station, which maps to a device. But
-- owners are not device-bound (lib/pos/operator.ts resolves them with no
-- device at all), so a per-device shift would have no home for an owner's cash
-- sale. Per location is always well defined — every operator has a locationId
-- — and "expected cash at this shop" is the number a merchant actually asks
-- for. A store that later runs several drawers per shop wants a
-- `device_id` column here and a wider partial unique index; nothing else in
-- this design has to change.

BEGIN;

CREATE TABLE IF NOT EXISTS public.pos_shifts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id        uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  location_id     uuid NOT NULL REFERENCES public.store_locations(id) ON DELETE CASCADE,
  status          text NOT NULL DEFAULT 'open',

  opened_at       timestamptz NOT NULL DEFAULT now(),
  opened_by       text,
  -- Denormalised so a report still names whoever opened it after that staff
  -- member is deleted. The audit value of a shift outlives the employment.
  opened_by_name  text,
  opening_float   numeric(12, 2) NOT NULL DEFAULT 0,

  closed_at       timestamptz,
  closed_by       text,
  closed_by_name  text,
  -- Snapshotted at close: what the drawer held, what it should have held, and
  -- the difference. Stored rather than recomputed so a historical Z-report can
  -- never drift when an old order is edited.
  counted_cash    numeric(12, 2),
  expected_cash   numeric(12, 2),
  variance        numeric(12, 2),
  note            text,

  CONSTRAINT pos_shifts_status_check CHECK (status IN ('open', 'closed')),
  CONSTRAINT pos_shifts_float_check CHECK (opening_float >= 0)
);

-- ONE open shift per location. A partial unique index is the whole concurrency
-- story: two managers tapping "Open shift" at the same moment cannot produce
-- two drawers, and the loser gets a unique violation rather than a silently
-- split day's cash.
CREATE UNIQUE INDEX IF NOT EXISTS pos_shifts_one_open_per_location
  ON public.pos_shifts (location_id) WHERE status = 'open';

CREATE INDEX IF NOT EXISTS idx_pos_shifts_store_opened
  ON public.pos_shifts (store_id, opened_at DESC);

-- Cash into or out of the drawer that ISN'T a sale: a mid-day drop to the
-- safe, a supplier paid in cash, float topped up from the office.
CREATE TABLE IF NOT EXISTS public.pos_cash_movements (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id        uuid NOT NULL REFERENCES public.pos_shifts(id) ON DELETE CASCADE,
  store_id        uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  type            text NOT NULL,
  -- Always POSITIVE; `type` carries the direction. A signed amount plus a type
  -- gives two ways to say "out", and they eventually disagree.
  amount          numeric(12, 2) NOT NULL,
  reason          text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      text,
  created_by_name text,

  CONSTRAINT pos_cash_movements_type_check
    CHECK (type IN ('drop', 'payout', 'paid_in')),
  CONSTRAINT pos_cash_movements_amount_check CHECK (amount > 0)
);

CREATE INDEX IF NOT EXISTS idx_pos_cash_movements_shift
  ON public.pos_cash_movements (shift_id, created_at);

-- Which shift a sale belongs to. Explicit rather than inferred from a time
-- window: a sale rung at 23:59:59.6 must not land in tomorrow's drawer because
-- two clocks disagreed by a second.
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS shift_id uuid REFERENCES public.pos_shifts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_orders_shift ON public.orders (shift_id)
  WHERE shift_id IS NOT NULL;

-- Service-role only, like every other pos_ table. Reads and writes go through
-- pos-shift-actions.ts, which resolves the operator server-side and checks the
-- open_close_shift / cash_drop capabilities.
ALTER TABLE public.pos_shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_cash_movements ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.pos_shifts IS
  'One cash-drawer accounting period per location. At most one open at a time.';
COMMENT ON COLUMN public.pos_shifts.variance IS
  'counted_cash - expected_cash at close. Negative = drawer short.';
COMMENT ON COLUMN public.pos_cash_movements.amount IS
  'Always positive; `type` carries the direction (drop/payout out, paid_in in).';

COMMIT;

-- ── Rollback ────────────────────────────────────────────────────────────────
-- BEGIN;
-- ALTER TABLE public.orders DROP COLUMN IF EXISTS shift_id;
-- DROP TABLE IF EXISTS public.pos_cash_movements;
-- DROP TABLE IF EXISTS public.pos_shifts;
-- COMMIT;
