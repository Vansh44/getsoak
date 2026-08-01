-- =============================================================
-- Notification CONSOLE — the manageable catalog (CODEBASE.md §22).
--
-- Replaces the earlier notifications_03_routing.sql (never applied anywhere):
-- routing turned out to be one field of a much larger per-notification
-- configuration, so it belongs on the settings row below rather than bolted
-- onto the personal-preference table.
--
-- THREE LAYERS, each with one owner:
--
--   1. lib/notifications/events.ts — the CODE registry. The contract of what
--      the platform can actually emit, and the only thing `emitEvent` will
--      type-check against. Ships every default: copy, category, channels,
--      audiences, and the variables each event exposes to a template.
--
--   2. notification_definitions — PLATFORM-GLOBAL, operator-managed. Lets a
--      StoreMink operator rename/recategorise a notification, or register a new
--      one ahead of the code that fires it, without a deploy. Empty by default;
--      a row here only OVERRIDES the registry.
--
--   3. notification_settings — PER STORE. What a merchant configures: which
--      channels are on, who receives it, and their own subject/message copy.
--
-- Resolution is registry ← definition ← store settings, the same shape as
-- lib/settings/registry.ts (convention #9), so an empty database behaves
-- exactly like the code defaults.
--
-- ⚠ Run as `postgres` against the target Cloud SQL database (through the Cloud
-- SQL Auth Proxy), after notifications_01_schema.sql. Idempotent.
-- =============================================================

-- ---- Platform definitions (operators) ---------------------------------------
-- No store_id, by design: this is StoreMink's own catalog, the platform_admins
-- model (mirrors help_categories/help_articles).
CREATE TABLE IF NOT EXISTS notification_definitions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Matches a registry EventKey, or is an operator-registered extra.
  key           TEXT NOT NULL,
  display_name  TEXT,
  description   TEXT,
  category      TEXT,
  "group"       TEXT,
  -- Channels an operator has switched on/off platform-wide. NULL = defer to
  -- the code registry (the common case).
  channels      JSONB,
  -- False hides it from every store's console without deleting its history.
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  -- True for operator-registered rows that no code path emits yet — the
  -- console labels these so nobody wonders why they never arrive.
  is_custom     BOOLEAN NOT NULL DEFAULT FALSE,
  created_by    TEXT,
  updated_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS notification_definitions_key_key
  ON notification_definitions (key);
CREATE INDEX IF NOT EXISTS notification_definitions_category_idx
  ON notification_definitions (category, key);

-- ---- Per-store configuration -------------------------------------------------
CREATE TABLE IF NOT EXISTS notification_settings (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id       UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  event_key      TEXT NOT NULL,
  -- Per-channel on/off, e.g. {"email": true, "web": true, "sms": false}.
  -- Absent keys defer to the resolved default, so a store that never touched
  -- a channel keeps following the platform.
  channels       JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Recipient routing: 'permission' (everyone who may view the event's
  -- section — the default) | 'roles' | 'admins'.
  --
  -- ⚠ TARGETING ONLY NARROWS. Naming someone who cannot view the section does
  -- NOT start sending it to them: a notification's copy is a preview of the
  -- thing itself ("New order ORD10010004 · ₹1,240 · from Priya S."), so
  -- routing must never become a side channel around the dashboard's own access
  -- rules. Enforced in lib/notifications/routing.ts and surfaced in the picker.
  routing        TEXT NOT NULL DEFAULT 'permission',
  target_roles   TEXT[] NOT NULL DEFAULT '{}'::text[],
  target_admins  TEXT[] NOT NULL DEFAULT '{}'::text[],
  -- Merchant copy per channel:
  --   {"email": {"subject": "...", "body": "...", "cc": "...", "bcc": "..."}}
  -- Channels absent here fall back to the built-in copy (lib/notifications/
  -- render.ts), so an unedited notification is always sensible and never empty.
  templates      JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Email batching for this event: instant | hourly | daily.
  digest         TEXT NOT NULL DEFAULT 'instant',
  -- A store can switch a whole notification off; the event is still AUDITED,
  -- it just stops notifying (the audit trail must stay complete).
  is_enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT notification_settings_routing_check
    CHECK (routing = ANY (ARRAY['permission'::text, 'roles'::text, 'admins'::text])),
  CONSTRAINT notification_settings_digest_check
    CHECK (digest = ANY (ARRAY['instant'::text, 'hourly'::text, 'daily'::text]))
);

CREATE UNIQUE INDEX IF NOT EXISTS notification_settings_store_event_key
  ON notification_settings (store_id, event_key);
CREATE INDEX IF NOT EXISTS notification_settings_store_idx
  ON notification_settings (store_id, event_key);

-- Shared catalog updated_at trigger (coupons_table.sql), as used by
-- store_pages / card_colors.
DROP TRIGGER IF EXISTS notification_definitions_updated_at_trigger ON notification_definitions;
CREATE TRIGGER notification_definitions_updated_at_trigger
  BEFORE UPDATE ON notification_definitions
  FOR EACH ROW EXECUTE FUNCTION update_catalog_updated_at();

DROP TRIGGER IF EXISTS notification_settings_updated_at_trigger ON notification_settings;
CREATE TRIGGER notification_settings_updated_at_trigger
  BEFORE UPDATE ON notification_settings
  FOR EACH ROW EXECUTE FUNCTION update_catalog_updated_at();

-- ---- Drop the routing columns from the preference table ----------------------
-- They moved to notification_settings above. notifications_03_routing.sql was
-- never applied to any environment, so these are almost certainly absent —
-- IF EXISTS makes this safe either way.
ALTER TABLE notification_preferences
  DROP CONSTRAINT IF EXISTS notification_preferences_routing_check;
ALTER TABLE notification_preferences
  DROP COLUMN IF EXISTS target_admins,
  DROP COLUMN IF EXISTS target_roles,
  DROP COLUMN IF EXISTS routing;

-- ---- RLS ---------------------------------------------------------------------
ALTER TABLE notification_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_settings    ENABLE ROW LEVEL SECURITY;

-- Every store's console needs to READ the platform catalog; only operators
-- write it. (Nothing sensitive lives here — it is copy and category labels.)
DROP POLICY IF EXISTS "Read notification_definitions" ON notification_definitions;
CREATE POLICY "Read notification_definitions" ON notification_definitions FOR SELECT
  USING (true);

DROP POLICY IF EXISTS "Write notification_definitions" ON notification_definitions;
CREATE POLICY "Write notification_definitions" ON notification_definitions FOR ALL
  USING ((SELECT is_platform_admin())) WITH CHECK ((SELECT is_platform_admin()));

-- A store's own configuration, readable and writable by its admins. The app
-- layer additionally gates on the `notifications` permission section, which is
-- what a superadmin grants to a role; this policy is the tenancy floor.
DROP POLICY IF EXISTS "Manage notification_settings" ON notification_settings;
CREATE POLICY "Manage notification_settings" ON notification_settings FOR ALL
  USING ((SELECT is_store_admin(store_id)))
  WITH CHECK ((SELECT is_store_admin(store_id)));

-- =============================================================
-- Rollback:
--   DROP TABLE IF EXISTS notification_settings CASCADE;
--   DROP TABLE IF EXISTS notification_definitions CASCADE;
-- =============================================================
