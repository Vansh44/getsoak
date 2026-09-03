-- Offers Phase H: bundles and cashback (docs/offers-plan.md §14, §16).
--
-- Additive. The Phase G allowlist is widened and one new store-credit ledger
-- kind is permitted; every offer and every credit row already created stays
-- valid and unchanged.

ALTER TABLE public.offers
  DROP CONSTRAINT offers_reward_type_check,
  ADD CONSTRAINT offers_reward_type_check CHECK (
    reward_type IN (
      'percent_off',       -- % off the order            (A)
      'amount_off',        -- ₹ off the order            (A)
      'percent_off_items', -- % off matching lines       (B)
      'fixed_price',       -- each matching item at ₹X   (B)
      'buy_x_get_y',       -- buy N, get M discounted    (C)
      'tiered',            -- spend ladder, order level  (D)
      'volume_break',      -- quantity ladder, per item  (D)
      'free_shipping',     -- delivery charge waived     (F)
      'free_item',         -- a gift added at ₹0         (G)
      'bundle_price',      -- any N from the scope at ₹X (H)
      'credit_back'        -- store credit, not a discount (H)
    )
  );

-- ★ A BUNDLE OF ONE IS A FIXED PRICE, which already exists — allowing it here
-- would give merchants two ways to build the same offer and two places for it
-- to behave differently. Twenty is a ceiling on a typo, not a business rule.
--
-- ★ COALESCED, per the trap this feature has hit at 0062, 0064, 0065 and 0067:
-- a CHECK is SATISFIED when it evaluates to NULL, so a bare
-- `(reward_config ->> 'bundleQuantity') ~ '…'` accepts a row with no key.
ALTER TABLE public.offers
  ADD CONSTRAINT offers_bundle_shape_check CHECK (
    reward_type <> 'bundle_price'
    OR (
      coalesce(reward_config ->> 'bundleQuantity', '') ~ '^([2-9]|1[0-9]|20)$'
      AND coalesce(reward_config ->> 'bundlePrice', '') ~ '^[0-9]+(\.[0-9]{1,2})?$'
      AND (reward_config ->> 'bundlePrice')::numeric > 0
    )
  );

ALTER TABLE public.offers
  ADD CONSTRAINT offers_credit_back_shape_check CHECK (
    reward_type <> 'credit_back'
    OR (
      coalesce(reward_config ->> 'creditAmount', '') ~ '^[0-9]+(\.[0-9]{1,2})?$'
      AND (reward_config ->> 'creditAmount')::numeric > 0
    )
  );

-- ★★ CASHBACK GETS ITS OWN LEDGER KIND, not `grant`. The store-credit design
-- (CODEBASE §29) already keeps `reinstate` apart from `grant` because "a report
-- that can't tell a returned spend from a goodwill gesture overstates what the
-- store gave away". Credit earned by a promotion is a third thing again: a
-- merchant reviewing what their offers cost must be able to see it separately
-- from what they handed out by hand, and an accountant looking at the liability
-- needs to know which of it was contractual.
ALTER TABLE public.customer_credit_ledger
  DROP CONSTRAINT customer_credit_ledger_kind_check,
  ADD CONSTRAINT customer_credit_ledger_kind_check CHECK (
    kind IN ('refund', 'grant', 'spend', 'reinstate', 'expire', 'cashback')
  );

-- ---------------------------------------------------------------------------
-- Help Centre
-- ---------------------------------------------------------------------------

UPDATE public.help_articles
SET body = replace(
      body,
      '<h2>Extra conditions</h2>',
      $h$<h2>Bundles — any few items for one price</h2>
<p>Choose <strong>Bundle price</strong>, pick the products or categories it covers, and set how many make a bundle and what the bundle costs — "any 3 tees for ₹999".</p>
<p><strong>Items are counted across the basket</strong>, so three different tees make one bundle between them. If the basket holds more than one bundle's worth, the offer repeats unless you set a limit.</p>
<p><strong>The most expensive qualifying items go into the bundle.</strong> That is deliberate: it gives the customer the biggest saving, and it is the only way round that cannot accidentally charge <em>more</em> than the items were worth. If the items that would go into a bundle come to less than the bundle price, the offer does not apply to them at all — a bundle can never raise a price.</p>
<p>This is an "any N from this group" bundle. Requiring one specific product plus another specific product is not supported.</p>
<h2>Cashback as store credit</h2>
<p>Choose <strong>Store credit back</strong> and set an amount — "₹100 credit on orders over ₹2,000".</p>
<p><strong>Cashback is not a discount.</strong> The customer pays the full price today and receives store credit afterwards, which they can spend on a later order. It does not reduce the order total, it does not change the tax, and it does not appear on the invoice — because nothing about what they paid has changed.</p>
<p>The credit is added once the order is placed, and it appears in the customer's account alongside any refunds they hold. In your credit records it is listed as cashback, kept separate from credit you granted by hand and from refunds, so you can see what your offers actually cost.</p>
<p><strong>⚠ It is money you owe.</strong> Unlike a discount, which costs you once, cashback creates a balance the customer can spend at any time. Set a budget on the offer if you want a ceiling on how much you issue.</p>
<h2>Extra conditions</h2>$h$
    ),
    updated_at = now()
WHERE slug = 'create-and-manage-offers'
  AND status = 'published'
  AND body NOT LIKE '%<h2>Bundles — any few items for one price</h2>%';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.help_articles
    WHERE slug = 'create-and-manage-offers'
      AND status = 'published'
      AND body LIKE '%<h2>Bundles — any few items for one price</h2>%'
      AND body LIKE '%most expensive qualifying items go into the bundle%'
      AND body LIKE '%a bundle can never raise a price%'
      AND body LIKE '%<h2>Cashback as store credit</h2>%'
      AND body LIKE '%Cashback is not a discount%'
      AND body LIKE '%money you owe%'
  ) THEN
    RAISE EXCEPTION 'offers bundle and cashback guidance was not installed';
  END IF;
END $$;
