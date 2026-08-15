-- =============================================================
-- Platform announcements — StoreMink telling its MERCHANTS something
-- (CODEBASE.md §38, docs/operator-console.md).
--
-- Distinct from every other messaging table in this codebase:
--   • notification_email_queue  = an EVENT fanned out to identified recipients
--   • email_campaigns           = a MERCHANT mailing THEIR shoppers
--   • platform_announcements    = the PLATFORM mailing its merchants
--
-- ── ★ RECIPIENTS ARE MATERIALISED AT SEND, NOT RESOLVED AT DELIVERY ────────
-- The audience is a query over a moving target: stores sign up, staff leave,
-- plans lapse. Resolving it once and writing a row per person makes the send
-- (a) idempotent — a retried worker claims rows rather than re-running a query
-- that now returns different people, (b) resumable across the 60s request
-- ceiling, and (c) AUDITABLE: "who was told, and when?" is answerable months
-- later, which for a policy or pricing notice is the only thing that matters.
-- The alternative — resolve-and-send in one pass — cannot answer any of the
-- three, and silently mails a different set on every retry.
--
-- ── ★ THE SNAPSHOT IS THE POINT OF `email` / `phone` / `name` ──────────────
-- Copied at resolve time, like notification_email_queue's. If an admin changes
-- their address mid-send the queued mail still goes where it was addressed,
-- and a deleted account leaves a row that says who was told rather than an
-- unresolvable id.
--
-- ── ★ SERVICE-ROLE ONLY: RLS enabled, NO policies ─────────────────────────
-- The rows are every merchant's name, email and phone in one table. Nothing
-- but the operator console (through withService) has any business reading it,
-- and no client ever should. Same posture as email_logs and the two queues.
--
-- ⚠ Run as `postgres` against the target Cloud SQL database (through the Cloud
-- SQL Auth Proxy). Idempotent.
-- =============================================================

CREATE TABLE IF NOT EXISTS platform_announcements (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Operator-facing name, never sent. The subject is what merchants see.
  title         TEXT NOT NULL,

  -- ★ CATEGORY DECIDES WHETHER CONSENT APPLIES, so it is a column and not a
  -- UI checkbox. 'feature' is marketing and honours admins.marketing_opt_in;
  -- 'operational' is service correspondence about an account someone already
  -- has (an outage, a policy change, a billing deadline) and does not.
  -- Recording it means an opt-out complaint can be answered with the row.
  category      TEXT NOT NULL DEFAULT 'feature',

  -- Email copy. `body` is sanitized merchant-facing HTML, rendered inside the
  -- standard email shell so it can never break the layout.
  subject       TEXT NOT NULL DEFAULT '',
  body          TEXT NOT NULL DEFAULT '',
  -- Optional call to action, rendered as the shell's one button.
  cta_label     TEXT,
  cta_url       TEXT,

  -- ★ SMS COPY IS A SEPARATE FIELD, not a truncation of `body`. A DLT template
  -- is a fixed, registered string with marked variables (§37) — deriving it
  -- from HTML would produce a body no carrier accepts.
  sms_body      TEXT,
  dlt_template_id TEXT,

  -- Which channels this announcement uses: {"email": true, "sms": false}.
  channels      JSONB NOT NULL DEFAULT '{"email": true, "sms": false}'::jsonb,

  -- The audience filter, kept verbatim so "who did this go to?" is answerable
  -- even after the estate has changed underneath it.
  audience      JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- draft → sending → sent | partial | failed. `partial` is a real outcome,
  -- not a failure: some recipients bounced and the rest were told, and calling
  -- that "failed" invites someone to send the whole thing again.
  status        TEXT NOT NULL DEFAULT 'draft',

  total         INTEGER NOT NULL DEFAULT 0,
  sent          INTEGER NOT NULL DEFAULT 0,
  failed        INTEGER NOT NULL DEFAULT 0,
  skipped       INTEGER NOT NULL DEFAULT 0,

  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at       TIMESTAMPTZ,

  CONSTRAINT platform_announcements_status_check
    CHECK (status = ANY (ARRAY['draft','sending','sent','partial','failed'])),
  CONSTRAINT platform_announcements_category_check
    CHECK (category = ANY (ARRAY['feature','operational']))
);

CREATE INDEX IF NOT EXISTS platform_announcements_created_idx
  ON platform_announcements (created_at DESC);
CREATE INDEX IF NOT EXISTS platform_announcements_status_idx
  ON platform_announcements (status);

