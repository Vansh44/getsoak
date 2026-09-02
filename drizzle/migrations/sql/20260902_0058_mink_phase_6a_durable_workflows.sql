-- Mink Phase 6A: durable, restart-safe background workflow runtime plus the
-- first read-only template (a weekly trading report). Operational rows are
-- service-only and every application access carries store_id + admin_id.

CREATE TABLE public.mink_workflow_runs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id            UUID NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  admin_id            TEXT NOT NULL,
  source_run_id       UUID,
  template            TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'queued',
  idempotency_key     TEXT NOT NULL,
  input_json          JSONB NOT NULL DEFAULT '{}'::jsonb,
  result_json         JSONB,
  error_code          TEXT,
  error_detail        TEXT,
  current_step        INTEGER NOT NULL DEFAULT 0,
  total_steps         INTEGER NOT NULL,
  attempt_count       INTEGER NOT NULL DEFAULT 0,
  max_attempts        INTEGER NOT NULL DEFAULT 6,
  run_after           TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_owner         UUID,
  lease_expires_at    TIMESTAMPTZ,
  cancel_requested_at TIMESTAMPTZ,
  completed_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mink_workflow_runs_id_store_key UNIQUE (id, store_id),
  CONSTRAINT mink_workflow_runs_owner_idempotency_key
    UNIQUE (store_id, admin_id, idempotency_key),
  CONSTRAINT mink_workflow_runs_template_check
    CHECK (template = 'weekly_trading_report'),
  CONSTRAINT mink_workflow_runs_status_check
    CHECK (status IN (
      'queued', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled'
    )),
  CONSTRAINT mink_workflow_runs_json_check CHECK (
    jsonb_typeof(input_json) = 'object'
    AND (result_json IS NULL OR jsonb_typeof(result_json) = 'object')
  ),
  CONSTRAINT mink_workflow_runs_progress_check CHECK (
    total_steps BETWEEN 1 AND 20
    AND current_step BETWEEN 0 AND total_steps
    AND attempt_count >= 0
    AND max_attempts BETWEEN total_steps AND 20
  ),
  CONSTRAINT mink_workflow_runs_lease_check CHECK (
    (status = 'running' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status <> 'running' AND lease_owner IS NULL AND lease_expires_at IS NULL)
  ),
  CONSTRAINT mink_workflow_runs_completion_check CHECK (
    (status = 'completed' AND result_json IS NOT NULL AND completed_at IS NOT NULL)
    OR (status IN ('failed', 'cancelled') AND completed_at IS NOT NULL)
    OR (status IN ('queued', 'running', 'waiting_approval') AND completed_at IS NULL)
  ),
  CONSTRAINT mink_workflow_runs_idempotency_check
    CHECK (char_length(btrim(idempotency_key)) BETWEEN 1 AND 200)
);

CREATE INDEX mink_workflow_runs_claim_idx
  ON public.mink_workflow_runs
    (status, run_after, lease_expires_at, created_at);
CREATE INDEX mink_workflow_runs_owner_idx
  ON public.mink_workflow_runs (store_id, admin_id, created_at DESC);

CREATE TABLE public.mink_workflow_steps (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id        UUID NOT NULL,
  store_id      UUID NOT NULL,
  step_key      TEXT NOT NULL,
  position      INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'queued',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  input_json    JSONB NOT NULL DEFAULT '{}'::jsonb,
  output_json   JSONB,
  error_code    TEXT,
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mink_workflow_steps_run_key UNIQUE (run_id, step_key),
  CONSTRAINT mink_workflow_steps_run_position_key UNIQUE (run_id, position),
  CONSTRAINT mink_workflow_steps_run_store_fkey
    FOREIGN KEY (run_id, store_id)
    REFERENCES public.mink_workflow_runs(id, store_id) ON DELETE CASCADE,
  CONSTRAINT mink_workflow_steps_status_check
    CHECK (status IN (
      'queued', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled'
    )),
  CONSTRAINT mink_workflow_steps_json_check CHECK (
    jsonb_typeof(input_json) = 'object'
    AND (output_json IS NULL OR jsonb_typeof(output_json) = 'object')
  ),
  CONSTRAINT mink_workflow_steps_progress_check
    CHECK (position >= 0 AND attempt_count >= 0),
  CONSTRAINT mink_workflow_steps_completion_check CHECK (
    (status = 'completed' AND output_json IS NOT NULL AND completed_at IS NOT NULL)
    OR (status IN ('failed', 'cancelled') AND completed_at IS NOT NULL)
    OR (status IN ('queued', 'running', 'waiting_approval') AND completed_at IS NULL)
  )
);

CREATE INDEX mink_workflow_steps_store_run_idx
  ON public.mink_workflow_steps (store_id, run_id, position);

CREATE TABLE public.mink_workflow_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id      UUID NOT NULL,
  store_id    UUID NOT NULL,
  event_key   TEXT NOT NULL,
  event_type  TEXT NOT NULL,
  step_key    TEXT,
  detail_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mink_workflow_events_run_key UNIQUE (run_id, event_key),
  CONSTRAINT mink_workflow_events_run_store_fkey
    FOREIGN KEY (run_id, store_id)
    REFERENCES public.mink_workflow_runs(id, store_id) ON DELETE CASCADE,
  CONSTRAINT mink_workflow_events_type_check CHECK (event_type IN (
    'queued', 'claimed', 'step_started', 'step_completed', 'retry_scheduled',
    'waiting_approval', 'resumed', 'cancel_requested', 'cancelled',
    'completed', 'failed'
  )),
  CONSTRAINT mink_workflow_events_detail_check CHECK (
    jsonb_typeof(detail_json) = 'object'
    AND char_length(btrim(event_key)) BETWEEN 1 AND 200
  )
);

