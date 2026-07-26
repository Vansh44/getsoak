-- =============================================================
-- POS Phase 1 — staff, location assignments, paired devices, pairing codes
--
-- The POS identity model (docs/pos-plan.md §3):
--   * pos_staff        — in-store operators (cashier/manager) with real accounts:
--                        admin invites by name/email/role, staff self-register
--                        (phone OTP → 8-digit PIN → password), creating a Firebase
--                        account (`user_id` = uid) with a cashier/manager role
--                        claim. `status` invited→active. pin_hash is a scrypt hash
--                        — SENSITIVE, admin-only + read for PIN login via the
--                        service role. Login is email + PIN/password.
--   * pos_staff_locations — which locations a staff member may operate at
--                        (managers are location-bound; auto-scoped at login).
--   * pos_devices      — DEVICE AUTHORIZATION: a browser the owner has authorized
--                        to run POS at a location (a long-lived signed pos_device
--                        cookie references one). Staff can only log in on an
--                        authorized device. Revocable.
--   * pos_pairing_codes — short-lived single-use codes an admin generates to
--                        authorize a device remotely (fallback to the owner
--                        authorizing on the device itself).
--
-- Writes go through gated server actions (service role); RLS keeps reads
-- store-admin-only (pin_hash is never exposed to anon/customers). New tables
-- created by postgres inherit app_user/app_service grants (ALTER DEFAULT
-- PRIVILEGES in drizzle/manual/0000_compat_setup.sql). ⚠ Run as postgres AFTER
-- pos_00/01/02. Idempotent.
-- =============================================================

-- -------------------------------------------------------------
-- 1. pos_staff
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pos_staff (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id          UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  user_id           TEXT,                              -- Firebase uid (set at registration)
  name              TEXT NOT NULL,
  email             TEXT NOT NULL,
  role              TEXT NOT NULL DEFAULT 'cashier' CHECK (role IN ('cashier', 'manager')),
  pin_hash          TEXT,                              -- scrypt; set by the staff at registration
  status            TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'disabled')),
  invite_token      TEXT,                              -- single-use registration token
  invite_expires_at TIMESTAMPTZ,
  active            BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Self-heal a pos_staff created by an EARLIER draft of this file (which had no
-- email/status/invite columns — the superseded admin-set-PIN model). CREATE
-- TABLE IF NOT EXISTS silently no-ops on an existing table, so without these the
-- index below fails with: column "email" does not exist.
ALTER TABLE pos_staff ADD COLUMN IF NOT EXISTS email             TEXT;
ALTER TABLE pos_staff ADD COLUMN IF NOT EXISTS status            TEXT NOT NULL DEFAULT 'invited';
ALTER TABLE pos_staff ADD COLUMN IF NOT EXISTS invite_token      TEXT;
ALTER TABLE pos_staff ADD COLUMN IF NOT EXISTS invite_expires_at TIMESTAMPTZ;

-- Legacy rows (if any) predate the email-based login and can't sign in; give them
-- a unique, obviously-invalid placeholder so the UNIQUE index below can be built.
-- Re-invite those staff from the dashboard.
UPDATE pos_staff
   SET email = id::text || '@needs-reinvite.invalid'
 WHERE email IS NULL;

ALTER TABLE pos_staff ALTER COLUMN email SET NOT NULL;

-- The status CHECK is added separately so it also lands on a self-healed table.
ALTER TABLE pos_staff DROP CONSTRAINT IF EXISTS pos_staff_status_check;
ALTER TABLE pos_staff ADD CONSTRAINT pos_staff_status_check
  CHECK (status IN ('invited', 'active', 'disabled'));

CREATE INDEX IF NOT EXISTS pos_staff_store_idx ON pos_staff (store_id);
-- One staff row per email per store (login is by email); one Firebase account link.
CREATE UNIQUE INDEX IF NOT EXISTS pos_staff_store_email_idx
  ON pos_staff (store_id, lower(email));
CREATE UNIQUE INDEX IF NOT EXISTS pos_staff_store_user_idx
  ON pos_staff (store_id, user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS pos_staff_invite_token_idx
  ON pos_staff (invite_token) WHERE invite_token IS NOT NULL;

ALTER TABLE pos_staff ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Store admins manage pos_staff" ON pos_staff;
CREATE POLICY "Store admins manage pos_staff"
  ON pos_staff FOR ALL
  USING ((SELECT is_store_admin(store_id)))
  WITH CHECK ((SELECT is_store_admin(store_id)));

-- -------------------------------------------------------------
-- 2. pos_staff_locations (store_id denormalised for simple RLS)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pos_staff_locations (
  staff_id    UUID NOT NULL REFERENCES pos_staff(id) ON DELETE CASCADE,
  location_id UUID NOT NULL REFERENCES store_locations(id) ON DELETE CASCADE,
  store_id    UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  is_primary  BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (staff_id, location_id)
);
CREATE INDEX IF NOT EXISTS pos_staff_locations_staff_idx ON pos_staff_locations (staff_id);

ALTER TABLE pos_staff_locations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Store admins manage pos_staff_locations" ON pos_staff_locations;
CREATE POLICY "Store admins manage pos_staff_locations"
  ON pos_staff_locations FOR ALL
  USING ((SELECT is_store_admin(store_id)))
  WITH CHECK ((SELECT is_store_admin(store_id)));

-- -------------------------------------------------------------
-- 3. pos_devices — a paired register (bound to a location)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pos_devices (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id     UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  location_id  UUID NOT NULL REFERENCES store_locations(id) ON DELETE CASCADE,
  label        TEXT NOT NULL DEFAULT '',
  revoked_at   TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pos_devices_store_idx ON pos_devices (store_id);

ALTER TABLE pos_devices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Store admins manage pos_devices" ON pos_devices;
CREATE POLICY "Store admins manage pos_devices"
  ON pos_devices FOR ALL
  USING ((SELECT is_store_admin(store_id)))
  WITH CHECK ((SELECT is_store_admin(store_id)));

-- -------------------------------------------------------------
-- 4. pos_pairing_codes — short-lived single-use device-pairing codes
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pos_pairing_codes (
  code        TEXT PRIMARY KEY,
  store_id    UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  location_id UUID NOT NULL REFERENCES store_locations(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pos_pairing_codes_store_idx ON pos_pairing_codes (store_id);

ALTER TABLE pos_pairing_codes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Store admins manage pos_pairing_codes" ON pos_pairing_codes;
CREATE POLICY "Store admins manage pos_pairing_codes"
  ON pos_pairing_codes FOR ALL
  USING ((SELECT is_store_admin(store_id)))
  WITH CHECK ((SELECT is_store_admin(store_id)));

-- =============================================================
-- Rollback:
--   DROP TABLE IF EXISTS pos_pairing_codes CASCADE;
--   DROP TABLE IF EXISTS pos_devices CASCADE;
--   DROP TABLE IF EXISTS pos_staff_locations CASCADE;
--   DROP TABLE IF EXISTS pos_staff CASCADE;
-- =============================================================
