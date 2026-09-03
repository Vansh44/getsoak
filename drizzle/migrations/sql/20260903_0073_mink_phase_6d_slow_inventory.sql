-- Migration 0073 — Mink Phase 6D: location-aware slow-inventory analysis and
-- a private, non-executable promotion recommendation.

ALTER TABLE public.mink_workflow_runs
  DROP CONSTRAINT mink_workflow_runs_template_check;

ALTER TABLE public.mink_workflow_runs
  ADD CONSTRAINT mink_workflow_runs_template_check CHECK (
    template IN (
      'weekly_trading_report',
      'revenue_decline_investigation',
      'product_launch_preparation',
      'slow_inventory_promotion'
    )
  );

-- Extend the published guide once, without replacing operator-authored edits
-- elsewhere in the article.
WITH phase6d(section) AS (
  VALUES ($phase6d$<h2>Find slow inventory and prepare a promotion</h2>
<p>Ask Mink to identify slow-moving inventory and prepare a private promotion recommendation over a complete <strong>30-day</strong> or <strong>90-day</strong> lookback. You need <strong>Analytics View</strong>, <strong>Products View</strong>, <strong>Inventory View</strong> and <strong>Offers Manage</strong>, and Mink drafting must be enabled for the store. You may name one exact accessible dashboard location, such as <strong>Shop</strong> or <strong>Delhi warehouse</strong>; otherwise Mink checks each accessible active physical location separately.</p>
<p>A candidate must be a published, inventory-tracked SKU with current positive on-hand stock whose product predates the complete lookback. Mink compares the current shelf with recognized order-item sales attributed to that same physical location. No sales in the window, or enough stock for at least two equal lookback periods at the observed rate, is marked for review. Zero-stock and untracked items are not called slow inventory. Shop stock cannot hide Delhi stock, and online or unassigned orders are not invented as physical-location demand. Current stock may have changed during the window, so the card never claims it was present for the whole period.</p>
<p>The durable card shows at most 20 highest-priority SKU-location shelves, their on-hand stock, units sold, estimated days of cover and sell-through, plus a maximum-five-SKU promotion concept. A conservative percentage may appear only when saved cost data supports a five-point gross-margin buffer and the store discount ceiling. Missing or insufficient margin data withholds the percentage instead of guessing.</p>
<p>This is a <strong>private recommendation only</strong>. Mink does not create or activate an offer, change a price or inventory quantity, choose recipients, or contact customers. The analysed location is evidence scope, not an offer-eligibility boundary. The merchant must separately verify exact product or variant scope plus channel and audience rules in Offers, choose a total budget, save any offer disabled for review, and approve activation in a separate human step. Sales history is not a forecast, and seasonality, incoming stock, traffic and advertising spend are not included.</p>
<p>The workflow captures exact active location IDs at queue time and rechecks drafting, store access, suspension, Analytics, Products, Inventory, Offers and location authority before background reads. Removed access cancels or narrows the next step; a location added later never enters the run. Work is bounded, restart-safe, cancellable and completed without additional Gemini calls or tokens.</p>
$phase6d$))
UPDATE public.help_articles AS article
SET excerpt = 'Use Mink AI for grounded answers, guarded actions and restart-safe trading, launch and slow-inventory workflows.',
    seo_description = 'Use permission-aware Mink AI for grounded store work, guarded actions, durable investigations and private slow-inventory promotion recommendations.',
    body = CASE
      WHEN article.body LIKE '%<h2>Draft troubleshooting</h2>%'
        THEN replace(
          article.body,
          '<h2>Draft troubleshooting</h2>',
          phase6d.section || E'\n<h2>Draft troubleshooting</h2>'
        )
      ELSE concat(article.body, E'\n', phase6d.section)
    END,
    updated_at = now()
FROM phase6d
WHERE article.slug = 'use-mink-ai-in-your-dashboard'
  AND article.body NOT LIKE '%<h2>Find slow inventory and prepare a promotion</h2>%';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'mink_workflow_runs_template_check'
      AND conrelid = 'public.mink_workflow_runs'::regclass
      AND pg_get_constraintdef(oid) LIKE '%slow_inventory_promotion%'
  ) THEN
    RAISE EXCEPTION 'Mink Phase 6D workflow template was not installed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.help_articles
    WHERE slug = 'use-mink-ai-in-your-dashboard'
      AND status = 'published'
      AND category_id IS NOT NULL
      AND body LIKE '%<h2>Find slow inventory and prepare a promotion</h2>%'
      AND body LIKE '%current positive on-hand stock%'
      AND body LIKE '%Zero-stock and untracked items are not called slow inventory%'
      AND body LIKE '%at most 20 highest-priority SKU-location shelves%'
      AND body LIKE '%maximum-five-SKU promotion concept%'
      AND body LIKE '%private recommendation only%'
      AND body LIKE '%not an offer-eligibility boundary%'
      AND body LIKE '%choose a total budget%'
      AND body LIKE '%approve activation in a separate human step%'
      AND body LIKE '%without additional Gemini calls or tokens%'
  ) THEN
    RAISE EXCEPTION 'Mink Phase 6D Help Centre guidance was not installed';
  END IF;
END $$;
