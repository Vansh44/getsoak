-- Mink dashboard conversation UX: retain exactly the ten most recent threads,
-- permit the service-scoped persistence layer to enforce that cap, and keep
-- the published dashboard-agent guide aligned with the shipped UI.

GRANT DELETE ON TABLE public.mink_conversations TO app_service;

WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY store_id, admin_id
           ORDER BY last_message_at DESC, created_at DESC, id DESC
         ) AS position
  FROM public.mink_conversations
), overflow AS (
  SELECT id FROM ranked WHERE position > 10
)
DELETE FROM public.mink_conversations AS conversation
USING overflow
WHERE conversation.id = overflow.id;

UPDATE public.help_articles
SET body = replace(
      replace(
        body,
        $old$<p>Select <strong>Expand</strong> for the larger workspace or <strong>Collapse</strong> to return to the drawer. <strong>New conversation</strong> starts a separate topic.</p>$old$,
        $new$<p>Select <strong>Expand</strong> for the larger workspace or <strong>Collapse</strong> to return to the drawer. On supported screen sizes, drag the left edge of the drawer to make it wider or narrower; StoreMink remembers that width in this browser. <strong>New conversation</strong> starts a separate topic.</p>
<h2>Continue recent conversations</h2>
<p>Mink AI keeps the 10 most recent conversations for each admin in each store. Open the conversation menu beside the Mink AI mark to choose a previous title. The newest conversation is restored after a dashboard refresh. Starting an eleventh conversation permanently removes the oldest conversation and its messages, run records, tool records and token record.</p>
<p>Mink AI answers display supported emphasis and inline code as formatting, so formatting markers such as double asterisks are not shown as part of the answer.</p>$new$
      ),
      $oldprivacy$StoreMink keeps conversation messages, run status, tool names and token counts for reliability and cost monitoring;$oldprivacy$,
      $newprivacy$StoreMink keeps up to 10 recent conversations per admin and store, including messages, run status, tool names and token counts, for continuity, reliability and cost monitoring;$newprivacy$
    ),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard'
  AND status = 'published';

DO $$
BEGIN
  IF NOT has_table_privilege(
    'app_service',
    'public.mink_conversations',
    'DELETE'
  ) THEN
    RAISE EXCEPTION 'app_service cannot enforce the Mink conversation cap';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.mink_conversations
    GROUP BY store_id, admin_id
    HAVING count(*) > 10
  ) THEN
    RAISE EXCEPTION 'Mink conversation retention exceeds ten rows for an actor/store';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.help_articles
    WHERE slug = 'use-mink-ai-in-your-dashboard'
      AND status = 'published'
      AND body LIKE '%drag the left edge of the drawer%'
      AND body LIKE '%10 most recent conversations%'
      AND body LIKE '%double asterisks are not shown%'
  ) THEN
    RAISE EXCEPTION 'dashboard Mink AI conversation UX guide was not updated';
  END IF;
END $$;
