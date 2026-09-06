-- A discount code IS an offer, and a merchant can now publish one.
--
-- Two things ship with this that the guide has to describe, and one of them is
-- a bug the guide would otherwise be describing wrongly:
--
--   • A CODE CREATED IN THE OFFERS UI COULD NOT BE APPLIED AT ALL.
--     `validateCoupon` read only the legacy `coupons` table, so a code with no
--     coupon row was rejected as invalid in the cart — and because the order
--     only ever receives the code the cart accepted, the offer engine (which
--     honours it perfectly well) was never asked. Codes migrated from the old
--     coupon system kept working; anything created afterwards did not.
--
--   • THE STOREFRONT LIST NOW INCLUDES PUBLISHED CODES, opt-in per offer.
--
-- ★ ONLY A PERCENTAGE OR AN AMOUNT OFF THE ORDER can be published, because the
-- cart previews those with its own arithmetic. A buy-X-get-Y or a bundle on a
-- code still works at checkout, but only the engine can price it, so it cannot
-- be shown as a saving — and advertising a code the cart then refuses is worse
-- than not advertising it.
UPDATE public.help_articles
SET body = replace(
      body,
      '<h2>Best offer wins</h2>',
      $h$<h2>Discount codes, and showing them on your storefront</h2>
<p>Choose <strong>A coupon — a percentage or an amount off</strong>, then pick which of the two it is. Set <strong>Delivery</strong> to <strong>With a discount code</strong> and give it a code; the code is not case-sensitive and spaces are removed.</p>
<p><strong>Show this coupon on my storefront</strong> lists the code in the cart under “Available coupons”, where any shopper can apply it in one tap. It is off by default on purpose: most codes are targeted — emailed to a segment, or printed on a flyer — and listing one publicly undoes exactly the targeting you set up. Turn it on for a code you are happy for anyone to use.</p>
<p>The tick box appears only for a coupon on a code. A buy X get Y, a bundle or a quantity break can be put on a code and will work at checkout, but it cannot be listed: the cart shows a saving next to each code, and those rewards depend on the whole basket, so there is no single figure to show before the customer has built one.</p>
<h2>Best offer wins</h2>$h$
    ),
    updated_at = now()
WHERE slug = 'create-and-manage-offers'
  AND status = 'published'
  AND body NOT LIKE '%<h2>Discount codes, and showing them on your storefront</h2>%';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.help_articles
    WHERE slug = 'create-and-manage-offers'
      AND status = 'published'
      AND body LIKE '%<h2>Discount codes, and showing them on your storefront</h2>%'
      AND body LIKE '%Show this coupon on my storefront%'
      AND body LIKE '%off by default on purpose%'
  ) THEN
    RAISE EXCEPTION 'offers coupon-visibility guidance was not installed';
  END IF;
END $$;
