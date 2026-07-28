-- =============================================================
-- Shopper consent to a STORE's own policies (CODEBASE.md §24).
--
-- legal_acceptances already carries actor_type 'customer', store_id and
-- context 'signup'/'checkout' — it was built for this. The one thing it
-- couldn't do is say WHICH document, because document_id is a NOT NULL FK to
-- legal_documents, and a store's refund policy is not a legal_document. It's a
-- store_pages row: mutable, unversioned, and rightly so — a shop owner should
-- be able to reword their returns policy on a Tuesday without a release
-- process.
--
-- So an acceptance is now anchored to EITHER a platform document (immutable,
-- versioned) OR a store policy page (slug + a hash of the text at the moment
-- they agreed). The CHECK makes sure it's always exactly one — a row anchored
-- to nothing is a record that someone agreed to something unspecified, which
-- is worth less than no record at all.
--
-- WHY A CHECKSUM AND NOT A SNAPSHOT. Storing the full policy per shopper would
-- duplicate a few KB across every customer of every store. The hash is 64
-- bytes and answers the question that actually matters in a dispute: has this
-- text changed since they agreed? If it hasn't, the live page IS the evidence.
-- If it has, you know, instead of quietly showing today's wording and calling
-- it what they accepted.
--
-- ⚠ Run as `postgres` against the target Cloud SQL database (through the Cloud
-- SQL Auth Proxy). Idempotent. Requires legal_01_schema.sql.
-- =============================================================

-- A platform document is no longer the only possible anchor.
ALTER TABLE legal_acceptances
  ALTER COLUMN document_id DROP NOT NULL;

-- The store-policy anchor: which page, and what it said.
ALTER TABLE legal_acceptances
  ADD COLUMN IF NOT EXISTS policy_slug     TEXT,
  ADD COLUMN IF NOT EXISTS policy_checksum TEXT;

-- Exactly one anchor. Both, or neither, is a bug.
ALTER TABLE legal_acceptances
  DROP CONSTRAINT IF EXISTS legal_acceptances_anchor_check;
ALTER TABLE legal_acceptances
  ADD CONSTRAINT legal_acceptances_anchor_check CHECK (
    (document_id IS NOT NULL AND policy_slug IS NULL)
    OR
    (document_id IS NULL AND policy_slug IS NOT NULL AND store_id IS NOT NULL)
  );

-- The old uniqueness rule was (user_id, document_id) — it silently stopped
-- working for store policies, where document_id is NULL (NULL is never equal
-- to NULL, so every re-accept would insert a duplicate). Store consent needs
-- its own key: one row per person, per store, per policy. Re-accepting after
-- the merchant reworded is an UPDATE of the checksum, not a second row —
-- what matters is what they agreed to NOW.
CREATE UNIQUE INDEX IF NOT EXISTS legal_acceptances_store_policy_key
  ON legal_acceptances (user_id, store_id, policy_slug)
  WHERE policy_slug IS NOT NULL;

CREATE INDEX IF NOT EXISTS legal_acceptances_policy_idx
  ON legal_acceptances (store_id, policy_slug, accepted_at DESC)
  WHERE policy_slug IS NOT NULL;

-- ---- The append-only trigger needs an exception --------------------------
-- legal_acceptances is append-only by design: a platform acceptance is a
-- historical fact and must never be edited. But a shopper re-accepting a
-- REWORDED store policy is not rewriting history — it's the same person
-- agreeing again to a new text, and the row's whole job is to answer "what do
-- they currently stand agreed to?". Allow exactly that one update: bumping the
-- checksum/timestamp of a store-policy row. Everything else still throws.
CREATE OR REPLACE FUNCTION public.legal_acceptances_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'legal_acceptances is append-only';
  END IF;

  -- Platform-document acceptances are immutable, full stop.
  IF OLD.document_id IS NOT NULL THEN
    RAISE EXCEPTION 'legal_acceptances is append-only';
  END IF;

  -- Store-policy rows may only have their evidence refreshed — never be
  -- re-pointed at a different person, store or policy.
  IF NEW.user_id     IS DISTINCT FROM OLD.user_id
  OR NEW.store_id    IS DISTINCT FROM OLD.store_id
  OR NEW.policy_slug IS DISTINCT FROM OLD.policy_slug
  OR NEW.actor_type  IS DISTINCT FROM OLD.actor_type THEN
    RAISE EXCEPTION 'legal_acceptances: identity of an acceptance cannot change';
  END IF;

  RETURN NEW;
END;
$$;

-- =============================================================
-- Rollback:
--   DROP INDEX IF EXISTS legal_acceptances_store_policy_key;
--   DROP INDEX IF EXISTS legal_acceptances_policy_idx;
--   ALTER TABLE legal_acceptances DROP CONSTRAINT IF EXISTS legal_acceptances_anchor_check;
--   ALTER TABLE legal_acceptances DROP COLUMN IF EXISTS policy_slug;
--   ALTER TABLE legal_acceptances DROP COLUMN IF EXISTS policy_checksum;
--   -- (restore the original trigger body from legal_01_schema.sql, then)
--   ALTER TABLE legal_acceptances ALTER COLUMN document_id SET NOT NULL;
-- =============================================================
