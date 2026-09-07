-- Forward-only 8C: no response or business action is approved by migration.
CREATE TABLE IF NOT EXISTS public.mink_watch_responses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL, watch_id uuid NOT NULL, admin_id text NOT NULL,
  source_run_id uuid NOT NULL, signal text NOT NULL,
  watch_version integer NOT NULL, plan_hash text NOT NULL,
  status text NOT NULL, workflow_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mink_watch_responses_source_key UNIQUE(watch_id, source_run_id, signal),
  CONSTRAINT mink_watch_responses_watch_fk FOREIGN KEY(watch_id, store_id) REFERENCES public.mink_watches(id, store_id) ON DELETE CASCADE,
  CONSTRAINT mink_watch_responses_source_fk FOREIGN KEY(source_run_id, store_id) REFERENCES public.mink_workflow_runs(id, store_id) ON DELETE CASCADE,
  CONSTRAINT mink_watch_responses_workflow_fk FOREIGN KEY(workflow_id, store_id) REFERENCES public.mink_workflow_runs(id, store_id) ON DELETE CASCADE,
  CONSTRAINT mink_watch_responses_status_check CHECK(status IN ('approved','dismissed')),
  CONSTRAINT mink_watch_responses_signal_check CHECK(signal IN ('inventory','payments','sales','returns')),
  CONSTRAINT mink_watch_responses_approval_check CHECK((status = 'approved' AND workflow_id IS NOT NULL) OR (status = 'dismissed' AND workflow_id IS NULL))
);
CREATE INDEX IF NOT EXISTS mink_watch_responses_owner_idx ON public.mink_watch_responses(store_id, admin_id, created_at);
ALTER TABLE public.mink_watch_responses ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mink_watch_responses FROM PUBLIC, app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.mink_watch_responses TO app_service;
ALTER TABLE public.mink_workflow_runs DROP CONSTRAINT IF EXISTS mink_workflow_runs_template_check;
ALTER TABLE public.mink_workflow_runs ADD CONSTRAINT mink_workflow_runs_template_check
  CHECK(template IN ('business_brief','watch_response_review','weekly_trading_report','revenue_decline_investigation','product_launch_preparation','slow_inventory_promotion','delayed_pickup_review'));

DO $response_help$
DECLARE
  guidance text := $guide$<h2>Review and approve a response to a watch alert</h2>
<p>In Mink AI, open Watches, then Suggested responses below a completed check. You can also ask &quot;What should I do about the Delhi stock alert?&quot; Mink can read and explain your response plans, but it cannot approve or dismiss them. Only the admin who owns the watch can see or approve its plans. No plan appears without an attention signal; an empty list is not an all-clear.</p>
<p>Plans use a fixed triage order: local stock availability, failed-payment orders, sales decline, then return activity. This is an operational review order, not an estimate of revenue, savings or causation. Each card shows its evidence, period, captured locations and timezone, expected benefit and limits. Monetary impact is unknown. A specific-signal watch offers only that signal; a Business brief watch can offer up to four.</p>
<p>Tick the consent box for the exact card and choose Approve investigation. This authorizes one read-only investigation, not business changes. Approval is bound to the evidence snapshot, watch version, captured scope and fixed limits. Plans expire 24 hours after the source check completes; a newer completed check or a changed watch invalidates an undecided old card. Refresh responses to review the latest evidence. Repeated approval of the same card returns the same workflow instead of running it twice. Dismiss hides approval for that snapshot; it does not pause the watch or dismiss future evidence.</p>
<p>The existing background worker collects fresh evidence for the approved daily or weekly window and current inventory. If the signal has recovered or evidence is insufficient, it explains that and does not invent a remedy. Inventory details show at most 20 SKU rows from at most 3 affected locations, prioritizing locations with more out-of-stock SKUs. Returns and failed payments show at most 20 records. Limited lists are labelled; use the dashboard for all records. Sales review compares recognized sales and orders; ask for a separate 7-, 30- or 90-day revenue investigation for deeper channel or product breakdowns. Returns are record counts, not a return rate; payment statuses are not provider attempt history. Customer names, email addresses and phone numbers are not included in response details.</p>
<p>Suggested next steps are not executed. Stock adjustments, prices, discounts, campaigns, customer messages and other business actions still require their existing individual permissions, exact targets, previews and approvals. This phase cannot move stock, issue refunds, retry payments or apply a remedy automatically. Approving a watch or investigation grants no ongoing business-write authority. There are no extra model calls or AI credits for this deterministic investigation.</p>
<p>There is at most one scheduled check or response running per watch. Its result card supports refresh and the existing cancel/retry controls. Source failures retry safely; no failed query becomes a healthy zero. Permissions, active locations and the approved watch version are rechecked before every step. Pause or Delete stops pending response work too; resuming a changed watch does not reauthorize an old investigation. An already completed read is not undone. The five most recent approved investigations remain available under Suggested responses while retained. Response decisions follow the source-watch snapshot retention: deleting a watch or pruning its source check eventually removes the decisions. Live deployment and the existing workflow heartbeat are required.</p>$guide$;
BEGIN
  UPDATE public.help_articles SET body = body || E'\n' || guidance, updated_at = now()
  WHERE slug = 'use-mink-ai-in-your-dashboard' AND status = 'published' AND category_id IS NOT NULL
    AND position('<h2>Review and approve a response to a watch alert</h2>' in body) = 0;
  IF NOT EXISTS (SELECT 1 FROM public.help_articles WHERE slug = 'use-mink-ai-in-your-dashboard' AND status = 'published' AND category_id IS NOT NULL AND position(guidance in body) > 0) THEN
    RAISE EXCEPTION 'Mink Phase 8C guidance was not installed; apply previous Help migrations first';
  END IF;
END;
$response_help$;
