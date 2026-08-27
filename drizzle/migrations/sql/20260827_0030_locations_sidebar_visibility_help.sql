-- Clarify that the Locations child navigation keeps full destination names visible.
-- Forward-only Help Centre update: never rewrite an applied migration.

UPDATE public.help_articles
SET body = replace(
      body,
      '<p>Open <strong>Locations</strong> in the dashboard. Its left panel contains <strong>All locations</strong> and <strong>Online fulfilment &amp; pickup</strong>; select the second option for store-wide routing and pickup settings.</p>',
      '<p>Open <strong>Locations</strong> in the dashboard. Its left panel contains <strong>All locations</strong> and <strong>Online fulfilment &amp; pickup</strong>; select the second option for store-wide routing and pickup settings. On a narrow or resized panel, the full destination name wraps onto another line instead of being hidden.</p>'
    ),
    updated_at = now()
WHERE slug = 'choose-online-fulfilment-priority'
  AND status = 'published';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.help_articles
    WHERE slug = 'choose-online-fulfilment-priority'
      AND status = 'published'
      AND body LIKE '%full destination name wraps onto another line instead of being hidden%'
  ) THEN
    RAISE EXCEPTION 'Locations child-label visibility guidance was not updated';
  END IF;
END $$;
