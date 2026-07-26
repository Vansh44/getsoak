-- =============================================================
-- POS Phase 2 (1/2) — the sell path: in-person orders, split tenders,
-- India GST place-of-supply, scannable barcodes, per-location receipt numbers.
--
-- POS sales live in the SAME orders/order_items tables as online orders, tagged
-- with sales_channel='pos'. One orders table keeps analytics, inventory, tax and
-- invoices unified across channels instead of bolting a second ledger alongside
-- (the thing that makes most POS add-ons diverge from their store's books).
--
-- That means relaxing two online-only assumptions: a walk-in has no customer
-- account and no shipping address, so orders.customer_id and
-- orders.shipping_address become NULLABLE.
--
-- ⚠ NULLABLE customer_id and the RLS policy: "Customers can view own orders" is
-- `customer_id = auth.uid()`. NULL is never equal to anything in SQL, so a
-- walk-in order matches no customer and stays admin-only. Verified by test.
--
-- ⚠ Run as `postgres` AFTER pos_05_device_hardening.sql. Idempotent.
-- =============================================================

-- -------------------------------------------------------------
-- 1. orders — in-person sale context + GST place of supply
-- -------------------------------------------------------------
ALTER TABLE orders ADD COLUMN IF NOT EXISTS sales_channel TEXT NOT NULL DEFAULT 'online';
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_sales_channel_check;
ALTER TABLE orders ADD CONSTRAINT orders_sales_channel_check
  CHECK (sales_channel IN ('online', 'pos'));

ALTER TABLE orders ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES store_locations(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS device_id   UUID;  -- no FK: the sale outlives the device
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cashier_id  UUID;  -- pos_staff.id; NULL when the owner rang it
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cashier_name TEXT; -- snapshot for the receipt
ALTER TABLE orders ADD COLUMN IF NOT EXISTS receipt_no  TEXT;  -- per-location, e.g. DEL-000123

-- India GST: the place of supply decides CGST+SGST (intra-state) vs IGST.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS place_of_supply_state TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS supplier_state        TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_gstin        TEXT;

-- A walk-in has neither an account nor a delivery address.
ALTER TABLE orders ALTER COLUMN customer_id      DROP NOT NULL;
ALTER TABLE orders ALTER COLUMN shipping_address DROP NOT NULL;

CREATE INDEX IF NOT EXISTS orders_channel_idx
  ON orders (store_id, sales_channel, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_location_idx
  ON orders (location_id, created_at DESC) WHERE location_id IS NOT NULL;

-- -------------------------------------------------------------
-- 2. order_items — per-line GST split + HSN snapshot
-- -------------------------------------------------------------
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS tax_cgst NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS tax_sgst NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS tax_igst NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS hsn_code TEXT;

-- -------------------------------------------------------------
-- 3. order_payments — split tenders (cash + card + … on one sale)
--    The existing orders.payment_method/payment_status stay as the SUMMARY.
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS order_payments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  store_id    UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  method      TEXT NOT NULL CHECK (method IN
                ('cash','card','upi','gift_card','store_credit','razorpay')),
  amount      NUMERIC(12,2) NOT NULL,
  tendered    NUMERIC(12,2),   -- cash handed over (cash only)
  change_due  NUMERIC(12,2),   -- change returned (cash only)
  reference   TEXT,            -- terminal approval code / UPI ref / rzp payment id
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS order_payments_order_idx ON order_payments (order_id);
CREATE INDEX IF NOT EXISTS order_payments_store_idx ON order_payments (store_id, captured_at DESC);

ALTER TABLE order_payments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Store admins read order_payments" ON order_payments;
CREATE POLICY "Store admins read order_payments"
  ON order_payments FOR SELECT
  USING ((SELECT is_store_admin(store_id)));
-- Writes go through placePosSale with the service role (the checkout model:
-- money rows are never written under a client-controlled scope).

-- -------------------------------------------------------------
-- 4. Scannable barcodes + HSN on the catalog
--    Merchants scan the SUPPLIER's barcode — distinct from the system-generated
--    Luhn `sku` (identifiers_04_triggers.sql), which is ours and immutable.
-- -------------------------------------------------------------
ALTER TABLE products         ADD COLUMN IF NOT EXISTS barcode  TEXT;
ALTER TABLE products         ADD COLUMN IF NOT EXISTS hsn_code TEXT;
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS barcode  TEXT;

-- Barcode lookup is the register's hot path. NOT unique: the same supplier
-- barcode legitimately appears on multiple variants (and gets mislabelled), so
-- the register disambiguates instead of the DB rejecting the data.
CREATE INDEX IF NOT EXISTS products_barcode_idx
  ON products (store_id, barcode) WHERE barcode IS NOT NULL;
CREATE INDEX IF NOT EXISTS variants_barcode_idx
  ON product_variants (store_id, barcode) WHERE barcode IS NOT NULL;

-- -------------------------------------------------------------
-- 5. store_billing_settings — GST identity
-- -------------------------------------------------------------
ALTER TABLE store_billing_settings ADD COLUMN IF NOT EXISTS gst_enabled          BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE store_billing_settings ADD COLUMN IF NOT EXISTS business_state_code  TEXT;
ALTER TABLE store_billing_settings ADD COLUMN IF NOT EXISTS legal_name           TEXT;

-- -------------------------------------------------------------
-- 6. Per-location receipt numbers (DEL-000123)
--    Same atomic single-UPDATE allocator as next_order_no (identifiers_01).
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pos_location_counters (
  location_id UUID PRIMARY KEY REFERENCES store_locations(id) ON DELETE CASCADE,
  receipt_seq INTEGER NOT NULL DEFAULT 0
);
ALTER TABLE pos_location_counters ENABLE ROW LEVEL SECURITY;
-- A live counter leaks sales volume — service-role only, like store_counters.
REVOKE ALL ON pos_location_counters FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.next_pos_receipt_no(p_location uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_seq integer;
BEGIN
  INSERT INTO public.pos_location_counters (location_id) VALUES (p_location)
    ON CONFLICT (location_id) DO NOTHING;
  UPDATE public.pos_location_counters
     SET receipt_seq = receipt_seq + 1
   WHERE location_id = p_location
  RETURNING receipt_seq INTO v_seq;
  RETURN v_seq;
END;
$$;

GRANT EXECUTE ON FUNCTION public.next_pos_receipt_no(uuid) TO app_user, app_service;

-- =============================================================
-- Rollback:
--   DROP FUNCTION IF EXISTS public.next_pos_receipt_no(uuid);
--   DROP TABLE IF EXISTS pos_location_counters CASCADE;
--   ALTER TABLE store_billing_settings DROP COLUMN IF EXISTS legal_name,
--     DROP COLUMN IF EXISTS business_state_code, DROP COLUMN IF EXISTS gst_enabled;
--   DROP INDEX IF EXISTS variants_barcode_idx; DROP INDEX IF EXISTS products_barcode_idx;
--   ALTER TABLE product_variants DROP COLUMN IF EXISTS barcode;
--   ALTER TABLE products DROP COLUMN IF EXISTS hsn_code, DROP COLUMN IF EXISTS barcode;
--   DROP TABLE IF EXISTS order_payments CASCADE;
--   ALTER TABLE order_items DROP COLUMN IF EXISTS hsn_code, DROP COLUMN IF EXISTS tax_igst,
--     DROP COLUMN IF EXISTS tax_sgst, DROP COLUMN IF EXISTS tax_cgst;
--   -- NOTE: re-adding NOT NULL to orders.customer_id/shipping_address requires
--   -- deleting POS orders first (they legitimately have neither).
--   ALTER TABLE orders DROP COLUMN IF EXISTS customer_gstin, DROP COLUMN IF EXISTS supplier_state,
--     DROP COLUMN IF EXISTS place_of_supply_state, DROP COLUMN IF EXISTS receipt_no,
--     DROP COLUMN IF EXISTS cashier_name, DROP COLUMN IF EXISTS cashier_id,
--     DROP COLUMN IF EXISTS device_id, DROP COLUMN IF EXISTS location_id,
--     DROP COLUMN IF EXISTS sales_channel;
-- =============================================================
