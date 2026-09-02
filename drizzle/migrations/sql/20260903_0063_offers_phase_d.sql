-- Offers Phase D: spend-more-save-more and quantity ladders
-- (docs/offers-plan.md §4).
--
-- Additive. The Phase C allowlist is widened; every offer already created stays
-- valid and unchanged.

-- ★ REPLACED, NOT EDITED. 0062 is applied to both databases, so its CHECK is
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
      'buy_x_get_y',       -- buy N, get M discounted    (C)
      'tiered',            -- spend ladder, order level  (D)
      'volume_break'       -- quantity ladder, per item  (D)
    )
  );

-- ★★ A LADDER'S SHAPE IS ENFORCED IN THE DATABASE FOR THE SAME REASON
-- BUY-X-GET-Y'S IS: an empty or malformed ladder is not a weaker offer, it is
-- one the engine values at nothing while the merchant's list shows it active.
-- And the failure is quieter here than anywhere else in the feature, because a
-- ladder that resolves no rung looks exactly like a customer who simply did not
-- spend enough.
--
-- ★★ A TRIGGER, NOT A CHECK, AND NOT BY PREFERENCE. Validating a ladder means
-- examining every rung, which needs `jsonb_array_elements` — a set-returning
-- function, therefore a subquery, and **Postgres refuses a subquery in a CHECK
-- constraint** ("cannot use subquery in check constraint"). The alternative is
-- an IMMUTABLE helper called from a CHECK, which Postgres permits but does not
-- re-validate if the helper later changes, so it would claim more strength than
-- it has. This file already establishes a constraint trigger for the offer
-- shape rule below; ladders join it.
--
-- ★ IT NAMES THE OFFENDING RUNG. A merchant editing six numbers gets
-- "level 3" rather than a constraint name, and the server action's own
-- validation already caught it — this is the layer that stops a direct SQL
-- write from creating an offer the engine cannot price.
--
-- ⚠ Like the scope trigger, it fires on write only, so a malformed ladder
-- inserted before this migration (unreachable through the action) survives
-- until edited. Nothing can create one: `tiered` and `volume_break` were not
-- valid reward types until the statement above ran.
CREATE OR REPLACE FUNCTION public.offers_ladder_shape_valid()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_key      TEXT;
  v_at_key   TEXT;
  v_percent  BOOLEAN;
  v_rungs    JSONB;
  v_rung     JSONB;
  v_index    INT := 0;
  v_at       NUMERIC;
  v_value    NUMERIC;
BEGIN
  IF NEW.reward_type = 'tiered' THEN
    v_key := 'tiers';
    v_at_key := 'minSubtotal';
    -- Absent means percent, matching the application decoder. A ladder read as
    -- rupees when percentages were meant turns "10% off" into "₹10 off".
    IF coalesce(NEW.reward_config ->> 'tierMode', 'percent')
       NOT IN ('percent', 'amount') THEN
      RAISE EXCEPTION 'offer % has an unknown level type %',
        NEW.id, NEW.reward_config ->> 'tierMode';
    END IF;
    v_percent := coalesce(NEW.reward_config ->> 'tierMode', 'percent')
                 = 'percent';
  ELSIF NEW.reward_type = 'volume_break' THEN
    v_key := 'breaks';
    v_at_key := 'minQuantity';
    v_percent := TRUE;
  ELSE
    RETURN NULL;
  END IF;

  v_rungs := NEW.reward_config -> v_key;

  -- ★ THE TYPE IS ASSERTED BEFORE THE LENGTH. `jsonb_array_length` raises on a
  -- non-array and returns NULL for a missing key, and a NULL comparison would
  -- have PASSED silently in a CHECK — the same trap 0062 records for
  -- `buyQuantity`. Here it would mean an offer with no levels at all.
  IF v_rungs IS NULL OR jsonb_typeof(v_rungs) <> 'array' THEN
    RAISE EXCEPTION 'offer % is a % offer but lists no levels',
      NEW.id, NEW.reward_type;
  END IF;
  IF jsonb_array_length(v_rungs) < 1 OR jsonb_array_length(v_rungs) > 10 THEN
    RAISE EXCEPTION 'offer % must have between one and ten levels, not %',
      NEW.id, jsonb_array_length(v_rungs);
  END IF;

  FOR v_rung IN SELECT * FROM jsonb_array_elements(v_rungs)
  LOOP
    v_index := v_index + 1;

    IF jsonb_typeof(v_rung -> v_at_key) <> 'number' THEN
      RAISE EXCEPTION 'offer % level % has no %', NEW.id, v_index, v_at_key;
    END IF;
    -- A percentage ladder stores `value` for spend levels and `percent` for
    -- quantity levels, so both spellings are accepted and one must be present.
    IF jsonb_typeof(v_rung -> 'value') <> 'number'
       AND jsonb_typeof(v_rung -> 'percent') <> 'number' THEN
      RAISE EXCEPTION 'offer % level % has no discount', NEW.id, v_index;
    END IF;

    v_at := (v_rung ->> v_at_key)::numeric;
    v_value := coalesce(
      (v_rung ->> 'value')::numeric,
      (v_rung ->> 'percent')::numeric
    );

    IF v_value <= 0 THEN
      RAISE EXCEPTION 'offer % level % gives nothing', NEW.id, v_index;
    END IF;
    -- A percentage above 100 would price the item below zero.
    IF v_percent AND v_value > 100 THEN
      RAISE EXCEPTION 'offer % level % is more than 100%%', NEW.id, v_index;
    END IF;

    IF NEW.reward_type = 'tiered' THEN
      IF v_at < 0 THEN
        RAISE EXCEPTION 'offer % level % starts below zero', NEW.id, v_index;
      END IF;
    ELSE
      -- A rung at zero items is every basket, which is a plain per-item
      -- discount wearing a ladder's clothes; a fractional one cannot be
      -- reached by a quantity.
      IF v_at < 1 OR v_at <> trunc(v_at) THEN
        RAISE EXCEPTION 'offer % level % starts at % items, which is not a whole number of one or more',
          NEW.id, v_index, v_at;
      END IF;
    END IF;
  END LOOP;

  RETURN NULL;
