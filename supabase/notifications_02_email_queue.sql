-- =============================================================
-- Notification EMAIL queue — the second delivery channel for the event spine
-- (supabase/notifications_01_schema.sql, CODEBASE.md §22).
--
-- WHY A QUEUE AND NOT AN INLINE SEND: a notification is emitted from inside a
-- checkout, a status change, a blog submission. Putting a Resend round-trip on
-- that path would make an unrelated third-party outage able to slow — or fail —
-- a sale. So the fan-out only ENQUEUES, and a worker drains the queue, exactly
-- like the coupon campaign queue (email_campaigns.sql) whose claim/requeue
-- pattern this mirrors.
--
-- DIGESTS: a row is eligible once `send_after` passes. 'instant' rows are due
-- immediately; 'hourly'/'daily' rows are dated to the end of their window, so
-- everything that lands in one window leaves as ONE grouped email. This is what
-- keeps a store doing 400 orders a day from sending 400 emails to its owner.
--
-- SERVICE-ROLE ONLY, like the campaign queue: RLS is enabled with NO policies,
-- so nothing but the worker (BYPASSRLS) can read or write it. The rows contain
-- recipients' email addresses — there is no reason for any client to see them.
--
-- ⚠ Run as `postgres` against the target Cloud SQL database (through the Cloud
-- SQL Auth Proxy), after notifications_01_schema.sql. Idempotent.
-- =============================================================

CREATE TABLE IF NOT EXISTS notification_email_queue (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id       UUID REFERENCES stores(id) ON DELETE CASCADE,
  event_id       UUID NOT NULL REFERENCES activity_events(id) ON DELETE CASCADE,
  -- Firebase uid, or a lowercased email for an operator (see the notifications
  -- RLS note in notifications_01_schema.sql).
  recipient_id   TEXT NOT NULL,
  recipient_type TEXT NOT NULL,
  -- Snapshotted at enqueue time: if the admin later changes their address, the
  -- queued mail still goes where it was addressed, and a deleted account
  -- doesn't strand an unsendable row.
  email          TEXT NOT NULL,
  event_key      TEXT NOT NULL,
  digest         TEXT NOT NULL DEFAULT 'instant',
  -- The rendered copy, copied from the notification so the worker needs no
  -- joins and no re-render (and old mail can't be rewritten by a template edit).
  title          TEXT NOT NULL,
  body           TEXT,
  url            TEXT,
  severity       TEXT NOT NULL DEFAULT 'info',
  status         TEXT NOT NULL DEFAULT 'pending',
  -- Eligible from this moment. Instant = now; hourly/daily = end of window.
  send_after     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at     TIMESTAMPTZ,
  sent_at        TIMESTAMPTZ,
  attempts       INTEGER NOT NULL DEFAULT 0,
  last_error     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT notification_email_queue_status_check
    CHECK (status = ANY (ARRAY['pending'::text, 'sending'::text, 'sent'::text, 'failed'::text])),
  CONSTRAINT notification_email_queue_digest_check
    CHECK (digest = ANY (ARRAY['instant'::text, 'hourly'::text, 'daily'::text]))
);

-- Idempotent enqueue: the same event can never be mailed to the same person
-- twice, however many times the fan-out is retried (mirrors the UNIQUE on
-- notifications).
CREATE UNIQUE INDEX IF NOT EXISTS notification_email_queue_event_recipient_key
  ON notification_email_queue (event_id, recipient_id);

-- The claim query: due pending rows, oldest window first.
CREATE INDEX IF NOT EXISTS notification_email_queue_due_idx
  ON notification_email_queue (send_after, created_at)
  WHERE status = 'pending';
-- Digest grouping + the stale-claim sweep.
CREATE INDEX IF NOT EXISTS notification_email_queue_recipient_idx
  ON notification_email_queue (recipient_id, send_after);
CREATE INDEX IF NOT EXISTS notification_email_queue_claimed_idx
  ON notification_email_queue (claimed_at) WHERE status = 'sending';
CREATE INDEX IF NOT EXISTS notification_email_queue_created_idx
  ON notification_email_queue (created_at);

-- ---- Claim / recover (the email_campaigns.sql pattern) -----------------------
-- FOR UPDATE SKIP LOCKED means the cron tick and a self-chained drain can run
-- concurrently without ever grabbing the same row — the property that makes it
-- safe to kick the worker on every enqueue.
--
-- `attempts` is incremented AT CLAIM TIME, not on success: a row that kills the
-- worker mid-send (an OOM, a timeout) still counts its try, so a poison message
-- is retried a bounded number of times instead of forever.
CREATE OR REPLACE FUNCTION public.claim_notification_emails(p_limit INTEGER)
RETURNS SETOF public.notification_email_queue
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  UPDATE public.notification_email_queue q
  SET status = 'sending', claimed_at = NOW(), attempts = q.attempts + 1
  WHERE q.id IN (
    SELECT id FROM public.notification_email_queue
    WHERE status = 'pending' AND send_after <= NOW()
    ORDER BY send_after, created_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  RETURNING q.*;
$$;

-- Recover rows stuck in 'sending' from a crashed run. Rows that have burned
-- through their retries are parked as 'failed' rather than cycling forever.
CREATE OR REPLACE FUNCTION public.requeue_stale_notification_emails(
  p_older_than_seconds INTEGER DEFAULT 600,
  p_max_attempts INTEGER DEFAULT 3
)
RETURNS INTEGER
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH updated AS (
    UPDATE public.notification_email_queue
    SET status = CASE WHEN attempts >= p_max_attempts THEN 'failed' ELSE 'pending' END,
        claimed_at = NULL,
        last_error = CASE
          WHEN attempts >= p_max_attempts
            THEN 'Abandoned after ' || attempts || ' attempts (worker never reported back)'
          ELSE last_error
        END
    WHERE status = 'sending'
      AND claimed_at < NOW() - make_interval(secs => p_older_than_seconds)
    RETURNING 1
  )
  SELECT COUNT(*)::INTEGER FROM updated;
$$;

-- Worker-only. Revoke the default PUBLIC EXECUTE so no client can drain, stall,
-- or inspect the queue.
REVOKE EXECUTE ON FUNCTION public.claim_notification_emails(integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.requeue_stale_notification_emails(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_notification_emails(integer) TO app_service;
GRANT EXECUTE ON FUNCTION public.requeue_stale_notification_emails(integer, integer) TO app_service;

-- ---- RLS ---------------------------------------------------------------------
-- Enabled with NO policies: the queue is worker-only (service role bypasses
-- RLS). Deliberate — see the header.
ALTER TABLE notification_email_queue ENABLE ROW LEVEL SECURITY;

-- =============================================================
-- Rollback:
--   DROP FUNCTION IF EXISTS requeue_stale_notification_emails(integer, integer);
--   DROP FUNCTION IF EXISTS claim_notification_emails(integer);
--   DROP TABLE IF EXISTS notification_email_queue CASCADE;
-- =============================================================
