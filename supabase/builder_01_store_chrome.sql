-- ---------------------------------------------------------------------------
-- store_chrome — the site-wide header and footer, as builder-editable content
--
-- RUN AS: postgres. Idempotent. Migrates store_menus into it (see step 4).
--
-- WHY THIS TABLE EXISTS
--
-- The header and footer were spread across three admin areas and a hardcoded
-- component: link columns in `store_menus` (/dashboard/navigation), logo +
-- social + legal name in `stores.settings.brand` (/dashboard/branding), and the
-- newsletter/contact blocks in Footer.jsx. A merchant thinks "my website"; the
-- product made them visit three screens, none of which showed a preview.
--
-- It also had two different safety models on one website: a page edit sat in
-- draft until you pressed Publish, while `saveStoreMenus` wrote straight to
-- live. The riskier one applied to the chrome that appears on EVERY page.
--
-- So chrome gets the exact contract `store_pages` has — a `draft` you edit
-- freely and a `published` snapshot the storefront reads — and Publish now
-- means one thing across the whole site.
--
-- ONE ROW PER STORE. Unlike store_pages there is no slug: a store has exactly
-- one header and one footer, so store_id is the primary key and every write is
-- an upsert. That also makes "does this store have chrome yet?" unambiguous.
-- ---------------------------------------------------------------------------

BEGIN;

CREATE TABLE IF NOT EXISTS store_chrome (
  store_id     UUID PRIMARY KEY REFERENCES stores(id) ON DELETE CASCADE,
  -- What the builder edits. Shape validated in lib/chrome/types.ts, not here:
  -- jsonb keeps adding a footer toggle a code change rather than a migration,
  -- the same trade store_pages.sections and stores.settings.features make.
  draft        JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- What the storefront renders. NULL until the merchant publishes once, which
  -- the reader treats as "fall back to defaults" rather than "empty header".
  published    JSONB,
  published_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.touch_store_chrome_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS store_chrome_touch_updated_at ON store_chrome;
CREATE TRIGGER store_chrome_touch_updated_at
  BEFORE UPDATE ON store_chrome
  FOR EACH ROW EXECUTE FUNCTION public.touch_store_chrome_updated_at();

-- =============================================================
-- RLS
-- =============================================================
ALTER TABLE store_chrome ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public read store_chrome" ON store_chrome;
CREATE POLICY "Public read store_chrome"
  ON store_chrome FOR SELECT
  USING (true);

DROP POLICY IF EXISTS "Admins insert store_chrome" ON store_chrome;
CREATE POLICY "Admins insert store_chrome"
  ON store_chrome FOR INSERT
  WITH CHECK ((SELECT is_store_admin(store_id)));

DROP POLICY IF EXISTS "Admins update store_chrome" ON store_chrome;
CREATE POLICY "Admins update store_chrome"
  ON store_chrome FOR UPDATE
  USING ((SELECT is_store_admin(store_id)))
  WITH CHECK ((SELECT is_store_admin(store_id)));

DROP POLICY IF EXISTS "Admins delete store_chrome" ON store_chrome;
CREATE POLICY "Admins delete store_chrome"
  ON store_chrome FOR DELETE
  USING ((SELECT is_store_admin(store_id)));

-- =============================================================
-- Column-level hardening — the store_pages draft-sealing pattern.
--
-- RLS is ROW-level, so the public-read policy above would otherwise hand the
-- unpublished `draft` to anyone via PostgREST. Revoke blanket SELECT and grant
-- back only what the storefront renders. The builder and its preview loader
-- read `draft` with the SERVICE scope after an app-layer permission check
-- (app/actions/chrome-actions.ts, lib/chrome/preview.ts).
--
-- Storefront reads MUST therefore select named columns, never `*`.
-- =============================================================
REVOKE SELECT ON store_chrome FROM anon, authenticated;
GRANT SELECT (
  store_id, published, published_at, created_at, updated_at
) ON store_chrome TO anon, authenticated;

-- =============================================================
-- Migrate existing store_menus rows.
--
-- Seeded into BOTH draft and published: these menus are already live, so
-- publishing them is the only value that doesn't change what visitors see.
-- Leaving `published` NULL would blank every existing store's nav until its
-- owner happened to open the builder and press Publish.
--
-- Only the link fields move. The newsletter/contact/social toggles are new and
-- default ON in lib/chrome/types.ts, which matches what Footer.jsx renders
-- today — a migration must not change how a live store looks.
-- =============================================================
INSERT INTO store_chrome (store_id, draft, published, published_at)
SELECT
  m.store_id,
  jsonb_build_object(
    'header', jsonb_build_object('links', COALESCE(m.header, '[]'::jsonb)),
    'footer', jsonb_build_object(
      'groups', COALESCE(m.footer_groups, '[]'::jsonb),
      'legal',  COALESCE(m.footer_legal, '[]'::jsonb)
    )
  ),
  jsonb_build_object(
    'header', jsonb_build_object('links', COALESCE(m.header, '[]'::jsonb)),
    'footer', jsonb_build_object(
      'groups', COALESCE(m.footer_groups, '[]'::jsonb),
      'legal',  COALESCE(m.footer_legal, '[]'::jsonb)
    )
  ),
  now()
FROM store_menus m
ON CONFLICT (store_id) DO NOTHING;

COMMIT;

-- =============================================================
-- Guard: every store that had menus must now have chrome. Run after applying.
-- Expects 0.
-- =============================================================
-- SELECT count(*) AS stores_missing_chrome
--   FROM store_menus m
--   LEFT JOIN store_chrome c ON c.store_id = m.store_id
--  WHERE c.store_id IS NULL;

-- =============================================================
-- NOTE: store_menus is deliberately LEFT IN PLACE by this migration, unread.
-- Dropping a table in the same change that starts reading its replacement
-- leaves no way back if the new path misbehaves. Drop it in a follow-up once
-- the builder has been live for a release:
--   DROP TABLE IF EXISTS store_menus CASCADE;
-- =============================================================

-- =============================================================
-- ROLLBACK (uncomment to fully undo):
-- BEGIN;
-- DROP TRIGGER IF EXISTS store_chrome_touch_updated_at ON store_chrome;
-- DROP FUNCTION IF EXISTS public.touch_store_chrome_updated_at();
-- DROP TABLE IF EXISTS store_chrome CASCADE;
-- COMMIT;
-- =============================================================
