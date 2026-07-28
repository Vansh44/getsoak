-- =============================================================
-- Legal documents + consent (CODEBASE.md §24).
--
-- Two tables with very different jobs:
--
--   legal_documents  — StoreMink's OWN policies (terms, privacy, …), versioned.
--                      PLATFORM-GLOBAL: no store_id, like platform_admins and
--                      help_categories. A merchant's own store policies are
--                      NOT here — those are ordinary store_pages rows written
--                      by the guided editor (the decision not to build a second
--                      CMS).
--
--   legal_acceptances — who agreed to what, when, from where. APPEND-ONLY.
--
-- ══ WHY A VERSION AND A CHECKSUM ══════════════════════════════════════════
-- "The user accepted the terms" is worth nothing without "…which said THIS".
-- Each published version stores the exact body plus a sha256 of it, and an
-- acceptance references the version id. So years later you can produce the
-- precise words someone agreed to, and prove they haven't been edited since.
-- A published row is therefore IMMUTABLE — a change means a NEW version, never
-- an UPDATE. The trigger below enforces that rather than trusting callers.
--
-- ══ WHY ACCEPTANCE IS NEVER A CLIENT BOOLEAN ══════════════════════════════
-- A checkbox in a browser is a UI affordance, not evidence: anyone can POST
-- `accepted: true`, and a form can be replayed. The row is written SERVER-SIDE
-- at the moment the account/order is created, from the request's own IP and
-- user agent. The client never says "I accepted" — the server observes it.
--
-- ⚠ Run as `postgres` against the target Cloud SQL database (through the Cloud
-- SQL Auth Proxy). Idempotent.
-- =============================================================

