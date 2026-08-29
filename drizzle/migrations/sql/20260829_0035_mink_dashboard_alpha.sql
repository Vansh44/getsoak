-- Mink dashboard agent, internal read-only alpha.
--
-- These rows are operational records, not a second authorization source. The
-- application derives store/admin/permissions from the authenticated dashboard
-- request and uses app_service with an explicit store_id on every statement.
-- RLS is deliberately enabled with no app_user policies: a browser or generic
-- user-scoped query cannot read or write agent history directly.

CREATE TABLE public.mink_conversations (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id         UUID NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  admin_id         TEXT NOT NULL,
  title            TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'active',
  last_message_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at       TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '90 days'),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mink_conversations_id_store_key UNIQUE (id, store_id),
  CONSTRAINT mink_conversations_title_check
    CHECK (btrim(title) <> '' AND char_length(title) <= 120),
  CONSTRAINT mink_conversations_status_check
    CHECK (status IN ('active', 'archived', 'deleted')),
  CONSTRAINT mink_conversations_expiry_check
    CHECK (expires_at > created_at)
);

CREATE INDEX mink_conversations_owner_idx
  ON public.mink_conversations (store_id, admin_id, last_message_at DESC);
CREATE INDEX mink_conversations_expiry_idx
  ON public.mink_conversations (expires_at);

CREATE TABLE public.mink_runs (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id                 UUID NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  conversation_id          UUID NOT NULL,
  requested_by             TEXT NOT NULL,
  request_id               UUID NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'running',
  model                    TEXT NOT NULL,
  thinking_level           TEXT NOT NULL DEFAULT 'low',
  prompt_version           TEXT NOT NULL DEFAULT 'read-alpha-v1',
  tool_registry_version    TEXT NOT NULL DEFAULT 'read-alpha-v1',
  risk_tier                TEXT NOT NULL DEFAULT 'R0',
  input_tokens             INTEGER NOT NULL DEFAULT 0,
  output_tokens            INTEGER NOT NULL DEFAULT 0,
  thought_tokens           INTEGER NOT NULL DEFAULT 0,
  total_tokens             INTEGER NOT NULL DEFAULT 0,
  step_count               INTEGER NOT NULL DEFAULT 0,
  tool_call_count          INTEGER NOT NULL DEFAULT 0,
  latency_ms               INTEGER,
  error_code               TEXT,
  started_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at             TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mink_runs_id_store_key UNIQUE (id, store_id),
  CONSTRAINT mink_runs_request_id_key UNIQUE (request_id),
  CONSTRAINT mink_runs_conversation_store_fkey
    FOREIGN KEY (conversation_id, store_id)
    REFERENCES public.mink_conversations(id, store_id) ON DELETE CASCADE,
  CONSTRAINT mink_runs_status_check
    CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
  CONSTRAINT mink_runs_thinking_level_check
    CHECK (thinking_level IN ('minimal', 'low', 'medium', 'high')),
  CONSTRAINT mink_runs_risk_tier_check
    CHECK (risk_tier IN ('R0', 'R1', 'R2', 'R3', 'R4')),
  CONSTRAINT mink_runs_counts_check
    CHECK (
      input_tokens >= 0 AND output_tokens >= 0 AND thought_tokens >= 0
      AND total_tokens >= 0 AND step_count >= 0 AND tool_call_count >= 0
      AND (latency_ms IS NULL OR latency_ms >= 0)
    ),
  CONSTRAINT mink_runs_completion_check
    CHECK (
      (status = 'running' AND completed_at IS NULL)
      OR (status <> 'running' AND completed_at IS NOT NULL)
    )
);

CREATE INDEX mink_runs_conversation_idx
  ON public.mink_runs (store_id, conversation_id, started_at DESC);
CREATE INDEX mink_runs_status_idx
  ON public.mink_runs (store_id, status, started_at DESC);

