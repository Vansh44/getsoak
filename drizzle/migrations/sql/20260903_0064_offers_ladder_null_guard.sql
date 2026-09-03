-- Refuse a ladder rung that carries no discount.
--
-- ★★ THE SAME NULL TRAP AS 0062, IN A DIFFERENT LANGUAGE, AND IT GOT THROUGH.
-- 0062 records that a CHECK constraint is SATISFIED when it evaluates to NULL,
-- so `(config ->> 'buyQuantity') ~ '…'` accepts a missing key. 0063's trigger
-- avoided that by moving to plpgsql — and then reproduced it exactly:
--
--   IF jsonb_typeof(rung -> 'value')       <> 'number'
--      AND jsonb_typeof(rung -> 'percent') <> 'number' THEN
--
-- `jsonb_typeof` returns NULL for an absent key, `NULL <> 'number'` is NULL,
-- `NULL AND NULL` is NULL, and **plpgsql treats a NULL condition as false** —
-- so the branch never ran. `{"tiers":[{"minSubtotal":1000}]}` was accepted: a
-- spend ladder with a threshold and no discount, which the engine prices at
-- nothing while the offers list shows the offer active. The follow-on
-- `v_value <= 0` guard could not catch it either, because `coalesce` of two
-- NULLs is NULL and `NULL <= 0` is NULL as well. Two guards, one value, both
-- bypassed.
--
-- Found by INSERTing thirteen deliberately malformed ladders against a real
-- Postgres and reading which were accepted — not by reading the code, which
-- looks correct. That probe is the only reason this is a follow-up migration
-- rather than a defect in production.
--
-- ★ THE RULE, now twice learned: in SQL and in plpgsql alike, never let an
-- absent key reach a comparison. `coalesce(jsonb_typeof(x), '')` turns it into
-- a value that fails.
--
-- Replaces 0063's function body and nothing else. The trigger, its timing and
-- every other rule are untouched, and no existing row can be affected because
-- `tiered` and `volume_break` became insertable only in 0063.

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

  -- The type is asserted before the length: `jsonb_array_length` raises on a
  -- non-array and returns NULL for a missing key.
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

    -- ★ COALESCED, per the note above. Bare `jsonb_typeof(...) <> 'number'` is
    -- NULL for an absent key, and plpgsql reads a NULL condition as false.
    IF coalesce(jsonb_typeof(v_rung -> v_at_key), '') <> 'number' THEN
      RAISE EXCEPTION 'offer % level % has no %', NEW.id, v_index, v_at_key;
    END IF;
    -- A spend level stores its size as `value`, a quantity level as `percent`;
    -- both spellings are accepted and one must be a number.
    IF coalesce(jsonb_typeof(v_rung -> 'value'), '') <> 'number'
       AND coalesce(jsonb_typeof(v_rung -> 'percent'), '') <> 'number' THEN
      RAISE EXCEPTION 'offer % level % has no discount', NEW.id, v_index;
    END IF;

    v_at := (v_rung ->> v_at_key)::numeric;
    v_value := coalesce(
      (v_rung ->> 'value')::numeric,
      (v_rung ->> 'percent')::numeric
    );

    -- Belt and braces: unreachable now that both spellings are checked above,
    -- but a NULL reaching here would silently pass every remaining guard.
    IF v_value IS NULL THEN
      RAISE EXCEPTION 'offer % level % has no discount', NEW.id, v_index;
    END IF;
    IF v_value <= 0 THEN
      RAISE EXCEPTION 'offer % level % gives nothing', NEW.id, v_index;
    END IF;
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
