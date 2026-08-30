-- Mink Phase 3: operator-gated, private and versioned content proposals with
-- atomic weighted-credit charging. The agent receives no publish/send path.

ALTER TABLE public.mink_store_access
  ADD COLUMN drafting_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.mink_store_access
  ADD CONSTRAINT mink_store_access_drafting_check
  CHECK (drafting_enabled = false OR enabled = true);

ALTER TABLE public.mink_usage_ledger
  DROP CONSTRAINT mink_usage_ledger_cohort_check,
  ADD CONSTRAINT mink_usage_ledger_cohort_check CHECK (
    cost_cohort IN
      ('read_lookup', 'read_analysis', 'read_failed', 'read_unknown', 'draft_proposal')
  );

CREATE TABLE public.mink_drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  admin_id TEXT NOT NULL,
  run_id UUID NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed',
  destination_type TEXT NOT NULL,
  destination_id UUID,
  destination_label TEXT NOT NULL,
  destination_path TEXT NOT NULL,
  title TEXT NOT NULL,
  before_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  content_json JSONB NOT NULL,
  expected_credits INTEGER NOT NULL,
  charged_credits INTEGER NOT NULL DEFAULT 0,
  credit_source TEXT,
  current_version INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mink_drafts_id_store_key UNIQUE (id, store_id),
  CONSTRAINT mink_drafts_run_store_fkey
    FOREIGN KEY (run_id, store_id)
    REFERENCES public.mink_runs(id, store_id) ON DELETE CASCADE,
  CONSTRAINT mink_drafts_kind_check CHECK (kind IN
    ('product_description', 'product_seo', 'blog', 'coupon_email', 'customer_message')),
  CONSTRAINT mink_drafts_status_check CHECK (status IN ('proposed', 'draft')),
  CONSTRAINT mink_drafts_destination_check CHECK (
    btrim(destination_type) <> '' AND btrim(destination_label) <> ''
    AND destination_path LIKE '/dashboard%'
    AND char_length(destination_path) <= 500
  ),
  CONSTRAINT mink_drafts_title_check
    CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  CONSTRAINT mink_drafts_content_check CHECK (
    jsonb_typeof(before_json) = 'object'
    AND jsonb_typeof(content_json) = 'object'
  ),
  CONSTRAINT mink_drafts_credit_check CHECK (
    expected_credits BETWEEN 1 AND 20 AND charged_credits BETWEEN 0 AND 20
    AND (credit_source IS NULL OR credit_source IN
      ('plan', 'credit', 'mixed', 'plan_unlimited'))
  ),
  CONSTRAINT mink_drafts_version_check CHECK (current_version >= 0)
);

CREATE INDEX mink_drafts_owner_status_idx
  ON public.mink_drafts (store_id, admin_id, status, updated_at DESC);
CREATE INDEX mink_drafts_run_idx
  ON public.mink_drafts (store_id, run_id);

CREATE TABLE public.mink_draft_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id UUID NOT NULL,
  store_id UUID NOT NULL,
  version INTEGER NOT NULL,
  content_json JSONB NOT NULL,
  action TEXT NOT NULL,
  created_by TEXT NOT NULL,
  source_version INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mink_draft_versions_draft_version_key UNIQUE (draft_id, version),
  CONSTRAINT mink_draft_versions_draft_store_fkey
    FOREIGN KEY (draft_id, store_id)
    REFERENCES public.mink_drafts(id, store_id) ON DELETE CASCADE,
  CONSTRAINT mink_draft_versions_version_check CHECK (version > 0),
  CONSTRAINT mink_draft_versions_content_check
    CHECK (jsonb_typeof(content_json) = 'object'),
  CONSTRAINT mink_draft_versions_action_check
    CHECK (action IN ('save', 'rollback')),
  CONSTRAINT mink_draft_versions_source_check
    CHECK (source_version IS NULL OR source_version > 0)
);

CREATE INDEX mink_draft_versions_store_draft_idx
  ON public.mink_draft_versions (store_id, draft_id, version DESC);

