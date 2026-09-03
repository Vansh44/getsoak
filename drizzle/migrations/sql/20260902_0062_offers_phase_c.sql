-- Offers Phase C: buy X get Y (docs/offers-plan.md §4).
--
-- Additive. The Phase B allowlist is widened; every offer already created stays
-- valid and unchanged.

-- ★ REPLACED, NOT EDITED. 0061 is applied to both databases, so its CHECK is
-- immutable. Both statements run in one transaction, so there is no window in
-- which an arbitrary reward type is insertable.
ALTER TABLE public.offers
  DROP CONSTRAINT offers_reward_type_check,
  ADD CONSTRAINT offers_reward_type_check CHECK (
    reward_type IN (
      'percent_off',       -- % off the order            (A)
      'amount_off',        -- ₹ off the order            (A)
      'percent_off_items', -- % off matching lines       (B)
      'fixed_price',       -- each matching item at ₹X   (B)
      'buy_x_get_y'        -- buy N, get M discounted    (C)
    )
  );

-- ★ THE SHAPE OF A BUY-X-GET-Y CONFIG IS ENFORCED HERE, not only in the server
-- action. A row with a missing or zero quantity is not a weaker offer — it is
-- an offer the engine values at nothing while the merchant's list shows it as
-- active, which is the most confusing possible outcome. `maxSets` stays
-- optional because absent genuinely means "no limit".
-- ★★ EVERY REQUIRED KEY IS COALESCED, and that is not defensive noise — it is
-- the difference between this constraint working and doing nothing. A CHECK is
-- SATISFIED when it evaluates to NULL, and `(config ->> 'buyQuantity') ~ '…'`
-- is NULL when the key is ABSENT. So the obvious spelling accepts a
-- buy-X-get-Y row with no quantities at all: the engine values it at zero
-- while the merchant's list shows it active, which is the most confusing
-- possible outcome. Caught by running this against a real Postgres, not by
-- reading it. `coalesce(…, '')` turns a missing key into a value the pattern
-- rejects. The two OPTIONAL keys keep an explicit `IS NULL` branch, because
-- for them absent genuinely means "no limit".
ALTER TABLE public.offers
  ADD CONSTRAINT offers_bxgy_shape_check CHECK (
    reward_type <> 'buy_x_get_y'
    OR (
      coalesce(reward_config ->> 'buyQuantity', '') ~ '^([1-9][0-9]?|100)$'
      AND coalesce(reward_config ->> 'getQuantity', '') ~ '^([1-9][0-9]?|100)$'
      AND (
        reward_config ->> 'getPercent' IS NULL
        OR (reward_config ->> 'getPercent') ~ '^([1-9][0-9]?|100)$'
      )
      AND (
        reward_config ->> 'maxSets' IS NULL
        OR (reward_config ->> 'maxSets') ~ '^[1-9][0-9]*$'
      )
    )
  );

-- A buy-X-get-Y offer must say WHICH products, for the same reason a contents
-- condition must: unscoped, "buy 1 get 1" means the cheapest item in ANY basket
-- of two is free, across the whole catalogue. The trigger is widened to cover
-- every line-level reward, which the server action already refuses to create
-- unscoped — this makes the database agree rather than trusting one layer.
--
-- ⚠ It fires on INSERT and on an UPDATE that touches trigger_type or
-- reward_type, so an unscoped line-level offer created before this migration
-- (only reachable by direct SQL, since the action refuses it) keeps working
-- until somebody edits it, and is refused at that point. Pausing one is
-- unaffected: `setOfferStatus` writes only `status`.
CREATE OR REPLACE FUNCTION public.offers_contents_trigger_needs_scope()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF (
       NEW.trigger_type IN ('contains_product', 'contains_category')
       OR NEW.reward_type IN ('percent_off_items', 'fixed_price', 'buy_x_get_y')
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.offer_products p WHERE p.offer_id = NEW.id
     )
  THEN
    RAISE EXCEPTION
      'offer % applies to particular items but scopes no product, variant or category',
      NEW.id;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS offers_contents_trigger_needs_scope ON public.offers;
CREATE CONSTRAINT TRIGGER offers_contents_trigger_needs_scope
  AFTER INSERT OR UPDATE OF trigger_type, reward_type ON public.offers
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.offers_contents_trigger_needs_scope();

-- ---------------------------------------------------------------------------
-- Help Centre
-- ---------------------------------------------------------------------------

UPDATE public.help_articles
SET body = replace(
      body,
      '<h2>Conditions based on what is in the basket</h2>',
      $c$<h2>Buy one get one, and similar</h2>
<p>Choose how many a customer buys and how many they then get, and whether those are free or reduced. "Buy 1 get 1 free", "buy 2 get 1 free" and "buy 1 get 1 half price" are all the same offer with different numbers.</p>
<p>Three details decide what customers actually receive, and they are the ones most often misjudged:</p>
<ul>
<li><strong>A set is the buy count plus the get count.</strong> On buy 1 get 1, two items are one set and three items are still one set — the third is charged normally until a fourth completes the next set.</li>
<li><strong>The cheapest qualifying items are the discounted ones.</strong> This is the usual retail practice and it is what "three for the price of two" means.</li>
<li><strong>Items are counted across the basket, not per line.</strong> Three different products from the same category can complete one set between them.</li>
</ul>
<p>Set a <strong>limit on sets per order</strong> unless you mean the offer to repeat without end. Without one, a basket of twenty items on buy 1 get 1 gives ten away.</p>
<p>When a basket is one item short of a set, the cart says so.</p>
<h2>Conditions based on what is in the basket</h2>$c$
    ),
    updated_at = now()
WHERE slug = 'create-and-manage-offers'
  AND status = 'published'
  AND body NOT LIKE '%<h2>Buy one get one, and similar</h2>%';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.help_articles
    WHERE slug = 'create-and-manage-offers'
      AND status = 'published'
      AND body LIKE '%<h2>Buy one get one, and similar</h2>%'
      AND body LIKE '%A set is the buy count plus the get count%'
      AND body LIKE '%cheapest qualifying items are the discounted ones%'
      AND body LIKE '%counted across the basket, not per line%'
      AND body LIKE '%gives ten away%'
  ) THEN
    RAISE EXCEPTION 'buy X get Y guidance was not installed';
  END IF;
END $$;
