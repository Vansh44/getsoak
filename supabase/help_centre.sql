-- =============================================================
-- Help Centre — platform-global docs served at help.storemink.com.
--
-- These are StoreMink's OWN product docs (not per-store data), authored by
-- platform operators in the platform admin console and read publicly/anon on
-- the help subdomain. So — unlike blogs — there is NO store_id: the model
-- mirrors `platform_admins` (a global, operator-managed table).
--
--   help_categories : top-level groupings (Getting started, Payments, …)
--   help_articles   : the docs themselves (sanitized HTML body + FTS vector)
--
-- ⚠ Run as `postgres` against the target Cloud SQL database (through the Cloud
-- SQL Auth Proxy), exactly like the other migrations. New public-schema tables
-- created by postgres inherit app_user/app_service grants from the
-- ALTER DEFAULT PRIVILEGES in drizzle/manual/0000_compat_setup.sql, so no
-- explicit GRANTs are needed here. Idempotent — safe to re-run.
-- =============================================================

-- ---- Categories --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS help_categories (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        TEXT NOT NULL,
  title       TEXT NOT NULL,
  description TEXT,
  icon        TEXT,                          -- lucide icon name (display only)
  position    INTEGER NOT NULL DEFAULT 0,    -- manual ordering
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS help_categories_slug_key ON help_categories (slug);
CREATE INDEX IF NOT EXISTS help_categories_position_idx ON help_categories (position, title);

-- ---- Articles ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS help_articles (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id     UUID REFERENCES help_categories(id) ON DELETE SET NULL,
  slug            TEXT NOT NULL,             -- globally unique (see index below)
  title           TEXT NOT NULL,
  excerpt         TEXT,                      -- one-line summary (cards + meta desc)
  body            TEXT,                      -- sanitized HTML
  status          TEXT NOT NULL DEFAULT 'draft',
  seo_title       TEXT,
  seo_description TEXT,
  position        INTEGER NOT NULL DEFAULT 0,
  view_count      INTEGER NOT NULL DEFAULT 0,
  helpful_yes     INTEGER NOT NULL DEFAULT 0,
  helpful_no      INTEGER NOT NULL DEFAULT 0,
  created_by      TEXT,                      -- operator uid (Firebase uid = text)
  updated_by      TEXT,
  published_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Weighted full-text search vector (title > excerpt > body). Every function
  -- here is IMMUTABLE, so it is a valid STORED generated column. HTML tags are
  -- stripped from the body so markup never pollutes the lexemes.
  search          TSVECTOR GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(excerpt, '')), 'B') ||
    setweight(to_tsvector('english', regexp_replace(coalesce(body, ''), '<[^>]+>', ' ', 'g')), 'C')
  ) STORED,
  CONSTRAINT help_articles_status_check CHECK (status = ANY (ARRAY['draft'::text, 'published'::text]))
);

CREATE UNIQUE INDEX IF NOT EXISTS help_articles_slug_key ON help_articles (slug);
CREATE INDEX IF NOT EXISTS help_articles_category_idx ON help_articles (category_id, position, title);
CREATE INDEX IF NOT EXISTS help_articles_published_idx
  ON help_articles (status, published_at DESC) WHERE status = 'published';
CREATE INDEX IF NOT EXISTS help_articles_search_gin ON help_articles USING GIN (search);

-- ---- RLS ---------------------------------------------------------------------
-- Public/anon may READ published articles and all categories (non-sensitive).
-- Only platform operators may write. Management actions run through the
-- service-role runner (BYPASSRLS) after a getPlatformViewer() gate, so these
-- policies are the defense-in-depth floor, and the anon SELECT filter is what
-- keeps unpublished drafts off the public site.
ALTER TABLE help_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE help_articles   ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Read help_categories" ON help_categories;
CREATE POLICY "Read help_categories" ON help_categories FOR SELECT USING (true);

DROP POLICY IF EXISTS "Write help_categories" ON help_categories;
CREATE POLICY "Write help_categories" ON help_categories FOR ALL
  USING ((SELECT is_platform_admin())) WITH CHECK ((SELECT is_platform_admin()));

DROP POLICY IF EXISTS "Read help_articles" ON help_articles;
CREATE POLICY "Read help_articles" ON help_articles FOR SELECT
  USING (status = 'published' OR (SELECT is_platform_admin()));

DROP POLICY IF EXISTS "Write help_articles" ON help_articles;
CREATE POLICY "Write help_articles" ON help_articles FOR ALL
  USING ((SELECT is_platform_admin())) WITH CHECK ((SELECT is_platform_admin()));

-- ---- Public feedback + view counters (SECURITY DEFINER) ----------------------
-- Anonymous readers vote "was this helpful?" and bump view counts. These are
-- the only writes the public path performs, so they go through narrow, atomic
-- SECURITY DEFINER functions (owned by postgres) rather than opening a write
-- policy to anon. Each is a single conditional/relative UPDATE — no way to set
-- an arbitrary value. Callers pass a published article id only.
-- SECURITY DEFINER hardening: pin search_path to '' and fully-qualify every
-- object reference, so the function can't be hijacked by a same-named object in
-- another schema earlier on the path (matches the rest of the codebase, e.g.
-- adjust_stock / the coupon RPCs).
CREATE OR REPLACE FUNCTION public.help_article_view(p_id UUID)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  UPDATE public.help_articles SET view_count = view_count + 1
  WHERE id = p_id AND status = 'published';
$$;

CREATE OR REPLACE FUNCTION public.help_article_vote(p_id UUID, p_helpful BOOLEAN)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  UPDATE public.help_articles
     SET helpful_yes = helpful_yes + (CASE WHEN p_helpful THEN 1 ELSE 0 END),
         helpful_no  = helpful_no  + (CASE WHEN p_helpful THEN 0 ELSE 1 END)
   WHERE id = p_id AND status = 'published';
$$;

GRANT EXECUTE ON FUNCTION help_article_view(UUID)          TO app_user, app_service;
GRANT EXECUTE ON FUNCTION help_article_vote(UUID, BOOLEAN) TO app_user, app_service;

-- ---- Seed categories (idempotent — keyed on slug) ----------------------------
INSERT INTO help_categories (slug, title, description, icon, position) VALUES
  ('getting-started',   'Getting started',        'Create your store, understand the dashboard, and go live.', 'Rocket',        1),
  ('storefront',        'Setting up your store',  'Branding, homepage sections, pages, and your look and feel.', 'LayoutTemplate', 2),
  ('products',          'Products & inventory',   'Add products, variants, images, pricing, and track stock.', 'Package',        3),
  ('payments',          'Payments, GST & COD',    'Connect a gateway, enable COD, and set up GST invoicing.',  'IndianRupee',    4),
  ('domains',           'Domains',                'Use your free subdomain or connect your own domain.',       'Globe',          5),
  ('orders',            'Orders & shipping',      'Manage orders, fulfilment, and logistics.',                 'Truck',          6),
  ('marketing',         'Marketing & blogs',      'Coupons, email campaigns, reviews, and your blog.',         'Megaphone',      7),
  ('account',           'Account & billing',      'Your plan, team members, and account settings.',            'CreditCard',     8)
ON CONFLICT (slug) DO NOTHING;

-- =============================================================
-- Rollback:
--   DROP FUNCTION IF EXISTS help_article_vote(UUID, BOOLEAN);
--   DROP FUNCTION IF EXISTS help_article_view(UUID);
--   DROP TABLE IF EXISTS help_articles CASCADE;
--   DROP TABLE IF EXISTS help_categories CASCADE;
-- =============================================================
