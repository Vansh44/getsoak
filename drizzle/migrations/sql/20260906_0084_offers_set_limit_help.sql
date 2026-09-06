-- Explain what a buy-X-get-Y offer does to a BIGGER basket.
--
-- ★★ THE GUIDE NEVER SAID, AND THE FORM QUIETLY DECIDED. `Max sets per order`
-- defaulted to 1 in a field whose placeholder reads "No limit", so every
-- buy-X-get-Y offer arrived capped at one set: a merchant building "Buy 1, get
-- 1 free" and putting four items in a basket got ONE free, not two. The offer
-- stopped meaning what its own name says, with nothing on screen to explain it,
-- and nothing in Help to check it against.
--
-- The default is blank now, so the offer repeats as the basket allows. The
-- guard rail it was reaching for — an uncapped buy-1-get-1 giving away half a
-- large basket — belongs to the BUDGET, which bounds exposure in rupees
-- instead of silently redefining the offer.
UPDATE public.help_articles
SET body = replace(
      body,
      '<h2>Extra conditions</h2>',
      $h$<h2>How far a buy X get Y offer repeats</h2>
<p><strong>By default it repeats for as long as the basket allows.</strong> On "buy 1, get 1 free", four items means the customer pays for two and two are free; six means they pay for three. That is what the offer's name promises, so it is what it does.</p>
<p>Items are counted across the whole basket, not per line — two of one flavour and two of another still make two sets. The <strong>cheapest</strong> qualifying items are the ones discounted, which is the customer-friendly reading and the one that can never charge more than the goods were worth.</p>
<p><strong>Max sets per order</strong> caps it. Leave it blank unless you specifically mean "one free item per order, however many they buy" — with it set to 1, a basket of four earns exactly one free item, and a shopper who added a fourth expecting two will be charged for three.</p>
<p><strong>To limit what you give away, use a total budget instead.</strong> A budget under Limits stops the offer once it has given away the amount you set, across every order. It bounds your cost directly, where a set limit bounds each basket and changes what the offer means. The same applies to bundle offers and their <strong>Max bundles per order</strong>.</p>
<h2>Extra conditions</h2>$h$
    ),
    updated_at = now()
WHERE slug = 'create-and-manage-offers'
  AND status = 'published'
  AND body NOT LIKE '%<h2>How far a buy X get Y offer repeats</h2>%';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.help_articles
    WHERE slug = 'create-and-manage-offers'
      AND status = 'published'
      AND body LIKE '%<h2>How far a buy X get Y offer repeats</h2>%'
      AND body LIKE '%By default it repeats for as long as the basket allows%'
      AND body LIKE '%use a total budget instead%'
  ) THEN
    RAISE EXCEPTION 'offers set-limit guidance was not installed';
  END IF;
END $$;
