-- Say what a variant's sale price actually DOES, without editing the
-- already-applied products Help migration.
--
-- Two published guides tell merchants to enter an "optional sale price" on a
-- variant and neither states its effect. That was survivable only while the
-- effect was inconsistent: the storefront displayed the sale price and the
-- register charged it, while online checkout charged the regular selling
-- price. Now that every surface charges the sale price, the guide can state
-- the rule — including the part a merchant would otherwise meet by surprise,
-- that a free-delivery threshold is judged on the discounted amount.

UPDATE public.help_articles
SET body = replace(
      body,
      '<h2>Choose tax details</h2>',
      $sale$<h2>What a variant sale price does</h2>
<p>A variant's sale price is the amount the customer pays, both on your website and at the register. Its regular selling price is what the sale is measured against, and the storefront flags the option as the better-value choice. Clear the sale price to end the sale; the variant then charges its selling price again.</p>
<p>Only variants carry a sale price. A product without variants always charges its own selling price.</p>
<p>Delivery quotes and any free-delivery threshold are judged on the discounted order value, so a basket of items on sale counts towards free delivery at the price the customer actually pays, not the regular price. Taxes are also calculated on the sale price.</p>
<h2>Choose tax details</h2>$sale$
    ),
    updated_at = now()
WHERE slug = 'set-product-pricing-tax-and-shipping-details'
  AND status = 'published'
  AND body NOT LIKE '%<h2>What a variant sale price does</h2>%';

UPDATE public.help_articles
SET body = replace(
      body,
      '<h2>Simple products and variants</h2>',
      $sale$<h2>Sale prices on variants</h2>
<p>The optional sale price is what the customer pays for that option, on your website and at the register. Clear it to return the variant to its selling price. See <a href="/help/products/set-product-pricing-tax-and-shipping-details">Set product pricing, tax, and shipping details</a> for how it affects tax and delivery charges.</p>
<h2>Simple products and variants</h2>$sale$
    ),
    updated_at = now()
WHERE slug = 'add-product-images-and-variants'
  AND status = 'published'
  AND body NOT LIKE '%<h2>Sale prices on variants</h2>%';

-- The offers guide (migration 0059) already presents `offers.onSalePrice` as a
-- store-wide choice, which was not true online: `placeOrder` sent the engine no
-- regular price, so every sale line looked full-price and "Skip sale items"
-- silently did not skip. It is true in both channels now, so say so.
UPDATE public.help_articles
SET body = replace(
      body,
      '<h2>What shoppers see</h2>',
      $both$<p>Your choice applies both on your online store and at the register, so the same basket is priced the same way in either place.</p>
<h2>What shoppers see</h2>$both$
    ),
    updated_at = now()
WHERE slug = 'create-and-manage-offers'
  AND status = 'published'
  AND body NOT LIKE '%priced the same way in either place%';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.help_articles
    WHERE slug = 'set-product-pricing-tax-and-shipping-details'
      AND status = 'published'
      AND body LIKE '%<h2>What a variant sale price does</h2>%'
      AND body LIKE '%both on your website and at the register%'
      AND body LIKE '%counts towards free delivery at the price the customer actually pays%'
  ) THEN
    RAISE EXCEPTION 'variant sale-price pricing guidance was not installed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.help_articles
    WHERE slug = 'add-product-images-and-variants'
      AND status = 'published'
      AND body LIKE '%<h2>Sale prices on variants</h2>%'
      AND body LIKE '%Clear it to return the variant to its selling price%'
  ) THEN
    RAISE EXCEPTION 'variant sale-price variants guidance was not installed';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.help_articles
    WHERE slug = 'create-and-manage-offers'
      AND status = 'published'
      AND body LIKE '%priced the same way in either place%'
  ) THEN
    RAISE EXCEPTION 'offers sale-price channel guidance was not installed';
  END IF;
END $$;
