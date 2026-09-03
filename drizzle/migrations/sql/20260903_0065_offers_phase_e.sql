-- Offers Phase E: the extra conditions (docs/offers-plan.md §5, §19).
--
-- Additive in the strongest sense: the column defaults to an empty array, so
-- every offer already created carries no conditions and behaves exactly as it
-- did. Nothing is backfilled, because "no extra requirements" is the honest
-- description of every existing row.

-- ★★ A LIST, NOT MORE `trigger_type` VALUES, and the offer merchants actually
-- want is the reason. "₹50 off prepaid orders over ₹500" is the commonest form
-- of a payment-method offer, and as alternative trigger types it is
-- inexpressible — you would have to pick between the threshold and the payment
-- rule. The primary trigger stays the shape the merchant chose from the preset
-- list; a condition refines it.
--
-- ★ EVERY CONDITION MUST HOLD (AND, never OR). An OR needs grouping and
-- precedence, and a merchant reading their own offer back could not tell which
-- they had built. Two alternatives are two offers, which best-offer-wins
-- already resolves correctly.
ALTER TABLE public.offers
  ADD COLUMN IF NOT EXISTS conditions JSONB NOT NULL DEFAULT '[]'::jsonb;

-- ★★ THE SHAPE IS ENFORCED HERE FOR ONE REASON ABOVE ALL: a condition is a
-- RESTRICTION, so a malformed one is not a weaker offer — it is an offer that
-- either dies silently or, if the reader were lenient, discounts everybody.
-- `decodeConditions` refuses to run an offer whose conditions it cannot parse
-- (fail closed), and this constraint stops such a row existing in the first
-- place.
--
-- ★★ COALESCED THROUGHOUT. A CHECK is SATISFIED when it evaluates to NULL, so
-- `jsonb_array_length(conditions) <= 4` accepts a row where `conditions` is a
-- non-array and `jsonb_typeof(...)` alone accepts an absent key. This is the
-- third recurrence of that trap in this feature (0062 in a CHECK, 0063/0064 in
-- plpgsql); the type is asserted FIRST and every branch is written so an absent
-- or wrong-typed value FAILS.
--
-- Per-element validation needs `jsonb_array_elements`, which is a subquery and
-- therefore illegal in a CHECK ("cannot use subquery in check constraint" —
-- 0063 records the same wall), so the element rules live in the trigger below.
-- What stays here is what a scalar expression can honestly assert.
ALTER TABLE public.offers
  ADD CONSTRAINT offers_conditions_shape_check CHECK (
    jsonb_typeof(conditions) = 'array'
    AND jsonb_array_length(conditions) <= 4
  );

-- ★ ONE OF EACH KIND, AND THE ELEMENT RULES.
--
-- Two payment-method conditions would have to be ANDed, and the intersection of
-- two allowlists is either one of them or empty — so the second is at best
-- redundant and at worst silently kills the offer.
--
-- ★★ AND THE WEBSITE-ONLY RULE IS ENFORCED IN THE DATABASE, not only in the
-- server action. `payment_method` cannot work at a register: `lib/pos/totals.ts`
-- exists because the till screen and `placePosSale` must agree on ONE total
-- (CODEBASE §22), and the till's flow is total-THEN-tender — the cashier reads
-- the total, then stages payment against it. A discount that depended on the
-- tender would change the total after it had been quoted to the customer.
-- `fulfilment_type` cannot work there either, for a plainer reason: a register
-- sale is neither a delivery nor a collection, and `orders.fulfilment_type`
-- carries the legacy `delivery` default for POS rows that never meant a courier
-- promise. Both are refused for a POS-inclusive offer rather than saved and
-- silently never matching, which is §23's rule that a control which always
-- fails is worse than no control.
--
-- ⚠ Fires on INSERT and on an UPDATE touching `conditions` or `channels` —
-- BOTH, because widening an existing website-only offer to the register is
-- exactly how a saved condition becomes unenforceable.
CREATE OR REPLACE FUNCTION public.offers_conditions_valid()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_cond      JSONB;
  v_type      TEXT;
  v_seen      TEXT[] := ARRAY[]::TEXT[];
  v_index     INT := 0;
  v_reaches_pos BOOLEAN;
  v_start     NUMERIC;
  v_end       NUMERIC;
  v_day       JSONB;
