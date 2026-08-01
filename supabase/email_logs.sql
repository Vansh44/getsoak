-- =============================================================
-- Email logs — every message this platform sends, per store (CODEBASE.md §22).
--
-- Until now "did that email go out?" had no answer. Notification mail left a
-- row in notification_email_queue, campaign mail in email_campaign_recipients,
-- and everything else — OTP codes, staff invites, billing receipts, enquiry
-- alerts — left no trace at all. A merchant asking "did my customer get their
-- order confirmation?" could not be answered without server logs.
--
-- This is the ONE table that answers it, written by the single send choke point
-- (lib/email/send.ts). It is a LOG, not a queue: nothing reads it to decide
-- what to do next, so it can be pruned freely.
--
-- ⚠ SENSITIVE MAILERS ARE REDACTED AT WRITE TIME. An OTP email carries its code
-- in the SUBJECT as well as the body, so storing it verbatim would put a live
-- credential in a table that store staff can read. lib/email/mailers.ts marks
-- those types and the writer stores a placeholder instead — the delivery
-- metadata (who, when, did it send) is what a log is for, and that survives.
--
-- ⚠ Run as `postgres` against the target Cloud SQL database (through the Cloud
-- SQL Auth Proxy). Idempotent.
-- =============================================================

CREATE TABLE IF NOT EXISTS email_logs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL = platform mail (operator OTP, StoreMink billing) — it belongs to no
  -- store and must never show up in a store's log.
  store_id       UUID REFERENCES stores(id) ON DELETE CASCADE,
  to_email       TEXT NOT NULL,
  from_email     TEXT NOT NULL,
  cc             TEXT,
  bcc            TEXT,
  subject        TEXT,
  -- WHICH kind of mail this is: order_confirmation, user_otp, staff_invite…
  -- The registry lives in lib/email/mailers.ts; this column is free text so an
  -- old row keeps its meaning after the registry is renamed.
  mailer         TEXT NOT NULL,
  -- How it left: 'resend' today; 'smtp' when a store brings its own sender.
  provider       TEXT NOT NULL DEFAULT 'resend',
  -- 'sent' | 'failed' | 'skipped' (a suppressed address, or no API key set).
  status         TEXT NOT NULL,
  error          TEXT,
  -- The provider's id for the message, so a support question can be traced
  -- into the Resend dashboard.
  provider_message_id TEXT,
  -- The rendered HTML, so "what did they actually receive?" is answerable.
  -- NULL for sensitive mailers (see the note above) and for anything oversized.
  body_html      TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT email_logs_status_check
    CHECK (status = ANY (ARRAY['sent'::text, 'failed'::text, 'skipped'::text]))
);

-- The list view: one store's mail, newest first.
CREATE INDEX IF NOT EXISTS email_logs_store_created_idx
  ON email_logs (store_id, created_at DESC);
-- The "show me only the failures" filter, which is why anyone opens this page.
CREATE INDEX IF NOT EXISTS email_logs_status_idx
  ON email_logs (store_id, status, created_at DESC);
-- Searching for one recipient's history.
CREATE INDEX IF NOT EXISTS email_logs_to_idx
  ON email_logs (to_email, created_at DESC);
-- Retention sweeps.
CREATE INDEX IF NOT EXISTS email_logs_created_idx
  ON email_logs (created_at);

-- Worker/action-only, like notification_email_queue: RLS ON with NO policies,
-- so every read and write goes through the service role. The rows hold email
-- addresses and message bodies; the app layer gates reads on the `activity`
-- permission section AND scopes them to the host store.
ALTER TABLE email_logs ENABLE ROW LEVEL SECURITY;

-- =============================================================
-- Rollback:
--   DROP TABLE IF EXISTS email_logs;
-- =============================================================
