-- Document the public, grounded Mink AI Help Assistant in the same release as
-- the UI.
-- Help content is database-backed and operator-editable; this forward-only
-- migration publishes a dependable starting guide without creating a second
-- static documentation source.

WITH help_category AS (
  SELECT id
  FROM public.help_categories
  WHERE slug = 'getting-started'
)
INSERT INTO public.help_articles AS existing
  (category_id, slug, title, excerpt, body, status, seo_title,
   seo_description, position, published_at)
SELECT help_category.id,
       'use-storemink-help-assistant',
       'Use Mink AI in the Help Centre',
       'Ask Mink AI a StoreMink question and get clear steps backed by published Help Centre guides.',
       $article$<p>Mink AI helps you find the right instructions without needing to know the exact name of a setting or guide. It understands everyday questions and clear conversational follow-ups, then answers from StoreMink's published Help Centre articles.</p>
<h2>Open Mink AI</h2>
<ol><li>Open <strong>help.storemink.com</strong> on a computer, tablet, or phone.</li><li>Select <strong>Ask Mink AI</strong> in the top-right header, beside <strong>Create your store</strong>.</li><li>Type what you want to do or describe the screen where you are stuck.</li><li>Select <strong>Send</strong>, or press Enter. Use Shift+Enter when you want a new line.</li></ol>
<p>You can also select one of the example questions to begin.</p>
<p>Mink AI opens as a panel from the right. On a computer, drag the panel's left edge to make it wider or narrower. You can also focus the resize edge and use the Left and Right arrow keys. The chosen width is remembered on that browser. On a phone, the panel uses the full screen so answers and controls remain easy to read.</p>
<h2>Ask a useful question</h2>
<p>Include your goal, the StoreMink page you are using, and what happened after your last step. For example: <strong>I am on Point of Sale → Devices. How do I authorise this tablet?</strong></p>
<p>You can then ask a short follow-up such as <strong>What should I do next?</strong> The assistant keeps a small window of the current conversation so it can understand what “it”, “that”, and “next” refer to.</p>
<p>Enter a real question or a recognised StoreMink topic. Random letters are not treated as a follow-up and do not reuse an earlier answer.</p>
<h2>Follow the answer</h2>
<ul><li><strong>Answer</strong> explains the result in simple language.</li><li><strong>Steps</strong> show actions in the order you should perform them.</li><li><strong>Important</strong> calls out permissions, limits, or failure cases.</li><li><strong>Verified guides</strong> link to the published StoreMink articles that support the answer. Open these when you need the complete details.</li><li><strong>Suggested questions</strong> help you continue with a related task.</li></ul>
<h2>What the assistant can and cannot do</h2>
<p>Mink AI can understand questions in different languages, explain published StoreMink behaviour, and guide you through documented tasks. It does not sign in to your store, inspect your account, view an order, change a setting, or perform an action for you.</p>
<p>If the published guides do not support an answer, the assistant says so instead of guessing. Describe the page and problem more clearly, search the Help Centre, or email <strong>support@storemink.com</strong> when account-specific investigation is needed.</p>
<h2>Keep private information out of chat</h2>
<p>Do not enter passwords, one-time codes, card details, API secret keys, or private customer data. The assistant does not need any of these details to explain a StoreMink workflow.</p>
<h2>Start again or close the assistant</h2>
<p>Select <strong>New conversation</strong> in the Mink AI header to clear the visible conversation and begin another topic. Select <strong>Close</strong>, press Escape, select the shaded page behind the panel, or select the header button again to close it. The conversation remains available while you move between Help Centre pages in the same visit.</p>
<h2>If the assistant cannot respond</h2>
<ul><li>Check your internet connection and try again.</li><li>Shorten a very long question and include only the relevant screen and problem.</li><li>If you reached the temporary usage limit, wait and try later or use Help Centre search.</li><li>Open the verified guides shown in the answer when answer generation is temporarily unavailable.</li></ul>$article$,
       'published',
       'How to use Mink AI in the StoreMink Help Centre',
       'Ask Mink AI StoreMink questions, receive grounded step-by-step guidance, open verified guide sources, continue with follow-ups, and protect private information.',
       100,
       now()
FROM help_category
ON CONFLICT (slug) DO UPDATE SET
  category_id = EXCLUDED.category_id,
  title = EXCLUDED.title,
  excerpt = EXCLUDED.excerpt,
  body = EXCLUDED.body,
  status = EXCLUDED.status,
  seo_title = EXCLUDED.seo_title,
  seo_description = EXCLUDED.seo_description,
  position = EXCLUDED.position,
  published_at = COALESCE(existing.published_at, EXCLUDED.published_at),
  updated_at = now();
