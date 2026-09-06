-- What a shopper is told about an offer, and where.
--
-- Three storefront changes ship with this, and the guide has to describe all
-- three because each one was a place an offer was silently invisible:
--
--   • THE CHECKOUT SUMMARY SHOWS THE DISCOUNT. `useCartOffers` was wired to
--     the near-miss nudge alone, and the order total was
--     `cart.total + shipping` where `cart.total` is `subtotal − couponDiscount`
--     — `CartProvider` has never known offers exist. So an automatic offer was
--     neither shown nor subtracted, while `placeOrder` applied it: the summary
--     read ₹140 and the server charged ₹70. Nobody was overcharged, but the
--     figure on screen disagreed with the order, and the offer was invisible at
--     exactly the moment it is meant to persuade.
--
--   • PRODUCTS CARRY AN OFFER TAG. The only marker was a PRICE badge, which
--     prices one unit — correct, and the reason buy-X-get-Y, bundles and
--     quantity breaks showed nothing at all: none of them is a claim about
--     buying one. A terms tag ("Buy 1, get 1 free") is honest at any quantity.
--     The product page had no marker of any kind.
--
--   • THE "ADD ONE MORE" NUDGE STOPS LYING ABOUT A SPENT SET CAP. It ignored
--     `maxSets`, so "buy 1 get 1 free, max 1 set" told a shopper holding three
--     to add a fourth, which earned nothing.
UPDATE public.help_articles
SET body = replace(
      body,
      '<h2>What shoppers see</h2>',
      $h$<h2>What shoppers see</h2>
<p>An offer that applies shows up in three places, and you do not have to set any of them up.</p>
<p><strong>On product cards and product pages.</strong> Where an offer takes a straightforward amount off one item, the product shows the saving — "20% off". Where the offer is about buying more than one — buy X get Y, a bundle price, or a quantity break — there is no single-item saving to quote, so the product shows the offer's terms instead: "Buy 1, get 1 free". Either way it is checked against the real rules first, so a product never advertises an offer the basket would then refuse. Turn both off with <strong>Show offer badges on your storefront</strong> in Settings.</p>
<p><strong>In the cart, when a shopper is close.</strong> If they hold one of something on a buy-1-get-1, they are told "Add 1 more and one is free". This is switched off with <strong>Tell shoppers when they are close to an offer</strong>. It is never shown for an offer that needs a discount code or is limited to a customer group, because that would leak targeting you set deliberately. It also stops once your <strong>Max sets per order</strong> limit is reached, since a further item would earn nothing.</p>
<p><strong>On the checkout summary.</strong> The discount appears as its own line, named after the offer, above the total — so the customer can see why the basket got cheaper, and the figure matches what they are charged. Free delivery and a free gift appear as their own lines rather than as money off, because neither changes what the goods cost.</p>$h$
    ),
    updated_at = now()
WHERE slug = 'create-and-manage-offers'
  AND status = 'published'
  AND body NOT LIKE '%On product cards and product pages.%';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.help_articles
    WHERE slug = 'create-and-manage-offers'
      AND status = 'published'
      AND body LIKE '%On product cards and product pages.%'
      AND body LIKE '%Add 1 more and one is free%'
      AND body LIKE '%named after the offer%'
      AND body LIKE '%Max sets per order%'
  ) THEN
    RAISE EXCEPTION 'offers storefront-visibility guidance was not installed';
  END IF;
END $$;
