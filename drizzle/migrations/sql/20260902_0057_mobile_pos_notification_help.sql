-- Keep the published POS and dashboard notification guidance aligned with the
-- touch-safe phone surfaces. Existing Help migrations remain immutable.

UPDATE public.help_articles
SET body = replace(
      body,
      '<h2>Understand unavailable products</h2>',
      $mobile$<p>On a touch-first phone or tablet, the register opens the software keyboard only after you select an editable field. Typing in search, discounts, customer details or payment fields keeps the page at its normal scale. Products and Cart each own their vertical scroll; reaching the end does not move the page behind the register.</p>
<p>If a camera scan button is available, the search field shrinks to share the same row without pushing either control beyond the screen. A paired hardware scanner still works when no field is focused.</p>
<h2>Understand unavailable products</h2>$mobile$
    ),
    updated_at = now()
WHERE slug = 'customize-register-and-scan-products'
  AND status = 'published'
  AND body NOT LIKE '%the register opens the software keyboard only after you select an editable field%';

UPDATE public.help_articles
SET body = replace(
      body,
      '<h2>Open notification settings</h2>',
      $mobile$<h2>Read the dashboard notification bell on a phone</h2>
<p>Select the bell in the dashboard top bar to open your latest in-app notifications. On a phone, the inbox aligns to the screen edges with a small gutter and scrolls inside the panel, so titles and actions stay visible without moving the dashboard sideways. Select a notification to open its related page, or select <strong>View all activity</strong>.</p>
<h2>Open notification settings</h2>$mobile$
    ),
    updated_at = now()
WHERE slug = 'manage-store-and-personal-notifications'
  AND status = 'published'
  AND body NOT LIKE '%<h2>Read the dashboard notification bell on a phone</h2>%';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.help_articles
    WHERE slug = 'customize-register-and-scan-products'
      AND status = 'published'
      AND body LIKE '%the register opens the software keyboard only after you select an editable field%'
      AND body LIKE '%Products and Cart each own their vertical scroll%'
      AND body LIKE '%without pushing either control beyond the screen%'
  ) THEN
    RAISE EXCEPTION 'touch-safe POS phone guidance was not installed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.help_articles
    WHERE slug = 'manage-store-and-personal-notifications'
      AND status = 'published'
      AND body LIKE '%<h2>Read the dashboard notification bell on a phone</h2>%'
      AND body LIKE '%the inbox aligns to the screen edges with a small gutter%'
      AND body LIKE '%scrolls inside the panel%'
  ) THEN
    RAISE EXCEPTION 'mobile dashboard notification guidance was not installed';
  END IF;
END $$;
