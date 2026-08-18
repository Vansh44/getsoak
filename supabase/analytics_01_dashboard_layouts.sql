-- Analytics Phase 2 — personal, server-persisted dashboard layouts.
--
-- Run as `postgres`, like every migration in this directory.
--
-- A layout belongs to ONE admin inside ONE store. It is a preference, never an
-- authorization source: every render and write intersects its widget ids with
-- the viewer's current permissions and location scope in application code.
-- No row means "follow the current product default", so changing the default
-- improves untouched dashboards without rewriting tenant data.

BEGIN;

CREATE TABLE IF NOT EXISTS public.analytics_dashboard_layouts (
  store_id       uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  admin_user_id  text NOT NULL,
  schema_version integer NOT NULL DEFAULT 1,
  layout         jsonb NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, admin_user_id),
  CONSTRAINT analytics_dashboard_layouts_schema_version_check
    CHECK (schema_version > 0),
  CONSTRAINT analytics_dashboard_layouts_layout_is_object
    CHECK (jsonb_typeof(layout) = 'object')
);

CREATE INDEX IF NOT EXISTS analytics_dashboard_layouts_admin_idx
  ON public.analytics_dashboard_layouts (admin_user_id);

-- Service-role only. App actions derive both key columns from the authenticated
-- request; exposing a generic RLS write would turn a personal preference into a
-- cross-tenant overwrite surface.
ALTER TABLE public.analytics_dashboard_layouts ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.analytics_dashboard_layouts IS
  'Per-admin Analytics layout. No row means follow the current product default.';
COMMENT ON COLUMN public.analytics_dashboard_layouts.layout IS
  'Versioned bounded JSON. Widget ids are preferences and grant no data access.';

COMMIT;

-- Rollback:
-- BEGIN;
-- DROP TABLE IF EXISTS public.analytics_dashboard_layouts;
-- COMMIT;
