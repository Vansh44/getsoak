-- Harden the first Help embedding schema after its manual staging rollout.
--
-- `chunk_count` makes partial article indexes detectable. `index_version`
-- forces deterministic rebuilds when the parser changes without an article
-- edit. The rate-slot ACL repair removes an inherited default EXECUTE grant
-- from app_user on a SECURITY DEFINER function; only app_service may call it.
-- Restore the singleton Analytics control row with fail-safe defaults if an
-- earlier manual rollout lost it, without re-enabling operator-disabled modules.

INSERT INTO public.platform_analytics_settings (id)
VALUES (true)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.help_article_chunks
  ADD COLUMN chunk_count INTEGER,
  ADD COLUMN index_version INTEGER;

WITH article_counts AS (
  SELECT article_id, max(chunk_index) + 1 AS chunk_count
  FROM public.help_article_chunks
  GROUP BY article_id
)
UPDATE public.help_article_chunks chunk
SET chunk_count = article_counts.chunk_count,
    index_version = 1
FROM article_counts
WHERE article_counts.article_id = chunk.article_id;

ALTER TABLE public.help_article_chunks
  ALTER COLUMN chunk_count SET NOT NULL,
  ALTER COLUMN index_version SET NOT NULL,
  DROP CONSTRAINT help_article_chunks_chunk_index_check,
  ADD CONSTRAINT help_article_chunks_chunk_index_check
    CHECK (chunk_index >= 0 AND chunk_index < chunk_count),
  ADD CONSTRAINT help_article_chunks_chunk_count_check
    CHECK (chunk_count > 0),
  ADD CONSTRAINT help_article_chunks_index_version_check
    CHECK (index_version > 0);

REVOKE ALL ON FUNCTION public.claim_store_search_rate_slot(text, integer)
  FROM app_user;
REVOKE ALL ON FUNCTION public.claim_store_search_rate_slot(text, integer)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_store_search_rate_slot(text, integer)
  TO app_service;

-- The application never reads or writes migration history. Default table
-- grants made the ledger reachable through app_user/app_service; remove them.
REVOKE ALL ON TABLE public.schema_migrations FROM app_user, app_service;
