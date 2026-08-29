-- Align the published dashboard-agent guide with the unified robot identity,
-- conversation sidebar/deletion flow, and multiline growing composer.

UPDATE public.help_articles
SET body = replace(
      replace(
        body,
        $old_history$<p>Mink AI keeps the 10 most recent conversations for each admin in each store. Open the conversation menu beside the Mink AI mark to choose a previous title. The newest conversation is restored after a dashboard refresh. Starting an eleventh conversation permanently removes the oldest conversation and its messages, run records, tool records and token record.</p>$old_history$,
        $new_history$<p>Mink AI keeps the 10 most recent conversations for each admin in each store. The purple robot mark in the dashboard header opens Mink AI. Inside Mink AI, select the conversation-sidebar button to show or hide recent threads. The sidebar stays beside the chat in the expanded view and slides over the narrow drawer. Select a title to continue it.</p>
<p>To remove a thread, select its <strong>Delete conversation</strong> button and confirm <strong>Delete</strong>. This permanently removes its messages, run records, tool records and token record. Mink AI opens the next recent thread when the active thread is deleted. The newest remaining conversation is restored after a dashboard refresh, and starting an eleventh conversation automatically removes the oldest one.</p>$new_history$
      ),
      $old_format$<p>Mink AI answers display supported emphasis and inline code as formatting, so formatting markers such as double asterisks are not shown as part of the answer.</p>$old_format$,
      $new_format$<p>Mink AI answers display supported emphasis and inline code as formatting, so formatting markers such as double asterisks are not shown as part of the answer.</p>
<p>The message box grows as a prompt wraps onto more lines, up to a scrollable maximum. Press <strong>Enter</strong> to send or <strong>Shift+Enter</strong> to add a new line.</p>$new_format$
    ),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard'
  AND status = 'published';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.help_articles
    WHERE slug = 'use-mink-ai-in-your-dashboard'
      AND status = 'published'
      AND body LIKE '%purple robot mark in the dashboard header%'
      AND body LIKE '%conversation-sidebar button%'
      AND body LIKE '%Delete conversation%'
      AND body LIKE '%message box grows as a prompt wraps%'
      AND body LIKE '%Shift+Enter%'
  ) THEN
    RAISE EXCEPTION 'dashboard Mink AI sidebar and composer guide was not updated';
  END IF;
END $$;