CREATE TABLE public.mink_draft_credit_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id UUID NOT NULL,
  store_id UUID NOT NULL,
  run_id UUID NOT NULL,
  draft_kind TEXT NOT NULL,
  period TEXT NOT NULL,
  expected_credits INTEGER NOT NULL,
  charged_credits INTEGER NOT NULL,
  plan_credits INTEGER NOT NULL DEFAULT 0,
  balance_credits INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mink_draft_credit_usage_draft_key UNIQUE (draft_id),
  CONSTRAINT mink_draft_credit_usage_draft_store_fkey
    FOREIGN KEY (draft_id, store_id)
    REFERENCES public.mink_drafts(id, store_id) ON DELETE CASCADE,
  CONSTRAINT mink_draft_credit_usage_run_store_fkey
    FOREIGN KEY (run_id, store_id)
    REFERENCES public.mink_runs(id, store_id) ON DELETE CASCADE,
  CONSTRAINT mink_draft_credit_usage_counts_check CHECK (
    expected_credits BETWEEN 1 AND 20 AND charged_credits BETWEEN 0 AND 20
    AND plan_credits >= 0 AND balance_credits >= 0
    AND charged_credits = plan_credits + balance_credits
  ),
  CONSTRAINT mink_draft_credit_usage_source_check
    CHECK (source IN ('plan', 'credit', 'mixed', 'plan_unlimited')),
  CONSTRAINT mink_draft_credit_usage_period_check
    CHECK (period ~ '^[0-9]{4}-[0-9]{2}$')
);

CREATE INDEX mink_draft_credit_usage_store_idx
  ON public.mink_draft_credit_usage (store_id, created_at DESC);
CREATE INDEX mink_draft_credit_usage_run_idx
  ON public.mink_draft_credit_usage (store_id, run_id);

ALTER TABLE public.mink_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mink_draft_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mink_draft_credit_usage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.mink_drafts, public.mink_draft_versions,
  public.mink_draft_credit_usage FROM PUBLIC, app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.mink_drafts TO app_service;
GRANT SELECT, INSERT ON TABLE public.mink_draft_versions TO app_service;
GRANT SELECT, INSERT ON TABLE public.mink_draft_credit_usage TO app_service;

CREATE OR REPLACE FUNCTION public.consume_mink_draft_credits(
  p_store UUID,
  p_admin TEXT,
  p_run UUID,
  p_draft UUID,
  p_period TEXT,
  p_plan_cap INTEGER,
  p_credits INTEGER,
  p_kind TEXT
) RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  existing_source TEXT;
  used_now INTEGER;
  balance_now INTEGER;
  plan_part INTEGER;
  balance_part INTEGER;
  result_source TEXT;
