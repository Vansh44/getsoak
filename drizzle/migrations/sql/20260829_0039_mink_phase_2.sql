-- Mink Phase 2: invited read-only merchant beta, trusted dashboard context,
-- bounded conversation compaction, answer feedback, and shadow cost cohorts.

CREATE TABLE public.mink_store_access (
  store_id UUID PRIMARY KEY REFERENCES public.stores(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT false,
  phase TEXT NOT NULL DEFAULT 'merchant_beta',
  invited_by TEXT,
  invited_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mink_store_access_phase_check
    CHECK (phase IN ('internal_alpha', 'merchant_beta')),
  CONSTRAINT mink_store_access_invitation_check
    CHECK (enabled = false OR (invited_by IS NOT NULL AND invited_at IS NOT NULL))
);

-- Preserve controlled stores that already produced alpha runs. All other
-- merchants remain excluded until an operator explicitly invites them.
INSERT INTO public.mink_store_access
  (store_id, enabled, phase, invited_by, invited_at)
SELECT DISTINCT store_id, true, 'internal_alpha', 'phase-2-migration', now()
FROM public.mink_runs
ON CONFLICT (store_id) DO NOTHING;

ALTER TABLE public.mink_conversations
  ADD COLUMN summary_json JSONB,
  ADD COLUMN summarized_message_count INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT mink_conversations_summary_check CHECK (
    (summary_json IS NULL OR jsonb_typeof(summary_json) = 'object')
    AND summarized_message_count >= 0
  );

ALTER TABLE public.mink_runs
  ADD COLUMN current_path TEXT,
  ADD COLUMN selected_resource_type TEXT,
  ADD COLUMN selected_resource_id UUID,
  ADD CONSTRAINT mink_runs_context_check CHECK (
    (current_path IS NULL OR
      (current_path LIKE '/dashboard%' AND char_length(current_path) <= 500))
    AND (
      (selected_resource_type IS NULL AND selected_resource_id IS NULL)
      OR (selected_resource_type IN ('product', 'order') AND selected_resource_id IS NOT NULL)
    )
  );

ALTER TABLE public.mink_usage_ledger
  ADD COLUMN shadow_credits INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN cost_cohort TEXT NOT NULL DEFAULT 'read_unknown';

UPDATE public.mink_usage_ledger AS usage
SET shadow_credits = CASE WHEN usage.usage_status = 'unavailable' THEN 0 ELSE 3 END,
    cost_cohort = CASE
      WHEN usage.usage_status = 'unavailable' THEN 'read_unknown'
      WHEN run.status <> 'succeeded' THEN 'read_failed'
      WHEN run.tool_call_count <= 1 THEN 'read_lookup'
      ELSE 'read_analysis'
    END
FROM public.mink_runs AS run
WHERE run.id = usage.run_id;

ALTER TABLE public.mink_usage_ledger
  DROP CONSTRAINT mink_usage_ledger_counts_check,
  ADD CONSTRAINT mink_usage_ledger_counts_check CHECK (
    input_tokens >= 0 AND output_tokens >= 0 AND thought_tokens >= 0
    AND total_tokens >= 0 AND charged_credits >= 0 AND shadow_credits >= 0
    AND (estimated_cost_microusd IS NULL OR estimated_cost_microusd >= 0)
  ),
  ADD CONSTRAINT mink_usage_ledger_cohort_check CHECK (
    cost_cohort IN ('read_lookup', 'read_analysis', 'read_failed', 'read_unknown')
  );

CREATE TABLE public.mink_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  run_id UUID NOT NULL,
  admin_id TEXT NOT NULL,
  rating TEXT NOT NULL,
  issue_category TEXT,
  details_redacted TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mink_feedback_run_admin_key UNIQUE (run_id, admin_id),
  CONSTRAINT mink_feedback_run_store_fkey
    FOREIGN KEY (run_id, store_id)
    REFERENCES public.mink_runs(id, store_id) ON DELETE CASCADE,
  CONSTRAINT mink_feedback_rating_check
    CHECK (rating IN ('helpful', 'unhelpful')),
  CONSTRAINT mink_feedback_issue_check CHECK (
    issue_category IS NULL OR issue_category IN
      ('incorrect', 'missing_context', 'privacy', 'slow', 'other')
  ),
  CONSTRAINT mink_feedback_details_check CHECK (
    details_redacted IS NULL OR char_length(details_redacted) BETWEEN 1 AND 500
  )
);