-- ---- Platform policy documents ----------------------------------------------
CREATE TABLE IF NOT EXISTS legal_documents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Which policy this is a version of: 'terms' | 'privacy' | 'refunds' | …
  -- Free text so a new document type needs no migration; the code registry
  -- (lib/legal/documents.ts) is the list that's actually offered.
  kind          TEXT NOT NULL,
  -- Monotonic per kind. Displayed to humans ("v3"), referenced by acceptances.
  version       INTEGER NOT NULL,
  title         TEXT NOT NULL,
  -- Sanitised HTML, the same trust model as blog/help content.
  body          TEXT NOT NULL,
  -- sha256 of `body` at publish time. Lets an audit prove the text is the text.
  checksum      TEXT NOT NULL,
  -- The date the version takes effect — may be later than published_at when a
  -- change needs notice given before it binds anyone.
  effective_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- NULL until published. A draft can be edited freely; a published row cannot.
  published_at  TIMESTAMPTZ,
  -- True for the version currently in force for this kind. Exactly one per kind
  -- (partial unique index below) — the storefront and the consent gate both ask
  -- "what must be accepted right now?" and that must have one answer.
  is_current    BOOLEAN NOT NULL DEFAULT FALSE,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT legal_documents_version_positive CHECK (version > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS legal_documents_kind_version_key
  ON legal_documents (kind, version);

-- At most one current version per kind.
CREATE UNIQUE INDEX IF NOT EXISTS legal_documents_current_key
  ON legal_documents (kind) WHERE is_current;

CREATE INDEX IF NOT EXISTS legal_documents_kind_idx
  ON legal_documents (kind, version DESC);

-- ---- Published versions are immutable ---------------------------------------
-- Enforced in the DATABASE, not the action: the whole value of an acceptance
-- record is that the text behind it cannot have moved. `is_current` and
-- `updated_at` are the only fields a publish/retire flow needs to touch.
CREATE OR REPLACE FUNCTION public.legal_documents_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.published_at IS NOT NULL AND (
       NEW.body       IS DISTINCT FROM OLD.body
    OR NEW.checksum   IS DISTINCT FROM OLD.checksum
    OR NEW.kind       IS DISTINCT FROM OLD.kind
    OR NEW.version    IS DISTINCT FROM OLD.version
    OR NEW.title      IS DISTINCT FROM OLD.title
  ) THEN
    RAISE EXCEPTION
      'legal_documents: version % of "%" is published and immutable — publish a new version instead',
      OLD.version, OLD.kind;
  END IF;
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS legal_documents_guard_trigger ON legal_documents;
CREATE TRIGGER legal_documents_guard_trigger
  BEFORE UPDATE ON legal_documents
  FOR EACH ROW EXECUTE FUNCTION public.legal_documents_guard();

-- Deleting a published version would orphan every acceptance that points at it.
CREATE OR REPLACE FUNCTION public.legal_documents_no_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.published_at IS NOT NULL THEN
    RAISE EXCEPTION
      'legal_documents: published versions cannot be deleted (acceptances reference them)';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS legal_documents_no_delete_trigger ON legal_documents;
CREATE TRIGGER legal_documents_no_delete_trigger
  BEFORE DELETE ON legal_documents
  FOR EACH ROW EXECUTE FUNCTION public.legal_documents_no_delete();

-- ---- Acceptances -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS legal_acceptances (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- RESTRICT, not CASCADE: an acceptance outliving its document text would be
  -- worthless, and the delete guard above should make this unreachable anyway.
  document_id  UUID NOT NULL REFERENCES legal_documents(id) ON DELETE RESTRICT,
  -- Denormalised so a report needs no join, and survives a kind rename.
  kind         TEXT NOT NULL,
  version      INTEGER NOT NULL,
  -- WHO. A Firebase uid (text — see phase6_01) for a signed-in person.
  user_id      TEXT NOT NULL,
  -- Snapshotted: the address they used is evidence, and an account can change
  -- its email later.
  email        TEXT,
  -- WHICH SIDE of the platform they were on. 'merchant' = someone signing up
  -- for StoreMink; 'customer' = a shopper on a store (store_id then set).
  actor_type   TEXT NOT NULL,
  store_id     UUID REFERENCES stores(id) ON DELETE SET NULL,
  -- WHERE they were when they agreed: 'signup' | 'signin' | 'checkout' | 'reaccept'.
  context      TEXT NOT NULL,
  -- Evidence. Both best-effort — behind a proxy the IP may be absent, and
  -- neither is worth failing a signup over.
  ip           TEXT,
  user_agent   TEXT,
  accepted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT legal_acceptances_actor_check
    CHECK (actor_type = ANY (ARRAY['merchant'::text, 'customer'::text])),
  CONSTRAINT legal_acceptances_context_check
    CHECK (context = ANY (ARRAY['signup'::text, 'signin'::text, 'checkout'::text, 'reaccept'::text]))
);

-- "Has this person accepted the current version?" — the consent gate's question.
CREATE UNIQUE INDEX IF NOT EXISTS legal_acceptances_user_document_key
  ON legal_acceptances (user_id, document_id);

CREATE INDEX IF NOT EXISTS legal_acceptances_user_idx
  ON legal_acceptances (user_id, kind);
CREATE INDEX IF NOT EXISTS legal_acceptances_store_idx
  ON legal_acceptances (store_id, accepted_at DESC)
  WHERE store_id IS NOT NULL;

-- Append-only: an acceptance is a historical fact. Retracting consent is a
-- FUTURE event (a new row, or an account deletion), never an edit to the past.
CREATE OR REPLACE FUNCTION public.legal_acceptances_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'legal_acceptances is append-only';
END;
$$;

DROP TRIGGER IF EXISTS legal_acceptances_append_only_trigger ON legal_acceptances;
CREATE TRIGGER legal_acceptances_append_only_trigger
  BEFORE UPDATE OR DELETE ON legal_acceptances
  FOR EACH ROW EXECUTE FUNCTION public.legal_acceptances_append_only();

-- ---- Marketing opt-in --------------------------------------------------------
-- The optional "send me product updates" box that sits UNDER the mandatory
-- consent tick. Kept deliberately apart from legal_acceptances: agreeing to the
-- Terms is a contract, opting into marketing is a preference someone may change
-- at any time. Storing them in one place would blur a distinction that matters
-- if either is ever challenged.
--
-- It lives on `admins` because it is a property of the PERSON, not of a store —
-- one human with three stores has one mailing preference.
ALTER TABLE admins
  ADD COLUMN IF NOT EXISTS marketing_opt_in BOOLEAN NOT NULL DEFAULT FALSE;

-- ---- RLS ---------------------------------------------------------------------
ALTER TABLE legal_documents   ENABLE ROW LEVEL SECURITY;
ALTER TABLE legal_acceptances ENABLE ROW LEVEL SECURITY;

-- Published policies are public by definition — they have to be readable by
-- someone who hasn't signed up yet.
DROP POLICY IF EXISTS "Read published legal_documents" ON legal_documents;
CREATE POLICY "Read published legal_documents" ON legal_documents FOR SELECT
  USING (published_at IS NOT NULL);

DROP POLICY IF EXISTS "Write legal_documents" ON legal_documents;
CREATE POLICY "Write legal_documents" ON legal_documents FOR ALL
  USING ((SELECT is_platform_admin())) WITH CHECK ((SELECT is_platform_admin()));

-- Acceptances are evidence about a person: they read their own, operators read
-- all. Writes are SERVICE-ROLE ONLY — no client may assert its own consent
-- (the whole point of the table).
DROP POLICY IF EXISTS "Read own legal_acceptances" ON legal_acceptances;
CREATE POLICY "Read own legal_acceptances" ON legal_acceptances FOR SELECT
  USING (user_id = (SELECT auth.uid()) OR (SELECT is_platform_admin()));

-- =============================================================
-- Rollback:
--   ALTER TABLE admins DROP COLUMN IF EXISTS marketing_opt_in;
--   DROP TABLE IF EXISTS legal_acceptances;
--   DROP TABLE IF EXISTS legal_documents;
--   DROP FUNCTION IF EXISTS public.legal_documents_guard();
--   DROP FUNCTION IF EXISTS public.legal_documents_no_delete();
--   DROP FUNCTION IF EXISTS public.legal_acceptances_append_only();
-- =============================================================
