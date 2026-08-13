-- Checkout delivery pricing. This is deliberately separate from provider
-- credentials: a merchant may book with Shiprocket but charge customers a
-- flat/free price, or expose Shiprocket's live prices with an adjustment.

CREATE TABLE IF NOT EXISTS public.store_shipping_settings (
  store_id uuid PRIMARY KEY REFERENCES public.stores(id) ON DELETE CASCADE,
  mode text NOT NULL DEFAULT 'free'
    CHECK (mode IN ('free', 'flat', 'shiprocket')),
  flat_rate numeric(12,2) NOT NULL DEFAULT 0 CHECK (flat_rate >= 0),
  free_above numeric(12,2) CHECK (free_above IS NULL OR free_above > 0),
  manual_min_days integer NOT NULL DEFAULT 3
    CHECK (manual_min_days BETWEEN 0 AND 60),
  manual_max_days integer NOT NULL DEFAULT 7,
  handling_days integer NOT NULL DEFAULT 1
    CHECK (handling_days BETWEEN 0 AND 30),
  carrier_adjustment_type text NOT NULL DEFAULT 'none'
    CHECK (carrier_adjustment_type IN ('none', 'fixed', 'percentage')),
  carrier_adjustment_value numeric(12,2) NOT NULL DEFAULT 0
    CHECK (carrier_adjustment_value >= 0),
  show_all_couriers boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  CONSTRAINT store_shipping_settings_days_check
    CHECK (manual_max_days BETWEEN manual_min_days AND 90)
);

ALTER TABLE public.store_shipping_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Store admins manage shipping settings"
  ON public.store_shipping_settings;
CREATE POLICY "Store admins manage shipping settings"
  ON public.store_shipping_settings
  FOR ALL TO authenticated
  USING (public.is_store_admin(store_id))
  WITH CHECK (public.is_store_admin(store_id));

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS shipping_option jsonb;

COMMENT ON COLUMN public.orders.shipping_option IS
  'Immutable checkout shipping choice: provider, courier, customer price, carrier cost and ETA.';
