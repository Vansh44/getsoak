-- Keep the published Mink guide aligned with the location-aware catalogue
-- health reader and the safe structured answer renderer.

UPDATE public.help_articles
SET excerpt = 'Ask Mink AI for grounded store answers, location-aware catalogue and stock health, private drafts and explicitly approved actions.',
    seo_description = 'Use permission-aware Mink AI for store answers, location-aware catalogue and stock health, private drafts and guarded actions.',
    body = replace(
      body,
      '<h2>Permissions and store isolation</h2>',
      $catalogue$<h2>Read catalogue and stock health</h2>
<p>Ask Mink for published, unpublished, draft and archived products to receive product-level counts plus a bounded list of products and variants with visible status badges. Draft and archived products are also unpublished, so <strong>Unpublished</strong> is a total while <strong>Draft</strong> and <strong>Archived</strong> explain that total.</p>
<p>Low-stock and out-of-stock counts are sellable-SKU counts: a simple product without variants counts as one SKU, while every variant is evaluated separately. Mink uses the same per-SKU threshold and store-default fallback as the Inventory workspace. It shows the stock quantity, low-stock threshold and an <strong>In stock</strong>, <strong>Low stock</strong>, <strong>Out of stock</strong> or <strong>Not tracked</strong> badge when the signed-in admin has <strong>Inventory → View</strong>.</p>
<p>Without a location name, the inventory result uses the admin's trusted all-location or assigned-location scope. An all-location total can be low even when one individual shop is out of stock. Include the exact accessible shop or warehouse name in the question to check that shelf; Mink never treats an all-location aggregate as a named location result. Publication counts always describe the current store. Select a returned product or the Inventory link to inspect the full dashboard list when the bounded card is truncated.</p>
<p>Mink formats supported headings, lists, tables, emphasis, code and StoreMink links for readability. Model text is never treated as raw HTML, and arbitrary external links are not made clickable.</p>
<h2>Permissions and store isolation</h2>$catalogue$
    ),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard'
  AND status = 'published'
  AND body NOT LIKE '%<h2>Read catalogue and stock health</h2>%';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.help_articles
    WHERE slug = 'use-mink-ai-in-your-dashboard'
      AND status = 'published'
      AND body LIKE '%<h2>Read catalogue and stock health</h2>%'
      AND body LIKE '%Low-stock and out-of-stock counts are sellable-SKU counts%'
      AND body LIKE '%all-location total can be low even when one individual shop is out of stock%'
      AND body LIKE '%Model text is never treated as raw HTML%'
  ) THEN
    RAISE EXCEPTION 'Mink catalogue health and answer-formatting guidance was not installed';
  END IF;
END $$;