CREATE TABLE public.mink_messages (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id             UUID NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  conversation_id      UUID NOT NULL,
  run_id               UUID NOT NULL,
  role                 TEXT NOT NULL,
  content_json         JSONB NOT NULL,
  provider_state_json  JSONB,
  model                TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mink_messages_conversation_store_fkey
    FOREIGN KEY (conversation_id, store_id)
    REFERENCES public.mink_conversations(id, store_id) ON DELETE CASCADE,
  CONSTRAINT mink_messages_run_store_fkey
    FOREIGN KEY (run_id, store_id)
    REFERENCES public.mink_runs(id, store_id) ON DELETE CASCADE,
  CONSTRAINT mink_messages_role_check
    CHECK (role IN ('user', 'assistant')),
  CONSTRAINT mink_messages_content_check
    CHECK (
      jsonb_typeof(content_json) = 'object'
      AND jsonb_typeof(content_json -> 'text') = 'string'
      AND char_length(btrim(content_json ->> 'text')) BETWEEN 1 AND 40000
    ),
  CONSTRAINT mink_messages_provider_state_check
    CHECK (
      provider_state_json IS NULL
      OR jsonb_typeof(provider_state_json) = 'object'
    )
);

CREATE INDEX mink_messages_conversation_idx
  ON public.mink_messages (store_id, conversation_id, created_at, id);
CREATE INDEX mink_messages_run_idx
  ON public.mink_messages (store_id, run_id);

CREATE TABLE public.mink_tool_calls (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id            UUID NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  run_id              UUID NOT NULL,
  sequence            INTEGER NOT NULL,
  provider_call_id    TEXT,
  tool_name           TEXT NOT NULL,
  tool_version        INTEGER NOT NULL DEFAULT 1,
  status              TEXT NOT NULL DEFAULT 'running',
  risk_tier           TEXT NOT NULL DEFAULT 'R0',
  permission_checked  BOOLEAN NOT NULL DEFAULT true,
  arguments_summary   JSONB NOT NULL DEFAULT '{}'::jsonb,
  result_summary      JSONB,
  error_code          TEXT,
  started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mink_tool_calls_run_sequence_key UNIQUE (run_id, sequence),
  CONSTRAINT mink_tool_calls_run_store_fkey
    FOREIGN KEY (run_id, store_id)
    REFERENCES public.mink_runs(id, store_id) ON DELETE CASCADE,
  CONSTRAINT mink_tool_calls_sequence_check CHECK (sequence > 0),
  CONSTRAINT mink_tool_calls_name_check CHECK (btrim(tool_name) <> ''),
  CONSTRAINT mink_tool_calls_version_check CHECK (tool_version > 0),
  CONSTRAINT mink_tool_calls_status_check
    CHECK (status IN ('running', 'succeeded', 'failed')),
  CONSTRAINT mink_tool_calls_risk_tier_check
    CHECK (risk_tier IN ('R0', 'R1', 'R2', 'R3', 'R4')),
  CONSTRAINT mink_tool_calls_arguments_check
    CHECK (jsonb_typeof(arguments_summary) = 'object'),
  CONSTRAINT mink_tool_calls_result_check
    CHECK (result_summary IS NULL OR jsonb_typeof(result_summary) = 'object'),
  CONSTRAINT mink_tool_calls_completion_check
    CHECK (
      (status = 'running' AND completed_at IS NULL)
      OR (status <> 'running' AND completed_at IS NOT NULL)
    )
);

CREATE INDEX mink_tool_calls_run_idx
  ON public.mink_tool_calls (store_id, run_id, sequence);

CREATE TABLE public.mink_usage_ledger (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id          UUID NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  admin_id          TEXT NOT NULL,
  run_id            UUID NOT NULL,
  model             TEXT NOT NULL,
  input_tokens      INTEGER NOT NULL,
  output_tokens     INTEGER NOT NULL,
  thought_tokens    INTEGER NOT NULL,
  total_tokens      INTEGER NOT NULL,
  charged_credits   INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mink_usage_ledger_run_key UNIQUE (run_id),
  CONSTRAINT mink_usage_ledger_run_store_fkey
    FOREIGN KEY (run_id, store_id)
    REFERENCES public.mink_runs(id, store_id) ON DELETE CASCADE,
  CONSTRAINT mink_usage_ledger_counts_check
    CHECK (
      input_tokens >= 0 AND output_tokens >= 0 AND thought_tokens >= 0
      AND total_tokens >= 0 AND charged_credits >= 0
    )
);

CREATE INDEX mink_usage_ledger_store_idx
  ON public.mink_usage_ledger (store_id, created_at DESC);

