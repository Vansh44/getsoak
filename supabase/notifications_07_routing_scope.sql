-- Notifications — location-aware routing (roadmap §1.5).
--
-- Run as `postgres`, after locations_03.
--
-- Staff bound to a location were still emailed about every store's-worth of
-- activity: routing knew about permissions, roles and named admins, but had no
-- location axis at all. `routing_scope` supplies one.
--
-- It is a SCOPE, not a fourth mode. "People with the orders permission, at this
-- order's location" is a mode AND a scope; making location a mode would
-- multiply the list every time another axis appears.
--
-- Defaults to 'store' — today's behaviour — so nothing changes until a merchant
-- switches an event over.

BEGIN;

ALTER TABLE public.notification_settings
  ADD COLUMN IF NOT EXISTS routing_scope text NOT NULL DEFAULT 'store';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'notification_settings_routing_scope_check'
  ) THEN
    ALTER TABLE public.notification_settings
      ADD CONSTRAINT notification_settings_routing_scope_check
      CHECK (routing_scope IN ('store', 'event_location'));
  END IF;
END $$;

COMMENT ON COLUMN public.notification_settings.routing_scope IS
  'store = everyone in the store (default); event_location = only staff assigned to the location the event happened at.';

COMMIT;

-- ── Rollback ────────────────────────────────────────────────────────────────
-- BEGIN;
-- ALTER TABLE public.notification_settings
--   DROP CONSTRAINT IF EXISTS notification_settings_routing_scope_check;
-- ALTER TABLE public.notification_settings DROP COLUMN IF EXISTS routing_scope;
-- COMMIT;
