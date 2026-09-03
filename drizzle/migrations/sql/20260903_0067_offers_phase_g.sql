-- Offers Phase G: a free gift (docs/offers-plan.md §12, §16).
--
-- Additive. The Phase F allowlist is widened; every offer already created stays
-- valid and unchanged.
--
-- ⚠⚠ THE GST TREATMENT OF A FREE GOOD IS NOT PROFESSIONALLY REVIEWED. The plan
-- is explicit that "a ₹0 line is not a zero-tax line": under India's GST a free
-- good given with a sale is not automatically outside the tax base, and it can
-- attract input-credit reversal or valuation at open market value. What ships
-- here is the DATA — the gift line records its own tax class, so the figures
-- exist if the treatment turns out to require them — with tax on a zero taxable
-- value computed as zero. That is the §25/§28 posture this codebase already
-- takes for policy text and credit notes: build the fields, flag it loudly, get
-- a professional to confirm before anyone files against it. The Help guide and
-- the offer editor both say so to the merchant in as many words.

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
      'free_item'          -- a gift added at ₹0         (G)
    )
  );

-- ★★ A GIFT OFFER MUST NAME A GIFT. An offer with no product is not a weaker
-- offer — the engine reports no gift while the merchant's list shows it active,
-- so a customer who "qualified" receives nothing and nobody can see why.
--
-- ★ THE QUANTITY IS CAPPED LOW. A gift is stock leaving the shelf, so a typo
-- here is inventory gone rather than money discounted; ten is far more than any
-- "free tumbler with your order" needs.
--
-- ★ COALESCED, per the trap this feature has now hit three times (0062, 0064,
-- 0065): a CHECK is SATISFIED when it evaluates to NULL, so a bare
-- `(reward_config ->> 'giftProductId') ~ '…'` accepts a row with no key at all.
ALTER TABLE public.offers
  ADD CONSTRAINT offers_free_item_shape_check CHECK (
    reward_type <> 'free_item'
    OR (
      coalesce(reward_config ->> 'giftProductId', '')
        ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      AND (
        reward_config ->> 'giftVariantId' IS NULL
        OR (reward_config ->> 'giftVariantId')
             ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      )
      AND coalesce(reward_config ->> 'giftQuantity', '') ~ '^([1-9]|10)$'
    )
  );

-- ---------------------------------------------------------------------------
-- Help Centre
-- ---------------------------------------------------------------------------

UPDATE public.help_articles
SET body = replace(
      body,
      '<h2>Extra conditions</h2>',
      $g$<h2>Free gift with an order</h2>
<p>Choose <strong>Free gift</strong> as the reward, pick the product, and set a minimum order value — "a free tumbler on orders over ₹2,000".</p>
<p><strong>The gift is a real item, not a discount.</strong> It is added to the order at ₹0, its stock is reserved exactly as it would be if the customer had bought it, and it appears on the order, the invoice, the receipt and the confirmation email. That means your stock count stays correct — the unit you gave away is recorded as having left the shelf.</p>
<p><strong>The offer stops on its own when the gift runs out.</strong> Availability is checked before the offer is shown, so customers are never promised a gift you cannot send. When it is back in stock the offer resumes with no action from you.</p>
<p><strong>One gift per order</strong>, even if two gift offers would qualify — each one is real stock going out of the door.</p>
<p><strong>A gift applies alongside a discount, not instead of one.</strong> A customer can have 20% off from one offer and a free gift from another at the same time.</p>
<p>At the register, the till shows a <strong>"Hand over"</strong> line so the cashier knows to give the gift. Nothing in the totals changes, because the gift is free — the reminder is the whole point.</p>
<p><strong>Returns:</strong> if a customer returns the items they paid for, the gift is not automatically clawed back. Decide your own policy and tell customers what it is.</p>
<p><strong>⚠ Tax on free goods — check with your accountant.</strong> The gift line records the gift's own tax class, and because the value is zero the tax calculated is zero. Whether GST is actually due on a free item given with a sale, and whether input credit has to be reversed, depends on your circumstances. StoreMink records the figures; it does not advise on the treatment. Confirm it with a professional before relying on this in a return.</p>
<h2>Extra conditions</h2>$g$
    ),
    updated_at = now()
WHERE slug = 'create-and-manage-offers'
  AND status = 'published'
  AND body NOT LIKE '%<h2>Free gift with an order</h2>%';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.help_articles
    WHERE slug = 'create-and-manage-offers'
      AND status = 'published'
      AND body LIKE '%<h2>Free gift with an order</h2>%'
      AND body LIKE '%stops on its own when the gift runs out%'
      AND body LIKE '%check with your accountant%'
      AND body LIKE '%not automatically clawed back%'
  ) THEN
    RAISE EXCEPTION 'offers free-gift guidance was not installed';
  END IF;
END $$;
