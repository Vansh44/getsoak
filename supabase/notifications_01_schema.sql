-- =============================================================
-- Notifications & activity — the platform-wide event spine.
--
-- THE MODEL: one append-only EVENT LOG (`activity_events`) records what
-- happened; a registry-driven router fans each event out into per-recipient
-- INBOX rows (`notifications`). Nothing in the app inserts a notification
-- directly — actions emit an event and the router decides who hears about it.
-- That is what keeps "notify on every activity" from becoming 60 hand-written
-- notification inserts scattered across the server actions.
--
--   activity_events          : append-only. Doubles as the audit trail rendered
--                              at /dashboard/activity.
--   notifications            : one row per (event, recipient). The bell inbox.
--   notification_preferences : per-store defaults + per-user overrides of the
--                              registry's default channels.
--
-- TENANCY: `store_id` is NULLABLE, and NULL means PLATFORM-LEVEL (a StoreMink
-- operator event such as "store created" / "plan changed") — the same split
-- `platform_admins` draws. Every store-scoped read MUST still filter by
-- store_id; the RLS policies below enforce it independently.
--
-- WRITES ARE SERVICE-ROLE ONLY. There is deliberately no INSERT policy on any
-- of these tables for clients: a customer must not be able to forge an audit
-- entry or push a notification to an admin's bell. The recorder runs under
-- withService after the calling action has already authorised the actor
-- (same trust model as orders — see supabase/orders_table.sql).
--
-- ⚠ Run as `postgres` against the target Cloud SQL database (through the Cloud
-- SQL Auth Proxy), exactly like the other migrations. New public-schema tables
-- created by postgres inherit app_user/app_service grants from the
-- ALTER DEFAULT PRIVILEGES in drizzle/manual/0000_compat_setup.sql, so no
-- explicit GRANTs are needed here. Idempotent — safe to re-run.
-- =============================================================

-- ---- Event log ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS activity_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL = platform-level event (no single store owns it).
  store_id      UUID REFERENCES stores(id) ON DELETE CASCADE,
  -- Registry key from lib/notifications/events.ts, e.g. 'order.placed'.
  type          TEXT NOT NULL,
  -- WHO did it. actor_id is a Firebase uid (text) or NULL for system actors;
  -- no FK, because it may point at admins, users, or a platform operator.
  actor_type    TEXT NOT NULL DEFAULT 'system',
  actor_id      TEXT,
  -- Denormalised display label ("Priya S.", "Cron"). Snapshotted on purpose:
  -- an audit line must still read correctly after the actor is renamed or
  -- deleted, and rendering the feed must never need six joins.
  actor_label   TEXT,
  -- WHAT it happened to (order / product / blog / …), same snapshot rule.
  subject_type  TEXT,
  subject_id    TEXT,
  subject_label TEXT,
  -- Event-specific extras (order total, old/new status …). Keep it small and
  -- NEVER put a secret in here: store admins can read every event of their store.
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip            TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT activity_events_actor_type_check
    CHECK (actor_type = ANY (ARRAY['customer'::text, 'admin'::text, 'operator'::text, 'system'::text]))
);

-- The feed: newest-first within a store, optionally filtered by type or actor.
CREATE INDEX IF NOT EXISTS activity_events_store_idx
  ON activity_events (store_id, created_at DESC);
CREATE INDEX IF NOT EXISTS activity_events_store_type_idx
  ON activity_events (store_id, type, created_at DESC);
CREATE INDEX IF NOT EXISTS activity_events_actor_idx
  ON activity_events (actor_id, created_at DESC) WHERE actor_id IS NOT NULL;
-- Platform-level feed (store_id IS NULL) for the operator console.
CREATE INDEX IF NOT EXISTS activity_events_platform_idx
  ON activity_events (created_at DESC) WHERE store_id IS NULL;
-- Retention sweep (the cron deletes events older than the window).
CREATE INDEX IF NOT EXISTS activity_events_created_idx
  ON activity_events (created_at);