ALTER TABLE public.mink_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mink_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mink_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mink_tool_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mink_usage_ledger ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.mink_conversations FROM PUBLIC, app_user;
REVOKE ALL ON TABLE public.mink_runs FROM PUBLIC, app_user;
REVOKE ALL ON TABLE public.mink_messages FROM PUBLIC, app_user;
REVOKE ALL ON TABLE public.mink_tool_calls FROM PUBLIC, app_user;
REVOKE ALL ON TABLE public.mink_usage_ledger FROM PUBLIC, app_user;

GRANT SELECT, INSERT, UPDATE ON TABLE
  public.mink_conversations,
  public.mink_runs,
  public.mink_messages,
  public.mink_tool_calls
TO app_service;
GRANT SELECT, INSERT ON TABLE public.mink_usage_ledger TO app_service;

COMMENT ON TABLE public.mink_conversations IS
  'Store/admin-owned dashboard agent conversations; operational data, never authorization.';
COMMENT ON COLUMN public.mink_messages.provider_state_json IS
  'Opaque provider state. Never parse, display, or log thought signatures.';
COMMENT ON TABLE public.mink_usage_ledger IS
  'Append-only raw Mink model usage. Alpha runs record zero charged credits.';

-- Publish a separate dashboard-agent guide. The existing Mink AI guide is for
-- the public Help Centre assistant and correctly says it cannot inspect a
-- merchant account; changing that article would conflate two different tools.
WITH help_category AS (
  SELECT id FROM public.help_categories WHERE slug = 'getting-started'
)
INSERT INTO public.help_articles AS existing
  (category_id, slug, title, excerpt, body, status, seo_title,
   seo_description, position, published_at)
SELECT help_category.id,
       'use-mink-ai-in-your-dashboard',
       'Use Mink AI in your dashboard',
       'Ask the read-only dashboard assistant about your store profile and product catalogue.',
       $article$<p>Mink AI in the StoreMink dashboard can answer a small set of questions using the store you are signed in to. During the read-only alpha it can check your store name, status and plan, summarise product counts and stock health, and find products by name or SKU.</p>
<h2>Open the dashboard assistant</h2>
<ol><li>Sign in to the correct store dashboard.</li><li>Select the Mink AI button in the top bar, or use <strong>Ask anything</strong> on Home.</li><li>Enter a store or product question and send it.</li><li>Watch the activity label while Mink AI checks an allowed StoreMink tool.</li></ol>
<p>Select <strong>Expand</strong> for the larger workspace or <strong>Collapse</strong> to return to the drawer. <strong>New conversation</strong> starts a separate topic.</p>
<h2>Questions available in the read-only alpha</h2>
<ul><li>What plan is this store using?</li><li>How many products are published or in draft?</li><li>How many tracked products are low or out of stock?</li><li>Find a product by its name or SKU.</li></ul>
<h2>Permissions and store isolation</h2>
<p>Mink AI uses the store from the current dashboard host and the permissions of the signed-in admin. It does not accept a store ID, role or permission from a message. An admin without <strong>Products → View</strong> cannot use catalogue tools, even if they ask for one by name.</p>
<h2>Current limits</h2>
<p>This alpha is read only. It cannot create or edit a product, change stock, inspect orders or customers, publish content, send a campaign, refund money, modify settings, or edit StoreMink platform code. It says when a requested capability is not available instead of pretending it completed an action.</p>
<p>Select <strong>Stop</strong> to cancel the request in this browser. If a temporary error appears, select <strong>Retry</strong>. StoreMink keeps conversation messages, run status, tool names and token counts for reliability and cost monitoring; alpha usage does not debit AI credits.</p>
<h2>Protect private information</h2>
<p>Do not enter passwords, one-time codes, payment credentials, card details, API secrets or unnecessary private customer information. Mink AI does not need them for the supported read-only questions.</p>$article$,
       'published',
       'Use Mink AI in your StoreMink dashboard',
       'Ask the permission-aware read-only dashboard assistant about store details, product counts, stock health, and product names or SKUs.',
       101,
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

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.help_articles
    WHERE slug = 'use-mink-ai-in-your-dashboard'
      AND status = 'published'
      AND body LIKE '%This alpha is read only.%'
      AND body LIKE '%Products → View%'
      AND body LIKE '%does not debit AI credits%'
  ) THEN
    RAISE EXCEPTION 'dashboard Mink AI alpha guide was not published';
  END IF;
END $$;