BEGIN
  IF jsonb_array_length(NEW.conditions) = 0 THEN
    RETURN NULL;
  END IF;

  -- An empty channel list means every channel, so it includes the register.
  v_reaches_pos := coalesce(array_length(NEW.channels, 1), 0) = 0
                   OR 'pos' = ANY (NEW.channels);

  FOR v_cond IN SELECT * FROM jsonb_array_elements(NEW.conditions)
  LOOP
    v_index := v_index + 1;
    v_type := v_cond ->> 'type';

    IF v_type IS NULL
       OR v_type NOT IN ('payment_method', 'fulfilment_type',
                         'first_order', 'time_window') THEN
      RAISE EXCEPTION 'offer % condition % has an unknown type %',
        NEW.id, v_index, coalesce(v_type, '(none)');
    END IF;

    IF v_type = ANY (v_seen) THEN
      RAISE EXCEPTION 'offer % lists the % condition more than once',
        NEW.id, v_type;
    END IF;
    v_seen := v_seen || v_type;

    IF v_reaches_pos AND v_type IN ('payment_method', 'fulfilment_type') THEN
      RAISE EXCEPTION
        'offer % uses the % condition, which only works on the website, but is not limited to the storefront channel',
        NEW.id, v_type;
    END IF;

    IF v_type = 'payment_method' THEN
      -- An empty allowlist is a condition that can never hold, which makes the
      -- offer dead rather than unrestricted.
      IF coalesce(jsonb_typeof(v_cond -> 'methods'), '') <> 'array'
         OR jsonb_array_length(v_cond -> 'methods') = 0 THEN
        RAISE EXCEPTION 'offer % names no payment method', NEW.id;
      END IF;
      IF EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(v_cond -> 'methods') AS m
        WHERE m.value NOT IN ('cod', 'razorpay', 'pay_at_store')
      ) THEN
        RAISE EXCEPTION 'offer % names an unknown payment method', NEW.id;
      END IF;

    ELSIF v_type = 'fulfilment_type' THEN
      IF coalesce(jsonb_typeof(v_cond -> 'fulfilment'), '') <> 'array'
         OR jsonb_array_length(v_cond -> 'fulfilment') = 0 THEN
        RAISE EXCEPTION 'offer % names no delivery or pickup', NEW.id;
      END IF;
      IF EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(v_cond -> 'fulfilment') AS f
        WHERE f.value NOT IN ('delivery', 'pickup')
      ) THEN
        RAISE EXCEPTION 'offer % names an unknown fulfilment type', NEW.id;
      END IF;

    ELSIF v_type = 'time_window' THEN
      IF coalesce(jsonb_typeof(v_cond -> 'days'), '') <> 'array'
         OR jsonb_array_length(v_cond -> 'days') = 0 THEN
        RAISE EXCEPTION 'offer % time window names no days', NEW.id;
      END IF;
      FOR v_day IN SELECT * FROM jsonb_array_elements(v_cond -> 'days')
      LOOP
        IF coalesce(jsonb_typeof(v_day), '') <> 'number'
           OR (v_day #>> '{}')::numeric NOT BETWEEN 0 AND 6
           OR (v_day #>> '{}')::numeric <> trunc((v_day #>> '{}')::numeric) THEN
          RAISE EXCEPTION 'offer % time window has a day outside 0-6', NEW.id;
        END IF;
      END LOOP;

      IF coalesce(jsonb_typeof(v_cond -> 'startMinute'), '') <> 'number'
         OR coalesce(jsonb_typeof(v_cond -> 'endMinute'), '') <> 'number' THEN
        RAISE EXCEPTION 'offer % time window has no start or end', NEW.id;
      END IF;
      v_start := (v_cond ->> 'startMinute')::numeric;
      v_end := (v_cond ->> 'endMinute')::numeric;
      IF v_start < 0 OR v_start >= 1440 OR v_end < 0 OR v_end >= 1440
         OR v_start <> trunc(v_start) OR v_end <> trunc(v_end) THEN
        RAISE EXCEPTION 'offer % time window is outside a day', NEW.id;
      END IF;
      -- Equal start and end is an empty window, not an all-day one. All day is
      -- expressed by having no time condition at all.
      IF v_start = v_end THEN
        RAISE EXCEPTION 'offer % time window starts and ends at the same minute',
          NEW.id;
      END IF;
    END IF;
    -- `first_order` carries no payload; its presence IS the condition.
  END LOOP;

  RETURN NULL;
END;
$fn$;

DROP TRIGGER IF EXISTS offers_conditions_valid ON public.offers;
CREATE CONSTRAINT TRIGGER offers_conditions_valid
  AFTER INSERT OR UPDATE OF conditions, channels ON public.offers
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.offers_conditions_valid();

-- ---------------------------------------------------------------------------
-- Help Centre
-- ---------------------------------------------------------------------------

UPDATE public.help_articles
SET body = replace(
      body,
      '<h2>Conditions based on what is in the basket</h2>',
      $e$<h2>Extra conditions</h2>
<p>Any offer can carry extra requirements on top of its main rule. <strong>All of them must be true</strong> for the offer to apply — they narrow it, they never widen it. If you want either of two situations to qualify, make two offers; the best one for the customer is chosen automatically.</p>
<ul>
<li><strong>Payment method</strong> — for example ₹50 off when the customer pays online rather than cash on delivery. Website only (see below).</li>
<li><strong>Delivery or pickup</strong> — for example 5% off orders collected from a shop. Website only.</li>
<li><strong>First order only</strong> — applies to a customer's first order with you. It requires a signed-in customer, because there is no order history to check for a guest, so a guest checkout will not qualify.</li>
<li><strong>Days and times</strong> — a happy hour, or a weekend offer. Choose the days and a start and end time.</li>
</ul>
<p><strong>Times use your store's timezone</strong>, not the customer's, so the window means the same thing to everyone. Set your timezone in Settings. A window that ends earlier than it starts runs past midnight — "Friday, 10pm to 2am" is one four-hour evening that reaches into Saturday morning, and it counts as Friday's offer. For all day, simply leave the time condition off rather than setting the same start and end.</p>
<p><strong>Payment method and delivery/pickup work on your website only</strong>, and an offer using them has to be set to your website. At the register the total is shown before payment is taken, so it cannot change once a method is chosen; and a register sale is neither a delivery nor a collection. You will be told if you try to save one for the register.</p>
<p>A customer is never told they are close to an offer they cannot have. If an offer is blocked by one of these conditions, no "spend a little more" message appears for it.</p>
<h2>Conditions based on what is in the basket</h2>$e$
    ),
    updated_at = now()
WHERE slug = 'create-and-manage-offers'
  AND status = 'published'
  AND body NOT LIKE '%<h2>Extra conditions</h2>%';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.help_articles
    WHERE slug = 'create-and-manage-offers'
      AND status = 'published'
      AND body LIKE '%<h2>Extra conditions</h2>%'
      AND body LIKE '%<strong>All of them must be true</strong>%'
      AND body LIKE '%use your store''s timezone%'
      AND body LIKE '%one four-hour evening that reaches into Saturday morning%'
      AND body LIKE '%work on your website only%'
  ) THEN
    RAISE EXCEPTION 'offers extra-condition guidance was not installed';
  END IF;
END $$;
