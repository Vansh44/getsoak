-- Migration 0074 — Mink Phase 6E: PII-minimized delayed-pickup review and
-- private, duplicate-safe communication preparation.

ALTER TABLE public.mink_workflow_runs
  DROP CONSTRAINT mink_workflow_runs_template_check;

ALTER TABLE public.mink_workflow_runs
  ADD CONSTRAINT mink_workflow_runs_template_check CHECK (
    template IN (
      'weekly_trading_report',
      'revenue_decline_investigation',
      'product_launch_preparation',
      'slow_inventory_promotion',
      'delayed_pickup_review'
    )
  );

-- Extend the published guide once. The workflow itself is read-only: the
-- existing pickup expiry/reminder sweeps remain the only pickup-state writers.
WITH phase6e(section) AS (
  VALUES ($phase6e$<h2>Review delayed pickups and prepare communication guidance</h2>
<p>Ask Mink to review delayed, overdue, unprepared, uncollected or at-risk pickup orders and prepare private communication guidance. You need <strong>Orders Manage</strong>, and Mink drafting must be enabled for the store. Name one exact accessible dashboard location, such as <strong>Shop</strong> or <strong>Delhi warehouse</strong>, or let Mink review every accessible active physical location while keeping each order's location explicit.</p>
<p>The durable review includes live Awaiting or Ready pickups when the promised ready time has passed or the collection deadline is inside StoreMink's existing <strong>48-hour reminder window</strong>. It returns at most 25 highest-priority orders. Collected, expired, cancelled and fully refunded orders are excluded. Each row shows only its order reference, location and pickup lifecycle times. Customer names, email addresses, phone numbers, postal addresses, notes and collection codes are never included.</p>
<p>For an unprepared order, Mink can prepare generic delay copy with placeholders for the order reference, location and a staff-confirmed revised ready time. This copy remains inside the private workflow card for human review; it is not a saved Mink draft and is never sent or queued automatically. Staff must verify the live order and confirm a truthful revised time before adapting or sending anything manually.</p>
<p>StoreMink's existing pickup reminder sweep remains authoritative. If a Ready pickup is inside the reminder window and its one-time reminder is pending or already recorded, Mink withholds duplicate collection-reminder copy. Mink never claims or resets the one-time reminder marker, sends a notification, changes pickup or order status, extends a deadline, cancels an order, releases a stock hold or moves inventory.</p>
<p>The workflow captures exact active location IDs at queue time and rechecks store access, suspension, Orders Manage, Mink drafting and location authority before every background step. Removed access cancels or narrows the next step; a location added later never enters the run. Work is bounded, restart-safe, cancellable and completed without additional Gemini calls or tokens. Because pickup state can change after the snapshot, always verify the linked live order before manual contact.</p>
$phase6e$)
UPDATE public.help_articles AS article
SET excerpt = 'Use Mink AI for grounded answers, guarded actions and restart-safe trading, launch, inventory and pickup workflows.',
    seo_description = 'Use permission-aware Mink AI for grounded store work, guarded actions, durable investigations and private PII-minimized pickup reviews.',
    body = CASE
      WHEN article.body LIKE '%<h2>Draft troubleshooting</h2>%'
        THEN replace(
          article.body,
          '<h2>Draft troubleshooting</h2>',
          phase6e.section || E'\n<h2>Draft troubleshooting</h2>'
        )
      ELSE concat(article.body, E'\n', phase6e.section)
    END,
    updated_at = now()
FROM phase6e
WHERE article.slug = 'use-mink-ai-in-your-dashboard'
  AND article.body NOT LIKE '%<h2>Review delayed pickups and prepare communication guidance</h2>%';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'mink_workflow_runs_template_check'
      AND conrelid = 'public.mink_workflow_runs'::regclass
      AND pg_get_constraintdef(oid) LIKE '%delayed_pickup_review%'
  ) THEN
    RAISE EXCEPTION 'Mink Phase 6E workflow template was not installed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.help_articles
    WHERE slug = 'use-mink-ai-in-your-dashboard'
      AND status = 'published'
      AND category_id IS NOT NULL
      AND body LIKE '%<h2>Review delayed pickups and prepare communication guidance</h2>%'
      AND body LIKE '%Orders Manage%'
      AND body LIKE '%48-hour reminder window%'
      AND body LIKE '%at most 25 highest-priority orders%'
      AND body LIKE '%Customer names, email addresses, phone numbers, postal addresses, notes and collection codes are never included%'
      AND body LIKE '%not a saved Mink draft%'
      AND body LIKE '%withholds duplicate collection-reminder copy%'
      AND body LIKE '%never claims or resets the one-time reminder marker%'
      AND body LIKE '%verify the linked live order before manual contact%'
  ) THEN
    RAISE EXCEPTION 'Mink Phase 6E Help Centre guidance was not installed';
  END IF;
END $$;