CREATE INDEX mink_feedback_store_created_idx
  ON public.mink_feedback (store_id, created_at DESC);

ALTER TABLE public.mink_store_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mink_feedback ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.mink_store_access, public.mink_feedback
  FROM PUBLIC, app_user;
GRANT SELECT, INSERT, UPDATE ON TABLE public.mink_store_access TO app_service;
GRANT SELECT, INSERT, UPDATE ON TABLE public.mink_feedback TO app_service;

COMMENT ON TABLE public.mink_store_access IS
  'Operator-owned per-store invitation gate beneath the global Mink kill switch.';
COMMENT ON COLUMN public.mink_conversations.summary_json IS
  'Bounded extractive conversation summary; never provider reasoning.';
COMMENT ON COLUMN public.mink_usage_ledger.shadow_credits IS
  'Pilot credit estimate only. Customer charged_credits remains zero in Phase 2.';
COMMENT ON COLUMN public.mink_feedback.details_redacted IS
  'Bounded issue detail after application-level secret and PII redaction.';

UPDATE public.help_articles
SET excerpt = 'Use the invited read-only dashboard beta for grounded sales, orders, products, inventory, and StoreMink guidance.',
    seo_description = 'Use the invited, permission-aware Mink AI dashboard beta for grounded analytics, orders, catalogue, inventory, and Help Centre guidance.',
    body = replace(
      replace(
        replace(
          body,
          '<h2>Questions available in the read-only alpha</h2>',
          '<h2>Questions available in the invited read-only beta</h2>'
        ),
        '<h2>Permissions and store isolation</h2>',
        $phase2$<h2>Cards, filters and dashboard context</h2>
<p>Grounded answers can include metric, order, product, inventory and Help Centre cards. Filter chips show the period, store timezone, accessible location scope, sales channel and status used. Open a card link to inspect the supporting dashboard screen or published guide.</p>
<p>Mink AI receives the current dashboard path. When a product editor or order drawer is open, it can use that selected record only after StoreMink revalidates the record against the signed-in store and permissions. A browser-supplied ID never grants access.</p>
<h2>Orders and customer privacy</h2>
<p><strong>Orders → View</strong> is required for order questions. Order results are limited to compact operational fields. Staff without <strong>Customers → View</strong> see customer details hidden; permitted staff receive only a minimized first-name and last-initial label. Email addresses, phone numbers, addresses, notes and payment credentials are not sent to the dashboard agent.</p>
<h2>Help Centre guidance</h2>
<p>For setup, navigation and troubleshooting questions, Mink AI searches published StoreMink Help Centre articles using keyword and semantic retrieval. Source cards link to the published guides. Mink AI must say when those guides do not confirm an answer.</p>
<h2>Permissions and store isolation</h2>$phase2$
      ),
      '<h2>Temporary failures and monitoring</h2>',
      $feedback$<h2>Conversation context and feedback</h2>
<p>The dashboard keeps the 10 most recent conversations. For longer follow-ups, StoreMink keeps the newest turns verbatim and compacts older turns into a bounded extractive summary. This summary contains conversation text only and never model reasoning.</p>
<p>Use the thumbs-up button when an answer helped. Use thumbs down to report an incorrect answer, missing context, privacy concern, slow response or another issue. Optional report details are bounded and common emails, phone numbers, credentials and identifiers are redacted before support storage; do not enter private customer data.</p>
<p>Beta usage records an estimated provider cost, a read-lookup or read-analysis cohort and shadow credits. Shadow credits help StoreMink set fair future weights and do not debit the store's AI-credit balance.</p>
<h2>Temporary failures and monitoring</h2>$feedback$
    ),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard'
  AND status = 'published';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.help_articles
    WHERE slug = 'use-mink-ai-in-your-dashboard'
      AND status = 'published'
      AND body LIKE '%Cards, filters and dashboard context%'
      AND body LIKE '%Customers → View%'
      AND body LIKE '%bounded extractive summary%'
      AND body LIKE '%Shadow credits%'
  ) THEN
    RAISE EXCEPTION 'dashboard Mink AI Phase 2 guide was not updated';
  END IF;
END $$;