BEGIN
  IF p_credits < 1 OR p_credits > 20 OR p_plan_cap < 0 THEN
    RAISE EXCEPTION 'invalid Mink draft credit request';
  END IF;

  -- Locking the draft makes retries idempotent even when two tool calls for
  -- the same proposal arrive concurrently.
  PERFORM 1
  FROM public.mink_drafts AS draft
  JOIN public.mink_runs AS run
    ON run.id = draft.run_id AND run.store_id = draft.store_id
  JOIN public.mink_store_access AS access
    ON access.store_id = draft.store_id
  WHERE draft.id = p_draft AND draft.store_id = p_store
    AND draft.admin_id = p_admin AND draft.run_id = p_run
    AND draft.kind = p_kind AND run.requested_by = p_admin
    AND access.enabled AND access.drafting_enabled
  FOR UPDATE OF draft;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Mink draft credit scope rejected';
  END IF;

  SELECT source INTO existing_source
  FROM public.mink_draft_credit_usage
  WHERE draft_id = p_draft;
  IF FOUND THEN
    RETURN existing_source;
  END IF;

  IF p_plan_cap IS NULL THEN
    INSERT INTO public.mink_draft_credit_usage
      (draft_id, store_id, run_id, draft_kind, period, expected_credits,
       charged_credits, plan_credits, balance_credits, source)
    VALUES
      (p_draft, p_store, p_run, p_kind, p_period, p_credits, 0, 0, 0, 'plan_unlimited');
    RETURN 'plan_unlimited';
  END IF;

  INSERT INTO public.ai_usage (store_id, period, used)
  VALUES (p_store, p_period, 0)
  ON CONFLICT (store_id, period) DO NOTHING;
  SELECT used INTO used_now
  FROM public.ai_usage
  WHERE store_id = p_store AND period = p_period
  FOR UPDATE;

  INSERT INTO public.ai_credit_balances (store_id, balance)
  VALUES (p_store, 0)
  ON CONFLICT (store_id) DO NOTHING;
  SELECT balance INTO balance_now
  FROM public.ai_credit_balances
  WHERE store_id = p_store
  FOR UPDATE;

  plan_part := LEAST(p_credits, GREATEST(p_plan_cap - used_now, 0));
  balance_part := p_credits - plan_part;
  IF balance_now < balance_part THEN
    RETURN 'insufficient';
  END IF;

  IF plan_part > 0 THEN
    UPDATE public.ai_usage
    SET used = used + plan_part
    WHERE store_id = p_store AND period = p_period;
  END IF;
  IF balance_part > 0 THEN
    UPDATE public.ai_credit_balances
    SET balance = balance - balance_part, updated_at = now()
    WHERE store_id = p_store;
    INSERT INTO public.ai_credit_ledger (store_id, delta, kind, ref, note)
    VALUES (
      p_store,
      -balance_part,
      'spend',
      'mink-draft:' || p_draft::text,
      'Mink AI ' || replace(p_kind, '_', ' ') || ' draft'
    );
  END IF;

  result_source := CASE
    WHEN plan_part > 0 AND balance_part > 0 THEN 'mixed'
    WHEN balance_part > 0 THEN 'credit'
    ELSE 'plan'
  END;
  INSERT INTO public.mink_draft_credit_usage
    (draft_id, store_id, run_id, draft_kind, period, expected_credits,
     charged_credits, plan_credits, balance_credits, source)
  VALUES
    (p_draft, p_store, p_run, p_kind, p_period, p_credits,
     p_credits, plan_part, balance_part, result_source);
  RETURN result_source;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_mink_draft_credits(
  UUID, TEXT, UUID, UUID, TEXT, INTEGER, INTEGER, TEXT
) FROM PUBLIC, app_user;
GRANT EXECUTE ON FUNCTION public.consume_mink_draft_credits(
  UUID, TEXT, UUID, UUID, TEXT, INTEGER, INTEGER, TEXT
) TO app_service;

