-- Offers Phase F: free delivery as a reward (docs/offers-plan.md §14, §16).
--
-- Additive. The Phase E allowlist is widened; every offer already created stays
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
      'free_shipping'      -- delivery charge waived     (F)
    )
  );

-- ★★ FREE DELIVERY CANNOT APPLY AT A REGISTER, so an offer using it may not
-- include the POS channel. Not because it is unfinished: a register sale has no
-- delivery charge at all — the customer is standing there holding the goods —
-- so there is nothing for the reward to act on. Refused rather than saved and
-- silently never firing, which is §23's rule that a control that always fails
-- is worse than no control.
--
-- ⚠ An EMPTY channel list means every channel, so it includes POS. That is the
-- case the application-layer check exists for too, and the one most easily
-- missed: a merchant who simply never touched the channel picker.
--
-- Fires on INSERT and on an UPDATE touching either column, because widening a
-- website-only offer to the register is exactly how a saved reward becomes
-- undeliverable.
CREATE OR REPLACE FUNCTION public.offers_reward_channel_fit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  IF NEW.reward_type = 'free_shipping'
     AND (
       coalesce(array_length(NEW.channels, 1), 0) = 0
       OR 'pos' = ANY (NEW.channels)
     )
  THEN
    RAISE EXCEPTION
      'offer % gives free delivery, which only applies to website orders, but is not limited to the storefront channel',
      NEW.id;
  END IF;
  RETURN NULL;
END;
$fn$;

DROP TRIGGER IF EXISTS offers_reward_channel_fit ON public.offers;
CREATE CONSTRAINT TRIGGER offers_reward_channel_fit
  AFTER INSERT OR UPDATE OF reward_type, channels ON public.offers
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.offers_reward_channel_fit();

-- ---------------------------------------------------------------------------
-- Help Centre
-- ---------------------------------------------------------------------------

UPDATE public.help_articles
SET body = replace(
      body,
      '<h2>Extra conditions</h2>',
      $f$<h2>Free delivery</h2>
<p>Choose <strong>Free delivery</strong> as the reward, usually with a minimum order value — "free delivery over ₹500" is one offer, and the most common one there is.</p>
<p><strong>It only ever makes delivery cheaper.</strong> Your standing delivery settings still apply, and the customer is charged the lower of the two. So if your settings already give free delivery over ₹999 and you run an offer for free delivery over ₹500, you have temporarily lowered your threshold to ₹500 — a ₹1,200 order still ships free, and a ₹600 order now does too. An offer can never raise a delivery charge.</p>
<p><strong>Free delivery applies alongside a discount, not instead of one.</strong> Unlike two discounts, where the best one is chosen, delivery is a separate part of the bill — a customer can have 20% off <em>and</em> free delivery from two different offers at the same time.</p>
<p><strong>⚠ You still pay the courier.</strong> If your delivery rates come from Shiprocket, the price is quoted live from the carrier, and a free-delivery offer sets the <em>customer's</em> charge to zero while your own courier cost is unchanged. That cost does not appear anywhere on the order, so it is easy to miss: check what you normally pay for delivery before setting the minimum order value, and set a budget on the offer if you want a ceiling on the total given away.</p>
<p>Free delivery is a website offer. A register sale has nothing to deliver, so an offer using it must be set to your website — you will be told if you try to save one for the register.</p>
<p>Customers who are close to qualifying are told how much more to add, which is what makes this offer work. See "Telling customers they are close" below.</p>
<h2>Extra conditions</h2>$f$
    ),
    updated_at = now()
WHERE slug = 'create-and-manage-offers'
  AND status = 'published'
  AND body NOT LIKE '%<h2>Free delivery</h2>%';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.help_articles
    WHERE slug = 'create-and-manage-offers'
      AND status = 'published'
      AND body LIKE '%<h2>Free delivery</h2>%'
      AND body LIKE '%only ever makes delivery cheaper%'
      AND body LIKE '%alongside a discount, not instead of one%'
      AND body LIKE '%You still pay the courier%'
  ) THEN
    RAISE EXCEPTION 'offers free-delivery guidance was not installed';
  END IF;
END $$;
