-- Forward-only copy update; preserves merchant branding and existing guidance.
DO $brand_refresh$
DECLARE
  guidance text := $guide$<h2>Recognise StoreMink branding</h2><p>StoreMink uses a purple shopping-bag logo with a white shop detail. You will see it on StoreMink pages, in the dashboard, in the Help Centre and beside the Powered by StoreMink credit where that credit is shown. Small browser-tab icons use a closely cropped version so the mark is easier to recognise.</p><p>This is separate from your own business logo. Changing StoreMink branding does not replace the logo you uploaded in Branding. Your storefront continues to use your saved logo, including as its browser-tab icon; a storefront without a saved logo uses the StoreMink icon as a fallback.</p><p>If an old StoreMink icon is still visible after an update, save any unfinished work, reload the page and reopen the tab. Browsers, home-screen shortcuts and social previews may keep older images cached for a while. If a saved home-screen shortcut keeps its old icon, remove that shortcut and add it again. You do not need to upload the StoreMink logo into your own Branding settings.</p>$guide$;
BEGIN
  UPDATE public.help_articles
  SET body = body || guidance, updated_at = now()
  WHERE slug = 'change-your-storefront-branding-and-layout'
    AND status = 'published'
    AND category_id IS NOT NULL
    AND position('<h2>Recognise StoreMink branding</h2>' in body) = 0;

  IF NOT EXISTS (
    SELECT 1 FROM public.help_articles
    WHERE slug = 'change-your-storefront-branding-and-layout'
      AND status = 'published'
      AND category_id IS NOT NULL
      AND position(guidance in body) > 0
  ) THEN
    RAISE EXCEPTION 'StoreMink branding guidance was not installed; apply the storefront Help baseline first';
  END IF;
END;
$brand_refresh$;
