-- Document Mink's safe location name/type aliases and fail-closed scope.

UPDATE public.help_articles
SET body = replace(
      body,
      '<p>Grounded answers can include metric, order, product, inventory and Help Centre cards. Filter chips show the period, store timezone, accessible location scope, sales channel and status used. Open a card link to inspect the supporting dashboard screen or published guide.</p>',
      $location_alias$<p>Grounded answers can include metric, order, product, inventory and Help Centre cards. Filter chips show the period, store timezone, accessible location scope, sales channel and status used. Open a card link to inspect the supporting dashboard screen or published guide.</p>
<p>For a location-specific question, use the location name shown under <strong>Locations</strong>. You may include its displayed type, for example <strong>Delhi warehouse</strong> for a Warehouse named Delhi. StoreMink resolves that phrase only when it identifies one location the signed-in admin may access. A wrong type, duplicate name or inaccessible location is refused; Mink AI does not replace a failed named-location request with all-store results.</p>$location_alias$,
      updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard'
  AND status = 'published';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.help_articles
    WHERE slug = 'use-mink-ai-in-your-dashboard'
      AND status = 'published'
      AND body LIKE '%Delhi warehouse%'
      AND body LIKE '%does not replace a failed named-location request with all-store results%'
  ) THEN
    RAISE EXCEPTION 'dashboard Mink AI location alias guidance was not updated';
  END IF;
END $$;