CREATE INDEX mink_workflow_events_store_run_idx
  ON public.mink_workflow_events (store_id, run_id, created_at, id);

-- The completion event is the workflow notification outbox. A worker can
-- reconcile after a crash or overlap with another worker without producing a
-- second activity event or a second recipient notification.
CREATE UNIQUE INDEX activity_events_mink_workflow_completion_key
  ON public.activity_events (store_id, type, subject_id)
  WHERE type = 'mink.workflow_completed' AND subject_id IS NOT NULL;

ALTER TABLE public.mink_workflow_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mink_workflow_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mink_workflow_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.mink_workflow_runs FROM PUBLIC, app_user;
REVOKE ALL ON TABLE public.mink_workflow_steps FROM PUBLIC, app_user;
REVOKE ALL ON TABLE public.mink_workflow_events FROM PUBLIC, app_user;
GRANT SELECT, INSERT, UPDATE ON TABLE
  public.mink_workflow_runs,
  public.mink_workflow_steps
TO app_service;
GRANT SELECT, INSERT ON TABLE
  public.mink_workflow_events
TO app_service;

COMMENT ON TABLE public.mink_workflow_runs IS
  'Durable tenant/admin-owned Mink workflow state with bounded retry leases.';
COMMENT ON TABLE public.mink_workflow_steps IS
  'Idempotent workflow checkpoints; completed output prevents repeated side effects.';
COMMENT ON TABLE public.mink_workflow_events IS
  'Append-only, idempotency-keyed workflow history for support reconstruction.';

-- Forward-only Help Centre update. Do not overwrite merchant/operator edits to
-- the rest of the article; insert the new section once before troubleshooting.
WITH phase6a(section) AS (
  VALUES ($phase6a$<h2>Create a durable weekly trading report</h2>
<p>Ask Mink to <strong>create</strong>, <strong>prepare</strong>, <strong>run</strong> or <strong>generate my weekly trading report</strong>. You need <strong>Analytics View</strong> permission. Mink queues a background workflow for the last 7 days in the store timezone, compares it with the preceding equal period, and shows net sales, orders, average order value, units sold, leading products and sales channels.</p>
<p>The report snapshots the exact active locations accessible to you when it is queued and re-checks Analytics access, account status, beta access and restricted location assignments before each step. Removed access takes effect before the next read, while a later location cannot silently enter an existing run. Online or unassigned orders are included only when your dashboard aggregate would include them. Headline net sales include completed refunds; top-product merchandise line totals are labelled separately.</p>
<p>The progress card survives refreshes and Cloud Run restarts. Short worker leases, step checkpoints, bounded retries, exhausted-lease cleanup and idempotency keys prevent two workers from completing the same step twice or leaving a final crashed attempt stuck. The report period is anchored to the original request time, so a retry across midnight does not silently change its dates. Queued background steps are deterministic StoreMink reads and consume no additional Gemini tokens. Phase 6A does not schedule recurring reports and does not change products, inventory, prices, orders, customers, content or settings.</p>
<p>Select <strong>Stop</strong> to request cancellation. A queued report stops immediately; a running report stops safely after its current bounded read. Cancelled workflows cannot resume. Workflows waiting at a future human-approval checkpoint can resume only through their authenticated dashboard control and consume no model tokens while waiting.</p>
<p>When the report completes, StoreMink adds an in-dashboard notification. Completion delivery is reconciled and idempotent, so overlapping worker calls do not create duplicate alerts. The report card keeps its complete progress history and data-as-of time so support can reconstruct queue claims, retries, steps, cancellation and completion without storing model reasoning.</p>
$phase6a$))
UPDATE public.help_articles AS article
SET excerpt = 'Use Mink AI for grounded answers, private drafts, approved actions and durable weekly trading reports.',
    seo_description = 'Use permission-aware Mink AI for grounded store work, guarded actions and restart-safe weekly trading reports.',
    body = CASE
      WHEN strpos(article.body, '<h2>Draft troubleshooting</h2>') > 0
        THEN replace(
          article.body,
          '<h2>Draft troubleshooting</h2>',
          phase6a.section || E'\n<h2>Draft troubleshooting</h2>'
        )
      ELSE concat(article.body, E'\n', phase6a.section)
    END,
    updated_at = now()
FROM phase6a
WHERE article.slug = 'use-mink-ai-in-your-dashboard'
  AND article.body NOT LIKE '%<h2>Create a durable weekly trading report</h2>%';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.help_articles
    WHERE slug = 'use-mink-ai-in-your-dashboard'
      AND status = 'published'
      AND category_id IS NOT NULL
      AND body LIKE '%<h2>Create a durable weekly trading report</h2>%'
      AND body LIKE '%exact active locations accessible to you%'
      AND body LIKE '%re-checks Analytics access%'
      AND body LIKE '%reconciled and idempotent%'
      AND body LIKE '%anchored to the original request time%'
      AND body LIKE '%consume no additional Gemini tokens%'
      AND body LIKE '%Cancelled workflows cannot resume%'
      AND body LIKE '%Cloud Run restarts%'
      AND body LIKE '%does not change products, inventory, prices, orders%'
  ) THEN
    RAISE EXCEPTION 'Mink Phase 6A durable-workflow guidance was not installed';
  END IF;
END $$;