-- ---- Inbox -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id       UUID REFERENCES stores(id) ON DELETE CASCADE,
  event_id       UUID NOT NULL REFERENCES activity_events(id) ON DELETE CASCADE,
  -- WHO is being told. recipient_id is a Firebase uid (text); no FK because it
  -- may be an admins.id, a users.id, or a platform operator's uid.
  recipient_type TEXT NOT NULL,
  recipient_id   TEXT NOT NULL,
  -- Copied from the event so the inbox renders without joining the log.
  type           TEXT NOT NULL,
  title          TEXT NOT NULL,
  body           TEXT,
  -- Where clicking the notification goes (a dashboard or storefront path).
  url            TEXT,
  severity       TEXT NOT NULL DEFAULT 'info',
  read_at        TIMESTAMPTZ,
  archived_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT notifications_recipient_type_check
    CHECK (recipient_type = ANY (ARRAY['admin'::text, 'customer'::text, 'operator'::text])),
  CONSTRAINT notifications_severity_check
    CHECK (severity = ANY (ARRAY['info'::text, 'success'::text, 'warning'::text, 'critical'::text]))
);

-- Idempotent fan-out: a retried/duplicated router pass can never double-notify.
CREATE UNIQUE INDEX IF NOT EXISTS notifications_event_recipient_key
  ON notifications (event_id, recipient_id);
-- The inbox query: this recipient's live notifications, newest first.
CREATE INDEX IF NOT EXISTS notifications_recipient_idx
  ON notifications (recipient_id, created_at DESC) WHERE archived_at IS NULL;
-- The bell's unread badge — a tiny partial index so the count stays O(unread).
CREATE INDEX IF NOT EXISTS notifications_unread_idx
  ON notifications (recipient_id, created_at DESC)
  WHERE read_at IS NULL AND archived_at IS NULL;
CREATE INDEX IF NOT EXISTS notifications_created_idx
  ON notifications (created_at);

-- ---- Preferences -------------------------------------------------------------
-- Resolution order (lib/notifications/events.ts owns the defaults):
--   registry default  ←  store default (scope='store')  ←  user override (scope='user')
-- A NULL channel column means "don't override at this level", so a store can
-- set a default without freezing every staff member's personal choice.
CREATE TABLE IF NOT EXISTS notification_preferences (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id     UUID REFERENCES stores(id) ON DELETE CASCADE,
  scope        TEXT NOT NULL DEFAULT 'user',
  -- '' for scope='store' (the row belongs to the store, not a person).
  recipient_id TEXT NOT NULL DEFAULT '',
  event_key    TEXT NOT NULL,
  in_app       BOOLEAN,
  email        BOOLEAN,
  -- 'instant' | 'hourly' | 'daily' — email batching for this event.
  digest       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT notification_preferences_scope_check
    CHECK (scope = ANY (ARRAY['store'::text, 'user'::text])),
  CONSTRAINT notification_preferences_digest_check
    CHECK (digest IS NULL OR digest = ANY (ARRAY['instant'::text, 'hourly'::text, 'daily'::text])),
  -- A store-scoped row is nobody's personal preference, and a user row must
  -- name its user. Enforced here so the two scopes can never be confused.
  CONSTRAINT notification_preferences_scope_recipient_check
    CHECK ((scope = 'store' AND recipient_id = '') OR (scope = 'user' AND recipient_id <> ''))
);

-- Upsert keys. Two PARTIAL unique indexes rather than one over a nullable
-- store_id: in Postgres NULLs are distinct, so a plain UNIQUE would happily
-- allow duplicate platform-operator rows.
CREATE UNIQUE INDEX IF NOT EXISTS notification_preferences_store_key
  ON notification_preferences (store_id, scope, recipient_id, event_key)
  WHERE store_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS notification_preferences_platform_key
  ON notification_preferences (scope, recipient_id, event_key)
  WHERE store_id IS NULL;
CREATE INDEX IF NOT EXISTS notification_preferences_lookup_idx
  ON notification_preferences (recipient_id, store_id);

