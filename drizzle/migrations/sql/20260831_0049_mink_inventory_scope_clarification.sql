-- Replace the old implicit all-location catalogue-health default with an
-- explicit, permission-safe clarification and per-location comparison flow.

UPDATE public.help_articles
SET excerpt = 'Ask Mink AI for grounded store answers, clear inventory-scope choices, location comparisons, private drafts and explicitly approved actions.',
    seo_description = 'Use permission-aware Mink AI for store answers, inventory scope clarification, location comparisons, private drafts and guarded actions.',
    body = replace(
      body,
      $old$<p>Without a location name, the inventory result uses the admin's trusted all-location or assigned-location scope. An all-location total can be low even when one individual shop is out of stock. Include the exact accessible shop or warehouse name in the question to check that shelf; Mink never treats an all-location aggregate as a named location result. Publication counts always describe the current store. Select a returned product or the Inventory link to inspect the full dashboard list when the bounded card is truncated.</p>$old$,
      $new$<p>When a stock question does not say whether it means combined stock, each location or one exact location, Mink does not silently assume an all-location total. If the admin can access more than one active location, it asks one clarification and offers buttons for <strong>Compare locations</strong>, <strong>Combined stock</strong> and up to four exact accessible locations. Selecting a button sends the visible follow-up request. If only one active location is accessible, Mink uses it automatically. Publication-only questions do not require an inventory choice.</p>
<p><strong>Compare locations</strong> evaluates every tracked sellable SKU independently at each accessible shelf and shows low-stock and out-of-stock counts side by side. A missing inventory-level row counts as zero at that shelf, just as it does in the Inventory workspace. The comparison is bounded to the first 20 accessible locations; select <strong>List this location's SKUs</strong> or name another exact dashboard location for its tagged product and variant list. <strong>Combined stock</strong> uses the trusted all-accessible-location aggregate and never represents that aggregate as one shop or warehouse. Publication counts always describe the current store.</p>$new$
    ),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard'
  AND status = 'published'
  AND body LIKE '%Without a location name, the inventory result uses%'
  AND body NOT LIKE '%<strong>Compare locations</strong> evaluates every tracked sellable SKU%';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.help_articles
    WHERE slug = 'use-mink-ai-in-your-dashboard'
      AND status = 'published'
      AND body LIKE '%does not silently assume an all-location total%'
      AND body LIKE '%<strong>Compare locations</strong>%'
      AND body LIKE '%missing inventory-level row counts as zero at that shelf%'
      AND body LIKE '%first 20 accessible locations%'
  ) THEN
    RAISE EXCEPTION 'Mink inventory-scope clarification guidance was not installed';
  END IF;
END $$;
