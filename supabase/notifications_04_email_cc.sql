-- =============================================================
-- Cc / Bcc on queued notification emails (CODEBASE.md §22).
--
-- The console collects Cc and Bcc per notification, but the queue had nowhere
-- to put them and the worker never passed them to Resend — so they were saved
-- and silently dropped. These columns close that gap.
--
-- SNAPSHOTTED AT ENQUEUE, like the subject and body: mail that's already
-- queued keeps the recipients it was addressed to, so editing the setting
-- never retroactively copies someone in on a message they weren't part of.
--
-- ⚠ Run as `postgres` against the target Cloud SQL database (through the Cloud
-- SQL Auth Proxy), after notifications_02_email_queue.sql. Idempotent.
-- =============================================================

ALTER TABLE notification_email_queue
  ADD COLUMN IF NOT EXISTS cc  TEXT,
  ADD COLUMN IF NOT EXISTS bcc TEXT;

-- =============================================================
-- Rollback:
--   ALTER TABLE notification_email_queue
--     DROP COLUMN IF EXISTS bcc,
--     DROP COLUMN IF EXISTS cc;
-- =============================================================
