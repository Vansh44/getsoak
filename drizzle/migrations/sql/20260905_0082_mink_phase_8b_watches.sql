-- Forward-only 8B. No watch is enabled by this migration.
CREATE TABLE IF NOT EXISTS public.mink_watches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  admin_id text NOT NULL,
  creation_key uuid NOT NULL,
  kind text NOT NULL CONSTRAINT mink_watches_kind_check CHECK (kind IN ('brief','inventory','sales','returns','payments')),
  status text NOT NULL DEFAULT 'active' CONSTRAINT mink_watches_status_check CHECK (status IN ('active','paused','deleted')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  schedule_json jsonb NOT NULL CHECK (jsonb_typeof(schedule_json) = 'object'),
  input_json jsonb NOT NULL CHECK (jsonb_typeof(input_json) = 'object'),
  next_run_at timestamptz NOT NULL,
  last_run_id uuid, processed_run_id uuid, pending_run_id uuid,
  fingerprint text, last_alert_at timestamptz, error_code text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mink_watches_id_store_key UNIQUE (id, store_id),
  CONSTRAINT mink_watches_creation_key UNIQUE (store_id, admin_id, creation_key)
);
CREATE INDEX IF NOT EXISTS mink_watches_due_idx ON public.mink_watches (status, next_run_at);
CREATE INDEX IF NOT EXISTS mink_watches_owner_idx ON public.mink_watches (store_id, admin_id);
CREATE TABLE IF NOT EXISTS public.mink_watch_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  watch_id uuid NOT NULL REFERENCES public.mink_watches(id) ON DELETE CASCADE,
  event text NOT NULL, version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mink_watch_events_watch_idx ON public.mink_watch_events (watch_id, created_at);
ALTER TABLE public.mink_watches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mink_watch_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mink_watches, public.mink_watch_events FROM PUBLIC, app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.mink_watches TO app_service;
GRANT SELECT, INSERT, DELETE ON public.mink_watch_events TO app_service;
ALTER TABLE public.mink_workflow_runs ADD COLUMN IF NOT EXISTS watch_id uuid;
DO $watch_fk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.mink_workflow_runs'::regclass AND conname = 'mink_workflow_runs_watch_fk') THEN
    ALTER TABLE public.mink_workflow_runs ADD CONSTRAINT mink_workflow_runs_watch_fk
      FOREIGN KEY (watch_id, store_id) REFERENCES public.mink_watches(id, store_id) ON DELETE CASCADE;
  END IF;
END;
$watch_fk$;
CREATE INDEX IF NOT EXISTS mink_workflow_runs_watch_idx ON public.mink_workflow_runs (watch_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS activity_events_mink_watch_ready_key ON public.activity_events (store_id, type, subject_id)
  WHERE type = 'mink.watch_ready' AND subject_id IS NOT NULL;

DO $watch_help$
DECLARE
  guidance text := $guide$<h2>Enable private recurring Mink watches</h2>
<p>Open <strong>Watches</strong> in the Mink chat header, or ask &quot;Keep an eye on stock at Delhi&quot; or &quot;Give me a business brief every Monday.&quot; Mink shows the watch setup page; a chat request alone never enables, changes or deletes a watch. Choose Business brief, Low or out-of-stock inventory, Sales decline, Rising return activity or Failed-payment orders. Select all currently accessible locations or one exact location, a daily or weekly time, and optional quiet hours. Review the settings and tick the explicit consent box before choosing <strong>Enable watch</strong>.</p>
<p>Watches are private to the admin who enabled them. Creation and resume require Mink access plus Analytics, Products, Inventory and Orders View. They use the same four fixed evidence rules described in the business brief section, not arbitrary custom thresholds. Daily financial evidence covers yesterday; weekly covers the last seven completed local days. Inventory is current at the time of the check, per physical location. Stock in Delhi cannot conceal an empty shelf at Shop. This is scheduled monitoring, not real-time incident detection.</p>
<p>The timezone, location IDs and default inventory threshold are captured when you enable the watch. New locations never join an existing watch automatically. Changes to assignments, archived locations or permissions stop broader evidence from being reused and pause the watch. Pause/delete remain available with dashboard access when Mink is disabled. To change a watch's schedule, scope or quiet hours, delete it and create a new reviewed watch.</p>
<p>A scheduled business brief notifies for each new reporting period. Other watches notify when attention first appears. Sales, returns and payment watches stay quiet through the same attention episode, then can alert again after a later check detects recovery followed by new attention. Inventory re-alerts when per-location low/out-of-stock counts change. It is not an individual-SKU change feed: swapping affected SKUs without changing those counts does not generate another alert. Insufficient data is not proof of recovery or an all-clear.</p>
<p>Quiet hours use the captured store timezone; overnight intervals are supported. Checks still run, but notifications wait until quiet hours end and pending changes coalesce. A later completed check with no attention clears an undelivered alert. Alerts are private in-app notifications only, with no metrics in the notification preview. Reopening the result checks permissions again. No email, SMS, WhatsApp message, customer communication or automatic business action is sent. Scheduled checks use no Gemini calls or additional AI credits; normal chat costs still apply.</p>
<p>There are at most 5 watches per admin and 20 per store, including paused watches. Each watch has at most one check in progress. The existing worker picks up at most five due watches per heartbeat; time is approximate and missed intervals are skipped without a catch-up burst. Missing local times during daylight-saving changes skip that occurrence; repeated times run only once on that local day. Quiet hours with identical start/end times are rejected.</p>
<p>Use Refresh watches to see the latest completed evidence, errors and next check time. Source failure retries through the background workflow; exhausted retries pause the watch rather than reporting healthy zeroes. Review the error and use Resume to schedule the next future check. Pause or Delete stops pending work and suppresses undelivered alerts; an alert already delivered cannot be recalled. Delete is irreversible in the UI. Terminal scheduled snapshots older than 30 days are pruned in bounded batches, except the latest/pending evidence; deleted watches, their audit events and scheduled snapshots are purged after 30 days. Existing notifications follow the normal notification retention policy.</p>$guide$;
BEGIN
  UPDATE public.help_articles
  SET body = replace(body, 'Recurring watches are a later phase.', 'Recurring watches are configured separately as described below.'), updated_at = now()
  WHERE slug = 'use-mink-ai-in-your-dashboard' AND status = 'published';
  UPDATE public.help_articles SET body = body || E'\n' || guidance, updated_at = now()
  WHERE slug = 'use-mink-ai-in-your-dashboard' AND status = 'published' AND category_id IS NOT NULL
    AND position('<h2>Enable private recurring Mink watches</h2>' in body) = 0;
  IF NOT EXISTS (SELECT 1 FROM public.help_articles WHERE slug = 'use-mink-ai-in-your-dashboard' AND status = 'published'
    AND category_id IS NOT NULL AND position(guidance in body) > 0) THEN
    RAISE EXCEPTION 'Mink Phase 8B watch guidance was not installed; apply earlier Help migrations first';
  END IF;
END;
$watch_help$;
