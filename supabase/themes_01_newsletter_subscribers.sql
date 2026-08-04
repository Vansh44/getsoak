-- Store-scoped newsletter consent for the Phase 3 newsletter section and
-- footer form. Run as postgres. Idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS newsletter_subscribers (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id     UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  email        TEXT NOT NULL CHECK (email = lower(btrim(email))),
  status       TEXT NOT NULL DEFAULT 'active'
               CHECK (status IN ('active', 'unsubscribed')),
  source       TEXT NOT NULL DEFAULT 'section'
               CHECK (source IN ('footer', 'section')),
  consent_text TEXT NOT NULL,
  consented_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS newsletter_subscribers_store_email_key
  ON newsletter_subscribers (store_id, email);
CREATE INDEX IF NOT EXISTS idx_newsletter_subscribers_store_status
  ON newsletter_subscribers (store_id, status);

CREATE OR REPLACE FUNCTION public.touch_newsletter_subscribers_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS newsletter_subscribers_touch_updated_at
  ON newsletter_subscribers;
CREATE TRIGGER newsletter_subscribers_touch_updated_at
  BEFORE UPDATE ON newsletter_subscribers
  FOR EACH ROW EXECUTE FUNCTION public.touch_newsletter_subscribers_updated_at();

ALTER TABLE newsletter_subscribers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Store admins read newsletter subscribers"
  ON newsletter_subscribers;
CREATE POLICY "Store admins read newsletter subscribers"
  ON newsletter_subscribers FOR SELECT TO authenticated
  USING ((SELECT is_store_admin(store_id)));

-- Anonymous visitors submit through the server action. Direct PostgREST
-- inserts are intentionally unavailable so validation, host-derived tenancy,
-- consent recording and rate limiting cannot be bypassed.
REVOKE ALL ON newsletter_subscribers FROM anon;
REVOKE ALL ON newsletter_subscribers FROM authenticated;
GRANT SELECT ON newsletter_subscribers TO authenticated;

COMMIT;

-- ROLLBACK:
-- BEGIN;
-- DROP TRIGGER IF EXISTS newsletter_subscribers_touch_updated_at
--   ON newsletter_subscribers;
-- DROP FUNCTION IF EXISTS public.touch_newsletter_subscribers_updated_at();
-- DROP TABLE IF EXISTS newsletter_subscribers CASCADE;
-- COMMIT;
