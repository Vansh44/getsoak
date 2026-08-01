-- =============================================================
-- POS Phase 1 (follow-up) — self-service PIN / password reset
--
-- A cashier who forgets their PIN mid-rush must not have to wait for an admin.
-- "Forgot PIN or password?" on /pos/login emails them a single-use link
-- (/pos/reset?token=…) with a SHORT TTL — the reset counterpart of the
-- invite_token used at registration, kept in its own columns so the two flows
-- can never be confused (an invite sets up an account; a reset re-credentials an
-- already-active one).
--
-- ⚠ Run as `postgres` AFTER pos_03_staff_devices.sql. Idempotent.
-- =============================================================

ALTER TABLE pos_staff ADD COLUMN IF NOT EXISTS reset_token      TEXT;
ALTER TABLE pos_staff ADD COLUMN IF NOT EXISTS reset_expires_at TIMESTAMPTZ;

-- Token lookup is the hot path of the reset page.
CREATE INDEX IF NOT EXISTS pos_staff_reset_token_idx
  ON pos_staff (reset_token) WHERE reset_token IS NOT NULL;

-- =============================================================
-- Rollback:
--   DROP INDEX IF EXISTS pos_staff_reset_token_idx;
--   ALTER TABLE pos_staff DROP COLUMN IF EXISTS reset_expires_at;
--   ALTER TABLE pos_staff DROP COLUMN IF EXISTS reset_token;
-- =============================================================
