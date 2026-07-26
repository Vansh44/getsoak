-- =============================================================
-- POS Phase 1 (hardening) — device-token rotation, clone detection, audit log
--
-- Threat being closed: a signed pos_device cookie COPIED off a trusted device
-- (devtools on an unlocked shop tablet, a stolen profile) previously worked for
-- its full lifetime with nothing to detect it.
--
-- Mitigation = rotation + reuse detection (the refresh-token-rotation pattern):
--   * pos_devices.token_nonce is embedded in the signed cookie and ROTATED
--     every time an operator signs in on that device.
--   * Presenting a nonce that is neither current nor the just-rotated previous
--     one (inside a short grace window that absorbs in-flight requests) means
--     two copies of the cookie exist → fail secure: revoke the device and log
--     it, so the owner sees it and re-authorizes deliberately.
--
-- pos_audit_log records the security-relevant POS events (device authorized /
-- revoked, operator sign-in, clone detected). Append-only, admin-readable —
-- a till system must be able to answer "who sold this, on which device".
--
-- ⚠ Run as `postgres` AFTER pos_04_staff_reset.sql. Idempotent.
-- =============================================================

-- -------------------------------------------------------------
-- 1. pos_devices — rotation state + richer revocation metadata
-- -------------------------------------------------------------
ALTER TABLE pos_devices ADD COLUMN IF NOT EXISTS token_nonce      TEXT;
ALTER TABLE pos_devices ADD COLUMN IF NOT EXISTS prev_nonce       TEXT;
ALTER TABLE pos_devices ADD COLUMN IF NOT EXISTS prev_nonce_until TIMESTAMPTZ;
ALTER TABLE pos_devices ADD COLUMN IF NOT EXISTS revoked_reason   TEXT;
ALTER TABLE pos_devices ADD COLUMN IF NOT EXISTS revoked_by       TEXT;
ALTER TABLE pos_devices ADD COLUMN IF NOT EXISTS authorized_by    TEXT;
ALTER TABLE pos_devices ADD COLUMN IF NOT EXISTS last_ip          TEXT;

-- -------------------------------------------------------------
-- 2. pos_audit_log — append-only security trail
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pos_audit_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id    UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  event       TEXT NOT NULL,          -- device_authorized | device_revoked |
                                      -- device_clone_detected | operator_login |
                                      -- operator_login_failed | credential_reset
  device_id   UUID,                   -- no FK: the row must survive device deletion
  staff_id    UUID,
  location_id UUID,
  actor       TEXT,                   -- uid / email / staff name, as available
  ip          TEXT,
  detail      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pos_audit_log_store_idx
  ON pos_audit_log (store_id, created_at DESC);
CREATE INDEX IF NOT EXISTS pos_audit_log_device_idx
  ON pos_audit_log (device_id, created_at DESC) WHERE device_id IS NOT NULL;

-- Read-only to store admins; writes go through the service role only (the app
-- appends, nobody edits — the stock_movements model).
ALTER TABLE pos_audit_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Store admins read pos_audit_log" ON pos_audit_log;
CREATE POLICY "Store admins read pos_audit_log"
  ON pos_audit_log FOR SELECT
  USING ((SELECT is_store_admin(store_id)));

-- =============================================================
-- Rollback:
--   DROP TABLE IF EXISTS pos_audit_log CASCADE;
--   ALTER TABLE pos_devices DROP COLUMN IF EXISTS last_ip;
--   ALTER TABLE pos_devices DROP COLUMN IF EXISTS authorized_by;
--   ALTER TABLE pos_devices DROP COLUMN IF EXISTS revoked_by;
--   ALTER TABLE pos_devices DROP COLUMN IF EXISTS revoked_reason;
--   ALTER TABLE pos_devices DROP COLUMN IF EXISTS prev_nonce_until;
--   ALTER TABLE pos_devices DROP COLUMN IF EXISTS prev_nonce;
--   ALTER TABLE pos_devices DROP COLUMN IF EXISTS token_nonce;
-- =============================================================
