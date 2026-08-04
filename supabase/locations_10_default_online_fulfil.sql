-- Locations gap closure: a default location created AFTER locations_01 must
-- preserve the pre-locations behaviour — online orders fulfil from Main.
-- pos_ensure_default_location still inserted '{}', which made online_stock 0.
-- Keep this additive: pos_00/locations_01 may already be applied in production.

BEGIN;

CREATE OR REPLACE FUNCTION public.pos_ensure_default_location(p_store uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_id uuid;
BEGIN
  SELECT id INTO v_id FROM public.store_locations
   WHERE store_id = p_store AND is_default LIMIT 1;

  IF v_id IS NULL THEN
    INSERT INTO public.store_locations (
      store_id, name, type, capabilities, is_default, active, sort_order
    ) VALUES (
      p_store, 'Main', 'shop',
      jsonb_build_object(
        'pos', false, 'online_fulfil', true, 'pickup', false,
        'returns', false, 'receive_stock', true, 'transfer_stock', true
      ),
      true, true, 0
    )
    ON CONFLICT (store_id) WHERE is_default DO NOTHING
    RETURNING id INTO v_id;

    IF v_id IS NULL THEN
      SELECT id INTO v_id FROM public.store_locations
       WHERE store_id = p_store AND is_default LIMIT 1;
    END IF;
  END IF;
  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.pos_ensure_default_location(uuid)
  TO app_user, app_service;

-- Repair only bare rows. Explicit merchant choices are never overwritten. The
-- existing capability-update trigger recomputes online_stock for these rows.
UPDATE public.store_locations l
   SET capabilities = jsonb_build_object(
         'pos', COALESCE((s.settings -> 'features' ->> 'pos.enabled')::boolean, false),
         'online_fulfil', l.is_default,
         'pickup', false,
         'returns', false,
         'receive_stock', true,
         'transfer_stock', true
       ),
       updated_at = now()
  FROM public.stores s
 WHERE s.id = l.store_id AND l.capabilities = '{}'::jsonb;

DO $$
DECLARE stranded text;
BEGIN
  SELECT string_agg(store_id::text, ', ') INTO stranded
    FROM (
      SELECT store_id FROM public.store_locations GROUP BY store_id
      HAVING count(*) FILTER (
        WHERE (capabilities ->> 'online_fulfil')::boolean IS TRUE AND active
      ) = 0
    ) stranded_stores;
  IF stranded IS NOT NULL THEN
    RAISE EXCEPTION 'Store(s) left with no online-fulfilment location: %', stranded;
  END IF;
END $$;

COMMIT;
