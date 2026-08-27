-- Document the Locations child navigation and the aligned fulfilment workspace.
-- Forward-only Help Centre update: never rewrite an applied migration.

UPDATE public.help_articles
SET body = replace(
      body,
      '<h2>Prepare eligible locations</h2>',
      '<h2>Find routing settings</h2><p>Open <strong>Locations</strong> in the dashboard. Its left panel contains <strong>All locations</strong> and <strong>Online fulfilment &amp; pickup</strong>; select the second option for store-wide routing and pickup settings.</p><p><strong>Website order routing</strong> and <strong>Checkout</strong> share one workspace. On a wide screen, Routing method and Location priority appear side by side. On a narrow screen they stack without changing their order or meaning.</p><h2>Prepare eligible locations</h2>'
    ),
    updated_at = now()
WHERE slug = 'choose-online-fulfilment-priority'
  AND status = 'published';

UPDATE public.help_articles
SET body = replace(
      body,
      '<h2>Turn pickup on</h2>',
      '<h2>Find pickup settings</h2><p>Open <strong>Locations</strong>, then select <strong>Online fulfilment &amp; pickup</strong> in the left Locations panel. Pickup settings appear in the Checkout card directly below Website order routing, aligned in the same workspace.</p><h2>Turn pickup on</h2>'
    ),
    updated_at = now()
WHERE slug = 'offer-and-manage-store-pickup'
  AND status = 'published';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.help_articles
    WHERE slug = 'choose-online-fulfilment-priority'
      AND status = 'published'
      AND body LIKE '%left panel contains <strong>All locations</strong> and <strong>Online fulfilment &amp; pickup</strong>%'
      AND body LIKE '%Routing method and Location priority appear side by side%'
  ) THEN
    RAISE EXCEPTION 'fulfilment navigation and workspace guidance was not updated';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.help_articles
    WHERE slug = 'offer-and-manage-store-pickup'
      AND status = 'published'
      AND body LIKE '%select <strong>Online fulfilment &amp; pickup</strong> in the left Locations panel%'
      AND body LIKE '%aligned in the same workspace%'
  ) THEN
    RAISE EXCEPTION 'pickup navigation guidance was not updated';
  END IF;
END $$;
