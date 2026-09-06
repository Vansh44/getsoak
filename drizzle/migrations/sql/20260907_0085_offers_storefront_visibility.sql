-- Let a merchant publish a discount code on their own storefront.
--
-- `coupons.show_on_storefront` has existed since the coupon era and drives the
-- "Available coupons" list in the cart. Offers replaced coupons and never
-- carried the flag across, so a code created in the Offers UI could not be
-- advertised — and, separately, could not even be APPLIED (see the app change
-- shipping with this: `validateCoupon` read only the legacy table).
--
-- ★ DEFAULT FALSE, and that is not merely the conservative choice. Publishing a
-- code is the opposite of what most codes are for: a code sent to one customer
-- segment, or printed on a flyer, is targeted, and a storefront list showing it
-- to every visitor destroys the targeting the merchant set up. Opt in.
ALTER TABLE public.offers
  ADD COLUMN IF NOT EXISTS show_on_storefront BOOLEAN NOT NULL DEFAULT FALSE;

-- ⚠ A NEW COLUMN IS NOT COVERED BY AN EXISTING COLUMN-LIST GRANT, so it has to
-- be granted explicitly or `anon`/`authenticated` cannot see it at all.
--
-- ★ THE FLAG IS SAFE TO EXPOSE; THE CODE IT GOVERNS IS NOT. `offers.code` stays
-- revoked (migration 0059) — shipping every active code to anyone who opens the
-- network tab is the leak that grant exists to prevent. So the storefront's
-- own read runs in the SERVICE scope behind a narrow filter (this store, active,
-- code delivery, flag set), the same shape `store_pages` uses for its sealed
-- draft column. Granting the flag keeps the row readable for everything that
-- legitimately reads offers without the code.
GRANT SELECT (show_on_storefront) ON public.offers TO anon, authenticated;

COMMENT ON COLUMN public.offers.show_on_storefront IS
  'Opt-in: list this code in the storefront cart. Only meaningful for code delivery; the code column itself stays revoked from anon/authenticated.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'offers'
      AND column_name = 'show_on_storefront'
      AND is_nullable = 'NO'
      AND column_default = 'false'
  ) THEN
    RAISE EXCEPTION 'offers.show_on_storefront was not added as NOT NULL DEFAULT FALSE';
  END IF;

  -- The whole point of the column grant above.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.column_privileges
    WHERE table_schema = 'public'
      AND table_name = 'offers'
      AND column_name = 'show_on_storefront'
      AND grantee = 'anon'
      AND privilege_type = 'SELECT'
  ) THEN
    RAISE EXCEPTION 'offers.show_on_storefront was not granted to anon';
  END IF;

  -- ⚠ And the code must still be sealed. If this ever passes, the storefront
  -- list has become a public dump of every active discount code.
  IF EXISTS (
    SELECT 1 FROM information_schema.column_privileges
    WHERE table_schema = 'public'
      AND table_name = 'offers'
      AND column_name = 'code'
      AND grantee IN ('anon', 'authenticated')
      AND privilege_type = 'SELECT'
  ) THEN
    RAISE EXCEPTION 'offers.code is readable by anon/authenticated — it must stay revoked';
  END IF;
END $$;
