-- Require a bundle offer to name the items it bundles.
--
-- ★★ CAUGHT BY A TEST, NOT BY REVIEW. `bundle_price` was first classified as an
-- ORDER-level reward, and every bundle case then returned a discount of zero:
-- the group claim is reached only through the LINE candidate list, so the
-- bundle never ran and `claimOrderOffer` treated it as a rupee amount with no
-- amount set. Reclassifying it as line-level fixed that — and made this
-- migration necessary, because a line-level reward's scope is what it
-- discounts. Unscoped, "any 3 for ₹999" would bundle any three items in the
-- whole catalogue, at whatever the dearest three happen to be.
--
-- 0068 is applied to both databases, so its trigger function is replaced here
-- rather than edited. Nothing else about the rule changes.
--
-- ⚠ `free_item`, `credit_back` and `free_shipping` are deliberately NOT in this
-- list. A gift names its product in the reward itself, and the other two touch
-- no line at all — requiring a scope from them would make three working
-- rewards unsaveable.
CREATE OR REPLACE FUNCTION public.offers_contents_trigger_needs_scope()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF (
       NEW.trigger_type IN ('contains_product', 'contains_category')
       OR NEW.reward_type IN (
            'percent_off_items', 'fixed_price', 'buy_x_get_y',
            'volume_break', 'bundle_price'
          )
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