CREATE OR REPLACE FUNCTION public.discard_failed_mink_run_drafts(
  p_store UUID,
  p_run UUID
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  usage_row RECORD;
  discarded INTEGER := 0;
BEGIN
  PERFORM 1
  FROM public.mink_runs
  WHERE id = p_run AND store_id = p_store
    AND status IN ('failed', 'cancelled')
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Mink failed-run draft cleanup scope rejected';
  END IF;

  FOR usage_row IN
    SELECT usage.*
    FROM public.mink_draft_credit_usage AS usage
    WHERE usage.store_id = p_store AND usage.run_id = p_run
    ORDER BY usage.created_at, usage.id
    FOR UPDATE
  LOOP
    IF usage_row.plan_credits > 0 THEN
      UPDATE public.ai_usage
      SET used = GREATEST(used - usage_row.plan_credits, 0)
      WHERE store_id = p_store AND period = usage_row.period;
    END IF;
    IF usage_row.balance_credits > 0 THEN
      UPDATE public.ai_credit_balances
      SET balance = balance + usage_row.balance_credits, updated_at = now()
      WHERE store_id = p_store;
      INSERT INTO public.ai_credit_ledger (store_id, delta, kind, ref, note)
      VALUES (
        p_store,
        usage_row.balance_credits,
        'grant',
        'mink-draft-refund:' || usage_row.draft_id::text,
        'Refund for unseen Mink draft after failed or cancelled run'
      );
    END IF;
    discarded := discarded + 1;
  END LOOP;

  -- Cascades remove each credit-usage row. A repeat call finds nothing, so the
  -- compensation is idempotent even when failure recording is retried.
  DELETE FROM public.mink_drafts
  WHERE store_id = p_store AND run_id = p_run;
  RETURN discarded;
END;
$$;

REVOKE ALL ON FUNCTION public.discard_failed_mink_run_drafts(UUID, UUID)
  FROM PUBLIC, app_user;
GRANT EXECUTE ON FUNCTION public.discard_failed_mink_run_drafts(UUID, UUID)
  TO app_service;

COMMENT ON COLUMN public.mink_store_access.drafting_enabled IS
  'Independent operator opt-in for Phase 3 private proposal tools.';
COMMENT ON TABLE public.mink_drafts IS
  'Admin-private Mink proposals. These rows are not publishable business records.';
COMMENT ON TABLE public.mink_draft_versions IS
  'Immutable save and rollback history for admin-private Mink proposals.';
COMMENT ON FUNCTION public.consume_mink_draft_credits(
  UUID, TEXT, UUID, UUID, TEXT, INTEGER, INTEGER, TEXT
) IS
  'Atomically allocates weighted Mink draft credits from monthly allowance then balance.';
COMMENT ON FUNCTION public.discard_failed_mink_run_drafts(UUID, UUID) IS
  'Discards unseen failed-run proposals and atomically restores their exact credit sources.';

UPDATE public.help_articles
SET excerpt = 'Use Mink AI for grounded store answers and, when enabled, private versioned content drafts.',
    seo_description = 'Use permission-aware Mink AI for dashboard answers and private product, SEO, blog, coupon email, and customer message drafts.',
    body = replace(
      body,
      '<h2>Temporary failures and monitoring</h2>',
      $phase3$<h2>Private content drafts</h2>
<p>Stores separately enrolled in the drafting beta can ask Mink AI for a product description, product SEO, blog post, coupon email or reusable customer-message template. The signed-in admin must have <strong>Manage</strong> permission for the related Products, Blogs, Marketing or Customers area. StoreMink also applies the store's saved brand voice as style guidance; it never grants authority or overrides safety rules.</p>
<p>Mink AI first shows a proposal card with the current text, proposed text, destination and expected credit weight. Product SEO costs 1 AI credit; product descriptions, coupon emails and customer messages cost 2; blog drafts cost 5. StoreMink consumes the monthly plan allowance first and then purchased or granted credits. The composer estimate is a preview; the server calculates and charges the authoritative amount exactly once when it creates the proposal.</p>
<p>A proposal is private to the admin who requested it. Choose <strong>Save private draft</strong> to create version 1. Later saves create immutable versions, and rollback creates a new version from an earlier one so the audit history is preserved.</p>
<p><strong>Mink AI cannot publish a product or blog, send an email or message, contact a customer, or change a live business record in this phase.</strong> Saving and rollback affect only the private Mink draft. To use approved copy, open the linked dashboard destination, review it again and complete the normal StoreMink workflow yourself.</p>
<h2>Draft troubleshooting</h2>
<p>If drafting tools are unavailable, ask a store owner to check your Manage permission and ask StoreMink support whether the separate drafting beta is enabled. If the proposal cannot be created, check the plan's remaining monthly AI allowance or AI-credit balance under Plans &amp; Billing. If the enclosing Mink run fails or is cancelled after creating a proposal, StoreMink discards the unseen proposal and restores its exact plan and purchased-credit amounts. A version conflict means the draft changed in another tab; reload the card before saving again.</p>
<h2>Temporary failures and monitoring</h2>$phase3$),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard'
  AND status = 'published';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.help_articles
    WHERE slug = 'use-mink-ai-in-your-dashboard'
      AND status = 'published'
      AND body LIKE '%Private content drafts%'
      AND body LIKE '%Save private draft%'
      AND body LIKE '%cannot publish a product or blog%'
      AND body LIKE '%blog drafts cost 5%'
  ) THEN
    RAISE EXCEPTION 'dashboard Mink AI Phase 3 guide was not updated';
  END IF;
END $$;
