-- Mink Phase 1B: bounded reliability telemetry, shadow model cost, cross-store
-- operator inspection, and Help Centre coverage for sales and low-stock reads.

ALTER TABLE public.mink_runs
  ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE public.mink_runs
  DROP CONSTRAINT mink_runs_counts_check;
ALTER TABLE public.mink_runs
  ADD CONSTRAINT mink_runs_counts_check CHECK (
    input_tokens >= 0 AND output_tokens >= 0 AND thought_tokens >= 0
    AND total_tokens >= 0 AND step_count >= 0 AND tool_call_count >= 0
    AND retry_count >= 0
    AND (latency_ms IS NULL OR latency_ms >= 0)
  );

CREATE INDEX mink_runs_started_idx
  ON public.mink_runs (started_at DESC);

ALTER TABLE public.mink_usage_ledger
  ADD COLUMN usage_status TEXT NOT NULL DEFAULT 'reported',
  ADD COLUMN estimated_cost_microusd INTEGER,
  ADD COLUMN pricing_version TEXT;

-- Gemini 3.7 Flash global introductory on-demand pricing through 2026-12-31:
-- $0.75 / 1M input tokens and $3.75 / 1M output tokens. At this unit, the
-- USD-per-million rate is numerically equal to micro-USD per token. Thought
-- tokens are output tokens under the provider pricing contract.
UPDATE public.mink_usage_ledger
SET estimated_cost_microusd = round(
      input_tokens::numeric * 0.75
      + (output_tokens + thought_tokens)::numeric * 3.75
    )::integer,
    pricing_version = 'gemini-3.7-flash-global-2026-intro'
WHERE lower(model) ~ '(^|/)gemini-3[.]7-flash$';

ALTER TABLE public.mink_usage_ledger
  DROP CONSTRAINT mink_usage_ledger_counts_check;
ALTER TABLE public.mink_usage_ledger
  ADD CONSTRAINT mink_usage_ledger_counts_check CHECK (
    input_tokens >= 0 AND output_tokens >= 0 AND thought_tokens >= 0
    AND total_tokens >= 0 AND charged_credits >= 0
    AND (estimated_cost_microusd IS NULL OR estimated_cost_microusd >= 0)
  ),
  ADD CONSTRAINT mink_usage_ledger_status_check CHECK (
    usage_status IN ('reported', 'partial', 'unavailable')
  );

COMMENT ON COLUMN public.mink_runs.retry_count IS
  'StoreMink-owned transient model retries completed during this run.';
COMMENT ON COLUMN public.mink_usage_ledger.usage_status IS
  'Whether token usage is complete, partial, or unavailable after interruption.';
COMMENT ON COLUMN public.mink_usage_ledger.estimated_cost_microusd IS
  'Shadow provider cost in one-millionth USD; NULL means unknown, never free.';
COMMENT ON COLUMN public.mink_usage_ledger.pricing_version IS
  'Immutable pricing schedule identifier used for the shadow estimate.';

UPDATE public.help_articles
SET excerpt = 'Ask the permission-aware dashboard assistant about your store, catalogue, sales, and low-stock inventory.',
    seo_description = 'Ask the permission-aware read-only dashboard assistant about store details, products, sales, and low-stock inventory.',
    body = replace(
      replace(
        replace(
          replace(
            body,
            $old_intro$<p>Mink AI in the StoreMink dashboard can answer a small set of questions using the store you are signed in to. During the read-only alpha it can check your store name, status and plan, summarise product counts and stock health, and find products by name or SKU.</p>$old_intro$,
            $new_intro$<p>Mink AI in the StoreMink dashboard can answer a small set of business questions using the store you are signed in to. During the read-only alpha it can check your store name, status and plan, summarise the catalogue, find products by name or SKU, report recognised net sales for common dashboard periods, and list low-stock products and variants.</p>$new_intro$
          ),
          $old_questions$<ul><li>What plan is this store using?</li><li>How many products are published or in draft?</li><li>How many tracked products are low or out of stock?</li><li>Find a product by its name or SKU.</li></ul>$old_questions$,
          $new_questions$<ul><li>What plan is this store using?</li><li>How many products are published or in draft?</li><li>Find a product by its name or SKU.</li><li>What were net sales today, yesterday, over the last 7 or 30 days, month to date, or year to date?</li><li>Which tracked products or variants are low or out of stock?</li></ul>
<p>Sales answers state the store timezone, date range, currency, location scope and when the data was read. Net sales use the same recognised-order and completed-refund rules as dashboard Analytics. Low-stock answers use each item threshold, falling back to the store default, and link back to Inventory or the product.</p>$new_questions$
        ),
        $old_permissions$<p>Mink AI uses the store from the current dashboard host and the permissions of the signed-in admin. It does not accept a store ID, role or permission from a message. An admin without <strong>Products → View</strong> cannot use catalogue tools, even if they ask for one by name.</p>$old_permissions$,
        $new_permissions$<p>Mink AI uses the store from the current dashboard host, the location assignments and the permissions of the signed-in admin. It does not accept a store ID, location ID, role or permission from a message. <strong>Products → View</strong> is required for catalogue tools, <strong>Analytics → View</strong> for sales, and <strong>Inventory → View</strong> for low-stock lists. Asking for a hidden tool by name does not bypass those checks.</p>$new_permissions$
      ),
      $privacy_heading$<h2>Protect private information</h2>$privacy_heading$,
      $operations$<h2>Temporary failures and monitoring</h2>
<p>Mink AI retries a transient model failure at most once. Each request also has a hard time limit; if it is reached, Mink AI stops and shows a safe retry message. Phase 1B tools are read only, so a retry cannot duplicate a business change.</p>
<p>StoreMink operators can inspect redacted run status, latency, retry count, tool names, token usage and estimated model cost for reliability and cost monitoring. The inspector never displays prompts, answers, tool arguments, tool results or model reasoning. Interrupted usage is labelled partial or unavailable instead of being shown as zero cost. The alpha still does not debit AI credits.</p>
<h2>Protect private information</h2>$operations$
    ),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard'
  AND status = 'published';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'mink_runs'
      AND column_name = 'retry_count'
  ) THEN
    RAISE EXCEPTION 'Mink retry telemetry column was not added';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.help_articles
    WHERE slug = 'use-mink-ai-in-your-dashboard'
      AND status = 'published'
      AND body LIKE '%Analytics → View%'
      AND body LIKE '%Inventory → View%'
      AND body LIKE '%retries a transient model failure at most once%'
      AND body LIKE '%never displays prompts, answers, tool arguments, tool results or model reasoning%'
  ) THEN
    RAISE EXCEPTION 'dashboard Mink AI Phase 1B guide was not updated';
  END IF;
END $$;
