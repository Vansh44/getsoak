-- Automatic offers are ON by default now, and the guide has to stop telling
-- merchants to go and switch them on.
--
-- ★★ THE 0081 GUIDANCE IS NOW WRONG FOR EVERYONE. That migration explained
-- that older stores have the switch off and newer ones have it on, which was
-- true of the fix at the time: `createStore` seeded `true` and the registry
-- default stayed `false`. That protects existing stores and leaves the switch
-- hidden from every merchant who already had one — which is nobody's actual
-- problem solved. The registry default is `true` as of this change, so a store
-- that has never touched the setting has automatic offers running, and the
-- paragraph about older stores describes a state that no longer exists.
--
-- ⚠ Measured before flipping, on both databases: exactly one store had an
-- active automatic offer, and it is the store the change was made for.
--
-- A merchant who deliberately switched it OFF keeps that: a stored value beats
-- the default, which is why the guide still explains where the switch is.
UPDATE public.help_articles
SET body = replace(
      body,
      $old$<p><strong>Stores created recently already have it on.</strong> Older stores have it off, because before automatic offers existed every discount needed a code, and switching them on for an existing store without asking would have started giving discounts nobody had approved.</p>$old$,
      $new$<p><strong>It is on unless you turned it off.</strong> If you have never touched this setting, automatic offers are already running and there is nothing to switch on.</p>$new$
    ),
    updated_at = now()
WHERE slug = 'create-and-manage-offers'
  AND status = 'published'
  AND body LIKE '%Stores created recently already have it on.%';

-- The 0082 section named the settings card; it is a page of its own now.
UPDATE public.help_articles
SET body = replace(
      body,
      'Turn both off with <strong>Show offer badges on your storefront</strong> in Settings.',
      'Turn both off with <strong>Show offer badges on your storefront</strong> in <strong>Offers → Offer settings</strong>.'
    ),
    updated_at = now()
WHERE slug = 'create-and-manage-offers'
  AND status = 'published';

UPDATE public.help_articles
SET body = replace(
      body,
      'Open <strong>Offers</strong> and look at <strong>How offers behave</strong> below the list: <strong>Apply offers automatically</strong> has to be on.',
      'Open <strong>Offers → Offer settings</strong>: <strong>Apply offers automatically</strong> has to be on.'
    ),
    updated_at = now()
WHERE slug = 'create-and-manage-offers'
  AND status = 'published';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.help_articles
    WHERE slug = 'create-and-manage-offers'
      AND status = 'published'
      AND body LIKE '%It is on unless you turned it off.%'
      AND body LIKE '%Offers → Offer settings%'
      AND body NOT LIKE '%Stores created recently already have it on.%'
      AND body NOT LIKE '%How offers behave</strong> below the list%'
  ) THEN
    RAISE EXCEPTION 'offers auto-apply default guidance was not installed';
  END IF;
END $$;
