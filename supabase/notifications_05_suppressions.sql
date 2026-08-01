-- =============================================================
-- Email suppression list (CODEBASE.md §22).
--
-- Resend ACCEPTING a message is not delivery. Without this table a hard-bouncing
-- address was re-mailed on every future notification forever: the send "works",
-- the row is marked sent, and the mail lands nowhere. Worse, repeated bounces
-- damage the SHARED sending domain — every store sends from storemink.com by
-- default (lib/email/sender.ts), so one store's dead address degrades
-- deliverability for all of them.
--
-- ⚠ DELIBERATELY GLOBAL — NO store_id. This is the ONE table in the notification
-- system that isn't tenant-scoped, and that is the point: an address that hard-
-- bounces bounces for everyone, and the reputation it costs is the platform's,
-- not one store's. Same model as platform_admins / help_categories. Scoping it
-- per store would mean 40 stores each learning the same dead address the hard
-- way, on a domain they all share.
--
-- Only PERMANENT signals land here — hard bounces and spam complaints. A soft
-- bounce (full mailbox, greylisting, transient server error) must never
-- suppress: it resolves on its own and the queue's own retry/backoff covers it.
--
-- ⚠ Run as `postgres` against the target Cloud SQL database (through the Cloud
-- SQL Auth Proxy), after notifications_02_email_queue.sql. Idempotent.
-- =============================================================

CREATE TABLE IF NOT EXISTS email_suppressions (
  -- The address itself is the key: lower-cased on write so lookups can't miss
  -- a suppression through casing (Foo@x.com and foo@x.com are one mailbox).
  email        TEXT PRIMARY KEY,
  -- 'bounce' (permanent delivery failure) | 'complaint' (marked as spam) |
  -- 'manual' (an operator added it).
  reason       TEXT NOT NULL,
  -- Provider sub-type, kept verbatim for diagnosis ("Permanent", "Suppressed").
  detail       TEXT,
  -- Which provider event or person put it here.
  source       TEXT NOT NULL DEFAULT 'resend',
  -- Bumped every time the provider tells us again, so a stale entry is
  -- distinguishable from an address that is still actively failing.
  last_event_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT email_suppressions_reason_check
    CHECK (reason = ANY (ARRAY['bounce'::text, 'complaint'::text, 'manual'::text]))
);

CREATE INDEX IF NOT EXISTS email_suppressions_created_idx
  ON email_suppressions (created_at DESC);

-- Worker-only, exactly like notification_email_queue: RLS ON with NO policies,
-- so every read and write goes through the service role. The rows are email
-- addresses; nothing client-side has any business enumerating them.
ALTER TABLE email_suppressions ENABLE ROW LEVEL SECURITY;

-- ---- Delivery failures need a surface ---------------------------------------
-- A row that burns through its retries used to be marked 'failed' and that was
-- the end of it — visible only to someone running SQL. This index backs the
-- store-scoped "recent delivery failures" panel in the notification console.
CREATE INDEX IF NOT EXISTS notification_email_queue_failed_idx
  ON notification_email_queue (store_id, created_at DESC)
  WHERE status = 'failed';

-- =============================================================
-- Rollback:
--   DROP INDEX IF EXISTS notification_email_queue_failed_idx;
--   DROP TABLE IF EXISTS email_suppressions;
-- =============================================================
