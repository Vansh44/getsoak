-- Offers Phase B: rewards that apply to particular products, and conditions
-- that qualify on what is IN the cart (docs/offers-plan.md §4, §5).
--
-- Additive only. The Phase A allowlists are widened, so every offer already
-- created stays valid and unchanged.

-- ---------------------------------------------------------------------------
-- 1. Widen the rule allowlists
-- ---------------------------------------------------------------------------
--
-- ★ REPLACED, NOT EDITED. 0059 is applied to both databases, so its CHECK is
-- immutable; a new constraint replaces it under the same name in one
-- transaction. Dropping without adding back in the same statement batch would
-- leave a window where any reward type is insertable.

ALTER TABLE public.offers
  DROP CONSTRAINT offers_reward_type_check,
  ADD CONSTRAINT offers_reward_type_check CHECK (
    reward_type IN (
      'percent_off',       -- % off the order            (A)
      'amount_off',        -- ₹ off the order            (A)
      'percent_off_items', -- % off matching lines       (B)
      'fixed_price'        -- each matching item at ₹X   (B)
    )
  );

ALTER TABLE public.offers
  DROP CONSTRAINT offers_trigger_type_check,
  ADD CONSTRAINT offers_trigger_type_check CHECK (
    trigger_type IN (
      'always',            -- any order                          (A)
      'min_subtotal',      -- order value over ₹X                (A)
      'contains_product',  -- the cart holds a scoped product    (B)
      'contains_category'  -- the cart holds a scoped category   (B)
    )
  );

-- ★ A CONTENTS TRIGGER WITHOUT A SCOPE IS SILENTLY `always`, on an offer built
-- expressly to be selective — so the database refuses it too, not just the
-- server action. Deferred to COMMIT because the scope rows are inserted after
-- the offer row in the same transaction; an immediate constraint would refuse
-- every legitimate create.
CREATE OR REPLACE FUNCTION public.offers_contents_trigger_needs_scope()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF NEW.trigger_type IN ('contains_product', 'contains_category')
     AND NOT EXISTS (
       SELECT 1 FROM public.offer_products p WHERE p.offer_id = NEW.id
     )
  THEN
    RAISE EXCEPTION
      'offer % uses a contents condition but scopes no product, variant or category',
      NEW.id;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER offers_contents_trigger_needs_scope
  AFTER INSERT OR UPDATE OF trigger_type ON public.offers
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.offers_contents_trigger_needs_scope();

-- ---------------------------------------------------------------------------
-- 2. Scope lookups the engine's candidate resolution makes on every cart
-- ---------------------------------------------------------------------------
--
-- `loadLiveOffers` reads offer_products for every live offer per cart. The
-- unique indexes 0059 created are keyed (offer_id, …) and already serve that,
-- but the STOREFRONT badge path asks the reverse question — "which offers
-- cover this product?" — once per product card.

CREATE INDEX IF NOT EXISTS offer_products_product_lookup_idx
  ON public.offer_products (store_id, product_id) WHERE product_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS offer_products_variant_lookup_idx
  ON public.offer_products (store_id, variant_id) WHERE variant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS offer_products_category_lookup_idx
  ON public.offer_products (store_id, category_id) WHERE category_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Help Centre
-- ---------------------------------------------------------------------------

UPDATE public.help_articles
SET body = replace(
      body,
      '<h2>Best offer wins</h2>',
      $b$<h2>Offers on particular products</h2>
<p>An offer does not have to apply to the whole order. Choose the products, variants or categories it covers and it will discount only those lines.</p>
<p>There are two shapes, and the one you pick decides what the customer sees:</p>
<ul>
<li><strong>A percentage off the chosen items</strong> — for example 20% off everything in one category.</li>
<li><strong>A set price per item</strong> — for example any t-shirt at ₹499. An item already cheaper than that is left alone; a set price never raises a price to meet the offer.</li>
</ul>
<h2>Conditions based on what is in the basket</h2>
<p>You can also require the basket to contain something before an order-level offer applies — "10% off your order when it includes a shake". Choose the products or categories in the same place, and they decide what qualifies.</p>
<p>The difference is worth knowing, because it is easy to pick the wrong one:</p>
<ul>
<li>An offer that takes a percentage <strong>off the chosen items</strong> discounts only those items.</li>
<li>An offer that takes a percentage <strong>off the order</strong> and requires those items discounts the <strong>whole</strong> basket once it qualifies.</li>
</ul>
<h2>Best offer wins</h2>$b$
    ),
    updated_at = now()
WHERE slug = 'create-and-manage-offers'
  AND status = 'published'
  AND body NOT LIKE '%<h2>Offers on particular products</h2>%';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.help_articles
    WHERE slug = 'create-and-manage-offers'
      AND status = 'published'
      AND body LIKE '%<h2>Offers on particular products</h2>%'
      AND body LIKE '%never raises a price to meet the offer%'
      AND body LIKE '%discounts the <strong>whole</strong> basket once it qualifies%'
  ) THEN
    RAISE EXCEPTION 'offers product-scoping guidance was not installed';
  END IF;
END $$;
