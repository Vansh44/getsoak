-- Google Search Console Phase 3a — source epochs, complete metric buckets and
-- durable leased work. All three data tables are service-role only; merchants
-- read aggregates through the authenticated Analytics server path.

BEGIN;

CREATE TABLE public.store_search_sources (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id          uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  kind              text NOT NULL,
  origin            text NOT NULL,
  property          text NOT NULL,
  page_filter       text,
  active_from       timestamptz NOT NULL,
  inactive_at       timestamptz,
  first_data_date   date NOT NULL,
  final_data_date   date,
  correction_until  date,
  last_synced_at    timestamptz,
  last_data_date    date,
  last_error        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT store_search_sources_store_origin_epoch_key
    UNIQUE (store_id, origin, active_from),
  CONSTRAINT store_search_sources_id_store_key UNIQUE (id, store_id),
  CONSTRAINT store_search_sources_kind_check
    CHECK (kind IN ('platform_subdomain', 'custom_domain')),
  CONSTRAINT store_search_sources_origin_check
    CHECK (origin ~ '^https://[^/]+$'),
  CONSTRAINT store_search_sources_filter_check
    CHECK ((kind = 'platform_subdomain' AND page_filter IS NOT NULL)
        OR (kind = 'custom_domain' AND page_filter IS NULL)),
  CONSTRAINT store_search_sources_dates_check
    CHECK (final_data_date IS NULL OR final_data_date >= first_data_date),
  CONSTRAINT store_search_sources_inactive_bounds_check
    CHECK ((inactive_at IS NULL AND final_data_date IS NULL AND correction_until IS NULL)
        OR (inactive_at IS NOT NULL AND final_data_date IS NOT NULL
            AND correction_until IS NOT NULL
            AND correction_until >= final_data_date))
);

CREATE UNIQUE INDEX store_search_sources_one_active_idx
  ON public.store_search_sources (store_id)
  WHERE inactive_at IS NULL;
CREATE INDEX store_search_sources_correction_idx
  ON public.store_search_sources (correction_until)
  WHERE inactive_at IS NOT NULL;

CREATE TABLE public.store_search_metrics (
  source_id     uuid NOT NULL,
  store_id      uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  date          date NOT NULL,
  dimension     text NOT NULL,
  key           text NOT NULL DEFAULT '',
  clicks        integer NOT NULL DEFAULT 0,
  impressions   integer NOT NULL DEFAULT 0,
  position_sum  numeric(18,4) NOT NULL DEFAULT 0,
  CONSTRAINT store_search_metrics_pkey
    PRIMARY KEY (source_id, date, dimension, key),
  CONSTRAINT store_search_metrics_source_store_fkey
    FOREIGN KEY (source_id, store_id)
    REFERENCES public.store_search_sources(id, store_id) ON DELETE CASCADE,
  CONSTRAINT store_search_metrics_dimension_check
    CHECK (dimension IN ('total', 'query', 'page', 'country', 'device')),
  CONSTRAINT store_search_metrics_values_check
    CHECK (clicks >= 0 AND impressions >= 0 AND position_sum >= 0),
  CONSTRAINT store_search_metrics_total_key_check
    CHECK (dimension <> 'total' OR key = '')
);

CREATE INDEX store_search_metrics_store_date_idx
  ON public.store_search_metrics (store_id, date DESC);
CREATE INDEX store_search_metrics_retention_idx
  ON public.store_search_metrics (date);

CREATE TABLE public.store_search_sync_jobs (
  source_id     uuid NOT NULL,
  store_id      uuid NOT NULL,
  date          date NOT NULL,
  dimension     text NOT NULL,
  status        text NOT NULL DEFAULT 'queued',
  attempts      integer NOT NULL DEFAULT 0,
  lease_until   timestamptz,
  completed_at  timestamptz,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT store_search_sync_jobs_pkey
    PRIMARY KEY (source_id, date, dimension),
  CONSTRAINT store_search_sync_jobs_source_store_fkey
    FOREIGN KEY (source_id, store_id)
    REFERENCES public.store_search_sources(id, store_id) ON DELETE CASCADE,
  CONSTRAINT store_search_sync_jobs_dimension_check
    CHECK (dimension IN ('total', 'query', 'page', 'country', 'device')),
  CONSTRAINT store_search_sync_jobs_status_check
    CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  CONSTRAINT store_search_sync_jobs_attempts_check CHECK (attempts >= 0)
);

CREATE INDEX store_search_sync_jobs_claim_idx
  ON public.store_search_sync_jobs (updated_at, source_id, date)
  WHERE status IN ('queued', 'running');

-- One fleet-wide window per Search Console property. The function serializes
-- consumers with a transaction advisory lock, so separate Cloud Run instances
-- share the 1,200-QPM Domain-property ceiling rather than each enforcing it.
CREATE TABLE public.store_search_rate_limits (
  property          text PRIMARY KEY,
  window_started_at timestamptz NOT NULL,
  request_count     integer NOT NULL DEFAULT 0,
  CONSTRAINT store_search_rate_limits_count_check CHECK (request_count >= 0)
);

CREATE OR REPLACE FUNCTION public.claim_store_search_rate_slot(
  p_property text,
  p_limit integer DEFAULT 1100
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_row public.store_search_rate_limits%ROWTYPE;
BEGIN
  IF p_property IS NULL OR p_property = '' OR p_limit < 1 THEN
    RETURN false;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('store-search:' || p_property, 0)
  );
  INSERT INTO public.store_search_rate_limits(property, window_started_at, request_count)
  VALUES (p_property, v_now, 0)
  ON CONFLICT (property) DO NOTHING;

  SELECT * INTO v_row
    FROM public.store_search_rate_limits
   WHERE property = p_property
   FOR UPDATE;

  IF v_row.window_started_at <= v_now - interval '1 minute' THEN
    UPDATE public.store_search_rate_limits
       SET window_started_at = v_now, request_count = 1
     WHERE property = p_property;
    RETURN true;
  END IF;

  IF v_row.request_count >= p_limit THEN RETURN false; END IF;
  UPDATE public.store_search_rate_limits
     SET request_count = request_count + 1
   WHERE property = p_property;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_store_search_rate_slot(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_store_search_rate_slot(text, integer) TO app_service;

ALTER TABLE public.store_search_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_search_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_search_sync_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_search_rate_limits ENABLE ROW LEVEL SECURITY;

COMMENT ON COLUMN public.store_search_metrics.position_sum IS
  'Impression-weighted position numerator; divide by impressions at read time.';
COMMENT ON TABLE public.store_search_sync_jobs IS
  'Idempotent leased work keyed by Search Console source, PT bucket date and dimension.';

COMMIT;

-- Rollback:
-- BEGIN;
-- DROP FUNCTION IF EXISTS public.claim_store_search_rate_slot(text, integer);
-- DROP TABLE IF EXISTS public.store_search_rate_limits;
-- DROP TABLE IF EXISTS public.store_search_sync_jobs;
-- DROP TABLE IF EXISTS public.store_search_metrics;
-- DROP TABLE IF EXISTS public.store_search_sources;
-- COMMIT;
