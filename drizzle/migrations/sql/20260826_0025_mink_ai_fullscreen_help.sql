-- Keep the published Mink AI guide aligned with the assistant's navigation
-- and full-screen controls. This is a forward-only content repair because the
-- earlier guide migrations may already be recorded in staging or production.

UPDATE public.help_articles
SET body = replace(
      replace(
        body,
        $old_panel$<p>Mink AI opens as a panel from the right. On a computer, drag the panel's left edge to make it wider or narrower. You can also focus the resize edge and use the Left and Right arrow keys. The chosen width is remembered on that browser. On a phone, the panel uses the full screen so answers and controls remain easy to read.</p>$old_panel$,
        $new_panel$<p>Mink AI opens as a panel from the right. On a computer, drag the panel's left edge to make it wider or narrower. You can also focus the resize edge and use the Left and Right arrow keys. The chosen width is remembered on that browser.</p><p>Select <strong>Maximize</strong> in the Mink AI header to use the full browser window, then select <strong>Restore drawer</strong> to return to the side panel. On a phone, Mink AI already uses the full screen, so the maximize control is hidden.</p><p>When a reply arrives, Mink AI positions the conversation at the beginning of the new answer so you can read it from the first line. You can still scroll down to its steps, important notes, verified guides, and suggested questions.</p>$new_panel$
      ),
      $old_prompt$<p>Enter a real question or a recognised StoreMink topic. Random letters are not treated as a follow-up and do not reuse an earlier answer.</p>$old_prompt$,
      $new_prompt$<p>Enter a real question or a recognised StoreMink topic. Random letters are not treated as a follow-up and do not reuse an earlier answer.</p><p>When a question is too broad, Mink AI shows non-clickable examples of details you can add, such as the page you are using and what happened after your last step. Type your own complete reply in the message box; these examples are never submitted as your message.</p>$new_prompt$
    ),
    updated_at = now()
WHERE slug = 'use-storemink-help-assistant'
  AND status = 'published'
  AND (
    (
      body LIKE '%The chosen width is remembered on that browser.%On a phone, the panel uses the full screen%'
      AND body NOT LIKE '%<strong>Maximize</strong> in the Mink AI header%'
    )
    OR (
      body LIKE '%Random letters are not treated as a follow-up and do not reuse an earlier answer.</p>%'
      AND body NOT LIKE '%non-clickable examples of details you can add%'
    )
  );

DO $$
DECLARE
  matching_guides INTEGER;
BEGIN
  SELECT count(*)
  INTO matching_guides
  FROM public.help_articles AS article
  JOIN public.help_categories AS category
    ON category.id = article.category_id
  WHERE article.slug = 'use-storemink-help-assistant'
    AND category.slug = 'getting-started'
    AND article.status = 'published'
    AND article.body LIKE '%<strong>Maximize</strong> in the Mink AI header%'
    AND article.body LIKE '%<strong>Restore drawer</strong>%'
    AND article.body LIKE '%at the beginning of the new answer%'
    AND article.body LIKE '%non-clickable examples of details you can add%'
    AND article.body LIKE '%never submitted as your message%';

  IF matching_guides <> 1 THEN
    RAISE EXCEPTION
      'expected the published Mink AI guide to describe maximize, restore, answer positioning, and non-clickable clarification guidance; found %',
      matching_guides;
  END IF;
END
$$;