END;
$fn$;

DROP TRIGGER IF EXISTS offers_ladder_shape_valid ON public.offers;
CREATE CONSTRAINT TRIGGER offers_ladder_shape_valid
  AFTER INSERT OR UPDATE OF reward_type, reward_config ON public.offers
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.offers_ladder_shape_valid();

-- A quantity ladder must say WHICH products, exactly as every other line-level
-- reward must: unscoped, "buy 6 or more for 10% off" counts an unrelated
-- mixture of everything in the shop and discounts all of it.
--
-- ★ `tiered` IS DELIBERATELY ABSENT from this list. It discounts the ORDER, so
-- its scope — when set — decides what QUALIFIES, not what is discounted, and
-- an unscoped spend ladder ("spend ₹2,000, save 15%") is the commonest and most
-- reasonable form of it. Adding it here would make the headline offer of the
-- whole phase impossible to create.
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
            'percent_off_items', 'fixed_price', 'buy_x_get_y', 'volume_break'
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

-- ---------------------------------------------------------------------------
-- Help Centre
-- ---------------------------------------------------------------------------

UPDATE public.help_articles
SET body = replace(
      body,
      '<h2>Conditions based on what is in the basket</h2>',
      $d$<h2>Spend more, save more</h2>
<p>Set several order values, each with a bigger discount. A customer gets the highest level their order reaches — never two levels added together. A ladder of 5% over ₹1,000, 10% over ₹2,500 and 15% over ₹5,000 gives a ₹3,000 order 10%, not 15%.</p>
<p>Levels are judged on the order total <em>before</em> any discount, so reaching a level can never push the order back below it.</p>
<p>Each level has to give more than the one below it. A higher level worth the same or less would simply never apply, and the offer will not save until you correct it.</p>
<p>You can build the ladder in percentages or in rupees, but not both in one offer.</p>
<h2>Buy more, save more</h2>
<p>Set several quantities, each with a bigger percentage. Choose the products or categories it covers, and items are counted <strong>together</strong> across those choices — six of one flavour and six of another reach a twelve-item level between them.</p>
<p>Once a level is reached, <strong>every</strong> one of those items is discounted, not only the ones above the number. On "6 or more, 10% off", a basket of six gets 10% off all six.</p>
<p>Because the level depends on how many are in the basket, a product page cannot show this as a per-item saving — the discount appears in the basket once the quantity is reached. Customers are told how many more they need as they get close.</p>
<h2>Conditions based on what is in the basket</h2>$d$
    ),
    updated_at = now()
WHERE slug = 'create-and-manage-offers'
  AND status = 'published'
  AND body NOT LIKE '%<h2>Spend more, save more</h2>%';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.help_articles
    WHERE slug = 'create-and-manage-offers'
      AND status = 'published'
      AND body LIKE '%<h2>Spend more, save more</h2>%'
      AND body LIKE '%<h2>Buy more, save more</h2>%'
      AND body LIKE '%never two levels added together%'
      AND body LIKE '%counted <strong>together</strong> across those choices%'
  ) THEN
    RAISE EXCEPTION 'offers ladder guidance was not installed';
  END IF;
END $$;