-- Reuse the shared catalog updated_at trigger fn (coupons_table.sql), same as
-- store_pages / card_colors.
DROP TRIGGER IF EXISTS notification_preferences_updated_at_trigger ON notification_preferences;
CREATE TRIGGER notification_preferences_updated_at_trigger
  BEFORE UPDATE ON notification_preferences
  FOR EACH ROW EXECUTE FUNCTION update_catalog_updated_at();

-- ---- RLS ---------------------------------------------------------------------
-- Reads only. Every write goes through withService in lib/notifications/*,
-- after the calling action has authorised the actor — so the absence of an
-- INSERT/DELETE policy here is the design, not an omission.
ALTER TABLE activity_events          ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications            ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;

-- The audit trail of a store is visible to that store's admins; platform-level
-- events (store_id IS NULL) only to StoreMink operators. Delegating to
-- is_store_admin() — never an inlined `FROM admins` — is what keeps a platform
-- operator from being locked out of a store they manage (convention #2).
DROP POLICY IF EXISTS "Read activity_events" ON activity_events;
CREATE POLICY "Read activity_events" ON activity_events FOR SELECT
  USING (
    CASE WHEN store_id IS NULL
      THEN (SELECT is_platform_admin())
      ELSE (SELECT is_store_admin(store_id))
    END
  );

-- A notification belongs to exactly one person: only they may read it, and a
-- store admin has no business reading a colleague's (or a customer's) inbox.
--
-- Admins and customers are keyed by Firebase uid. OPERATORS are keyed by
-- lowercased EMAIL, because `platform_admins` is an email allowlist with no
-- uid column — a StoreMink operator has no uid of their own unless they also
-- happen to be staff of some store. `auth.email()` (the app.current_user_email
-- GUC) is already set on every user-scoped transaction, so matching on it costs
-- nothing and keeps one uniform inbox for all three recipient types.
DROP POLICY IF EXISTS "Read own notifications" ON notifications;
CREATE POLICY "Read own notifications" ON notifications FOR SELECT
  USING (
    CASE WHEN recipient_type = 'operator'
      THEN lower((SELECT auth.email())) = recipient_id
      ELSE (SELECT auth.uid()) = recipient_id
    END
  );

-- Mark-read / archive. The USING clause pins the row to its owner; the actions
-- are the ones that restrict WHICH columns may change (RLS cannot).
DROP POLICY IF EXISTS "Update own notifications" ON notifications;
CREATE POLICY "Update own notifications" ON notifications FOR UPDATE
  USING (
    CASE WHEN recipient_type = 'operator'
      THEN lower((SELECT auth.email())) = recipient_id
      ELSE (SELECT auth.uid()) = recipient_id
    END
  )
  WITH CHECK (
    CASE WHEN recipient_type = 'operator'
      THEN lower((SELECT auth.email())) = recipient_id
      ELSE (SELECT auth.uid()) = recipient_id
    END
  );

-- Personal preferences: own rows. Store defaults: the store's admins.
DROP POLICY IF EXISTS "Manage own notification_preferences" ON notification_preferences;
CREATE POLICY "Manage own notification_preferences" ON notification_preferences FOR ALL
  USING (scope = 'user' AND (SELECT auth.uid()) = recipient_id)
  WITH CHECK (scope = 'user' AND (SELECT auth.uid()) = recipient_id);

DROP POLICY IF EXISTS "Manage store notification_preferences" ON notification_preferences;
CREATE POLICY "Manage store notification_preferences" ON notification_preferences FOR ALL
  USING (scope = 'store' AND store_id IS NOT NULL AND (SELECT is_store_admin(store_id)))
  WITH CHECK (scope = 'store' AND store_id IS NOT NULL AND (SELECT is_store_admin(store_id)));

-- =============================================================
-- Rollback:
--   DROP TABLE IF EXISTS notification_preferences CASCADE;
--   DROP TABLE IF EXISTS notifications CASCADE;
--   DROP TABLE IF EXISTS activity_events CASCADE;
-- =============================================================
