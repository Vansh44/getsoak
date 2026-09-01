-- Keep the published Mink guide aligned with the phone workspace. The
-- original takeover guide is enrolled and immutable, so this is forward-only.

UPDATE public.help_articles
SET body = replace(
      body,
      $old$<p>Select <strong>Expand</strong> to open Mink AI across the full browser window, covering the dashboard topbar, left navigation and page content. Select <strong>Collapse</strong> to return to the drawer. On supported screen sizes, drag the left edge of the drawer to make it wider or narrower; StoreMink remembers that width in this browser. <strong>New conversation</strong> starts a separate topic.</p>$old$,
      $new$<p>Select <strong>Expand</strong> to open Mink AI across the full browser window, covering the dashboard topbar, left navigation and page content. On a phone, both the Home prompt and the topbar Mink button open a full-screen conversation: recent conversations start closed behind the sidebar button, the dashboard underneath cannot scroll, and typing keeps the composer at its full width without zooming the page. On larger screens, select <strong>Collapse</strong> to return to the drawer. Drag the left edge of the desktop drawer to make it wider or narrower; StoreMink remembers that width in this browser. <strong>New conversation</strong> starts a separate topic.</p>$new$
    ),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard'
  AND status = 'published'
  AND body LIKE '%covering the dashboard topbar, left navigation and page content%'
  AND body NOT LIKE '%recent conversations start closed behind the sidebar button%';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.help_articles
    WHERE slug = 'use-mink-ai-in-your-dashboard'
      AND status = 'published'
      AND body LIKE '%both the Home prompt and the topbar Mink button open a full-screen conversation%'
      AND body LIKE '%recent conversations start closed behind the sidebar button%'
      AND body LIKE '%the dashboard underneath cannot scroll%'
      AND body LIKE '%without zooming the page%'
  ) THEN
    RAISE EXCEPTION 'Mink mobile workspace guidance was not installed';
  END IF;
END $$;
