-- Ship Phase 8 merchant pixels: make the globally-controlled GA4 and Meta
-- modules available, then publish the setup guides that were intentionally
-- held as drafts until the storefront consent integration existed.

UPDATE public.platform_analytics_settings
SET google_analytics_4 = TRUE,
    meta_pixel = TRUE,
    updated_at = now()
WHERE id = TRUE;

UPDATE public.help_articles
SET body = replace(
      replace(
        body,
        '<p><strong>Upcoming Pro feature:</strong> This guide is ready for the planned StoreMink GA4 connection, but the connection is not yet available to merchants. StoreMink will publish this article when the setting ships.</p>',
        '<p><strong>Pro feature:</strong> Connect your own Google Analytics 4 web stream to a StoreMink Pro storefront. StoreMink loads GA4 only after the visitor allows analytics tracking.</p>'
      ),
      '<p>After the integration is released:</p>',
      '<p>To connect the web stream:</p>'
    ),
    status = 'published',
    published_at = COALESCE(published_at, now()),
    updated_at = now()
WHERE slug = 'connect-google-analytics-4';

UPDATE public.help_articles
SET body = replace(
      replace(
        body,
        '<p><strong>Upcoming Pro feature:</strong> This guide is ready for the planned StoreMink Meta Pixel connection, but the connection is not yet available to merchants. StoreMink will publish this article when the setting ships.</p>',
        '<p><strong>Pro feature:</strong> Connect your own Meta Pixel to a StoreMink Pro storefront. StoreMink loads Meta Pixel only after the visitor allows marketing tracking.</p>'
      ),
      '<p>After the integration is released:</p>',
      '<p>To connect the Pixel:</p>'
    ),
    status = 'published',
    published_at = COALESCE(published_at, now()),
    updated_at = now()
WHERE slug = 'connect-meta-pixel';