-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS platform_announcement_recipients (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  announcement_id UUID NOT NULL
                    REFERENCES platform_announcements(id) ON DELETE CASCADE,

  -- One row per person PER CHANNEL. A merchant who gets both the email and the
  -- text has two rows, because they succeed and fail independently and
  -- "delivered" has to be answerable per channel.
  channel         TEXT NOT NULL,

  -- Snapshotted identity (see the header).
  email           TEXT,
  phone           TEXT,
  name            TEXT,

  -- Where they came from, so the log can say "this went to 14 Pro owners".
  store_id        UUID REFERENCES stores(id) ON DELETE SET NULL,
  person_kind     TEXT,
  role            TEXT,

  -- pending → sending → sent | failed | skipped. `skipped` is deliberate and
  -- distinct from failed: suppressed address, no consent, no phone number. A
  -- skip is a decision we made; a failure is one the provider made.
  status          TEXT NOT NULL DEFAULT 'pending',
  error           TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  claimed_at      TIMESTAMPTZ,
  sent_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT platform_announcement_recipients_channel_check
    CHECK (channel = ANY (ARRAY['email','sms'])),
  CONSTRAINT platform_announcement_recipients_status_check
    CHECK (status = ANY (ARRAY['pending','sending','sent','failed','skipped']))
);

-- ★ THE SAME PERSON IS TOLD ONCE PER CHANNEL, ENFORCED BY THE DATABASE.
-- An operator who resolves the audience twice (a double-click, a retried
-- action) must not double-mail 400 merchants. Two partial indexes because
-- email and phone are separately nullable — a single index over both columns
-- would let a NULL slip past.
CREATE UNIQUE INDEX IF NOT EXISTS platform_announcement_recipients_email_key
  ON platform_announcement_recipients (announcement_id, channel, lower(email))
  WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS platform_announcement_recipients_phone_key
  ON platform_announcement_recipients (announcement_id, channel, phone)
  WHERE phone IS NOT NULL;

CREATE INDEX IF NOT EXISTS platform_announcement_recipients_pending_idx
  ON platform_announcement_recipients (announcement_id, created_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS platform_announcement_recipients_claimed_idx
  ON platform_announcement_recipients (claimed_at) WHERE status = 'sending';
CREATE INDEX IF NOT EXISTS platform_announcement_recipients_announcement_idx
  ON platform_announcement_recipients (announcement_id, status);

-- ---- Claim / recover (the email_campaigns.sql pattern) ----------------------
-- FOR UPDATE SKIP LOCKED so the cron tick and a self-chained drain can run
-- concurrently without ever claiming the same row.

CREATE OR REPLACE FUNCTION claim_announcement_batch(
  p_channel TEXT,
  p_limit   INTEGER DEFAULT 100
)
RETURNS SETOF platform_announcement_recipients
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH claimed AS (
    SELECT r.id
      FROM public.platform_announcement_recipients r
      JOIN public.platform_announcements a ON a.id = r.announcement_id
     WHERE r.status = 'pending'
       AND r.channel = p_channel
       AND a.status = 'sending'
     ORDER BY r.created_at
     LIMIT p_limit
     FOR UPDATE OF r SKIP LOCKED
  )
  UPDATE public.platform_announcement_recipients r
     SET status = 'sending', claimed_at = NOW(), attempts = r.attempts + 1
    FROM claimed
   WHERE r.id = claimed.id
  RETURNING r.*;
$$;

-- A worker killed mid-batch leaves rows 'sending' forever. Recover them the way
-- the campaign queue does, rather than letting an announcement stall silently.
CREATE OR REPLACE FUNCTION requeue_stale_announcement_recipients(
  p_older_than_seconds INTEGER DEFAULT 600
)
RETURNS INTEGER
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH requeued AS (
    UPDATE public.platform_announcement_recipients
       SET status = 'pending', claimed_at = NULL
     WHERE status = 'sending'
       AND claimed_at < NOW() - (p_older_than_seconds || ' seconds')::interval
       -- Give up rather than loop forever on a row that kills the worker.
       AND attempts < 3
    RETURNING 1
  )
  SELECT COALESCE(COUNT(*), 0)::int FROM requeued;
$$;

-- ---- RLS: on, with no policies (service-role only) --------------------------
ALTER TABLE platform_announcements            ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_announcement_recipients  ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON platform_announcements           FROM anon, authenticated;
REVOKE ALL ON platform_announcement_recipients FROM anon, authenticated;

-- ---- Rollback ---------------------------------------------------------------
-- DROP FUNCTION IF EXISTS requeue_stale_announcement_recipients(INTEGER);
-- DROP FUNCTION IF EXISTS claim_announcement_batch(TEXT, INTEGER);
-- DROP TABLE IF EXISTS platform_announcement_recipients;
-- DROP TABLE IF EXISTS platform_announcements;
