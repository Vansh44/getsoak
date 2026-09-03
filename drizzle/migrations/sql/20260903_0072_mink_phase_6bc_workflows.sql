-- Migration 0072 — Mink Phases 6B/6C: extend the restart-safe runtime with two bounded,
-- read-only templates. Existing Phase 6A rows remain valid.

ALTER TABLE public.mink_workflow_runs
  DROP CONSTRAINT mink_workflow_runs_template_check;

ALTER TABLE public.mink_workflow_runs
  ADD CONSTRAINT mink_workflow_runs_template_check CHECK (
    template IN (
      'weekly_trading_report',
      'revenue_decline_investigation',
      'product_launch_preparation'
    )
  );

-- Add the user-visible contract once without replacing operator edits to the
-- rest of the published guide.
WITH phase6bc(section) AS (
  VALUES ($phase6bc$<h2>Investigate a revenue decline</h2>
<p>Ask Mink to <strong>investigate</strong>, <strong>diagnose</strong> or <strong>explain</strong> a revenue decline over the last 7, 30 or 90 days. You need <strong>Analytics View</strong> permission. Mink compares that period with the preceding equal period in the store timezone and checks recognized net sales, order count, average order value, units sold, sales channels, accessible locations and the bounded set of leading product movements.</p>
<p>You may name one exact accessible dashboard location, such as <strong>Shop</strong> or <strong>Delhi warehouse</strong>. Otherwise the workflow captures your exact accessible active-location scope and labels whether online or unassigned orders are included. Access, suspension, beta eligibility and location assignments are checked again before every background read. The result reports evidence and correlations, not invented causes: advertising spend, external traffic and competitor activity are unavailable unless StoreMink records them.</p>
<p>Use a normal sales question for a quick total. The durable investigation starts only after an explicit investigate/diagnose request, survives restarts, can be stopped safely and consumes no additional Gemini tokens while queued.</p>

<h2>Prepare a private product launch package</h2>
<p>Ask Mink to prepare a launch-readiness package for one <strong>exact existing product or variant SKU</strong>. You need both <strong>Products View</strong> and <strong>Inventory View</strong>. The SKU is resolved inside the current store; product names are never expanded implicitly. Mink inspects at most 20 sellable SKUs and checks publication state, parent and relevant variant media, saved description and SEO coverage, valid MRP/selling/special-price hierarchy, stock and low-stock thresholds across the captured accessible active locations, and required shipping measurements. Missing stock rows count as zero at that location, and Mink flags a location-level gap even when combined stock is positive elsewhere.</p>
<p>The completed private card separates blockers, items needing attention and ready checks. It includes an ordered launch checklist and clearly labelled starter copy grounded only in the saved store, product, variant and category names. The package does not generate an image, publish or edit a product, change prices or inventory, create or send a campaign, select recipients, deploy code or contact a customer. Any later change must use the relevant saved proposal and human-approval flow.</p>
<p>Both templates use the same service-only workflow ledger, short leases, idempotent checkpoints, bounded retries, safe cancellation, owner-and-store status endpoint and duplicate-safe completion notification as the weekly report. A location added later cannot enter an already queued run; removed permission or location access takes effect before the next read.</p>
$phase6bc$))
UPDATE public.help_articles AS article
SET excerpt = 'Use Mink AI for grounded answers, guarded actions and restart-safe trading and product-launch workflows.',
    seo_description = 'Use permission-aware Mink AI for grounded store work, guarded actions, revenue investigations and private product-launch preparation.',
    body = CASE
      WHEN article.body LIKE '%<h2>Draft troubleshooting</h2>%'
        THEN replace(
          article.body,
          '<h2>Draft troubleshooting</h2>',
          phase6bc.section || E'\n<h2>Draft troubleshooting</h2>'
        )
      ELSE concat(article.body, E'\n', phase6bc.section)
    END,
    updated_at = now()
FROM phase6bc
WHERE article.slug = 'use-mink-ai-in-your-dashboard'
  AND article.body NOT LIKE '%<h2>Investigate a revenue decline</h2>%';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'mink_workflow_runs_template_check'
      AND conrelid = 'public.mink_workflow_runs'::regclass
      AND pg_get_constraintdef(oid) LIKE '%revenue_decline_investigation%'
      AND pg_get_constraintdef(oid) LIKE '%product_launch_preparation%'
  ) THEN
    RAISE EXCEPTION 'Mink Phase 6B/6C workflow templates were not installed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.help_articles
    WHERE slug = 'use-mink-ai-in-your-dashboard'
      AND status = 'published'
      AND category_id IS NOT NULL
      AND body LIKE '%<h2>Investigate a revenue decline</h2>%'
      AND body LIKE '%preceding equal period%'
      AND body LIKE '%reports evidence and correlations, not invented causes%'
      AND body LIKE '%<h2>Prepare a private product launch package</h2>%'
      AND body LIKE '%exact existing product or variant SKU%'
      AND body LIKE '%at most 20 sellable SKUs%'
      AND body LIKE '%flags a location-level gap%'
      AND body LIKE '%does not generate an image%'
      AND body LIKE '%added later cannot enter an already queued run%'
  ) THEN
    RAISE EXCEPTION 'Mink Phase 6B/6C Help Centre guidance was not installed';
  END IF;
END $$;
