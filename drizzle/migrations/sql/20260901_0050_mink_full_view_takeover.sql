-- Keep the dashboard Mink guide aligned with the maximized surface. The full
-- view is now a true viewport takeover rather than a panel inside dash-main.

UPDATE public.help_articles
SET body = replace(
      body,
      $old$<p>Select <strong>Expand</strong> for the larger workspace or <strong>Collapse</strong> to return to the drawer. On supported screen sizes, drag the left edge of the drawer to make it wider or narrower; StoreMink remembers that width in this browser. <strong>New conversation</strong> starts a separate topic.</p>$old$,
      $new$<p>Select <strong>Expand</strong> to open Mink AI across the full browser window, covering the dashboard topbar, left navigation and page content. Select <strong>Collapse</strong> to return to the drawer. On supported screen sizes, drag the left edge of the drawer to make it wider or narrower; StoreMink remembers that width in this browser. <strong>New conversation</strong> starts a separate topic.</p>$new$
    ),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard'
  AND status = 'published'
  AND body LIKE '%Select <strong>Expand</strong> for the larger workspace%'
  AND body NOT LIKE '%covering the dashboard topbar, left navigation and page content%';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.help_articles
    WHERE slug = 'use-mink-ai-in-your-dashboard'
      AND status = 'published'
      AND body LIKE '%Select <strong>Expand</strong> to open Mink AI across the full browser window%'
      AND body LIKE '%covering the dashboard topbar, left navigation and page content%'
      AND body LIKE '%Select <strong>Collapse</strong> to return to the drawer%'
  ) THEN
    RAISE EXCEPTION 'Mink full-view takeover guidance was not installed';
  END IF;
END $$;
