-- Add the durable vector-storage layer for semantic Help Centre retrieval.
--
-- Help content is platform-global (there is deliberately no store_id). Each
-- row represents one heading-aware slice of an article. Embeddings are written
-- only after they have been generated successfully, so readers never have to
-- handle half-populated vector metadata. Article publication remains the
-- visibility boundary: anonymous readers may see chunks only while the parent
-- article is published; platform operators retain maintenance access.

-- Cloud SQL for PostgreSQL exposes pgvector as the `vector` extension. The
-- checksummed migration runner applies this file as the postgres administrator,
-- which has the cloudsqlsuperuser membership required to install extensions.
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;

CREATE TABLE public.help_article_chunks (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id        UUID NOT NULL,
  chunk_index       INTEGER NOT NULL,
  heading           TEXT,
  heading_anchor    TEXT,
  heading_level     INTEGER,
  content           TEXT NOT NULL,
  token_count       INTEGER NOT NULL,
  content_hash      TEXT NOT NULL,
  source_updated_at TIMESTAMPTZ NOT NULL,
  embedding         public.vector(768) NOT NULL,
  embedding_model   TEXT NOT NULL,
  embedded_at       TIMESTAMPTZ NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT help_article_chunks_article_id_fkey
    FOREIGN KEY (article_id) REFERENCES public.help_articles(id)
    ON DELETE CASCADE,
  CONSTRAINT help_article_chunks_chunk_index_check
    CHECK (chunk_index >= 0),
  CONSTRAINT help_article_chunks_heading_check
    CHECK (
      (
        heading IS NULL
        AND heading_anchor IS NULL
        AND heading_level IS NULL
      )
      OR
      (
        heading IS NOT NULL
        AND btrim(heading) <> ''
        AND heading_level IS NOT NULL
        AND heading_level BETWEEN 1 AND 6
        AND (
          heading_anchor IS NULL
          OR heading_anchor ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
        )
      )
    ),
  CONSTRAINT help_article_chunks_content_check
    CHECK (btrim(content) <> ''),
  CONSTRAINT help_article_chunks_token_count_check
    CHECK (token_count > 0),
  CONSTRAINT help_article_chunks_content_hash_check
    CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT help_article_chunks_embedding_model_check
    CHECK (btrim(embedding_model) <> ''),
  CONSTRAINT help_article_chunks_embedding_freshness_check
    CHECK (embedded_at >= source_updated_at)
);

-- One stable ordinal per article lets an embedding worker replace a complete
-- article atomically. The hash index supports diagnostics and deduplication;
-- model + timestamp force targeted re-embedding when provider semantics or the
-- source article changes. Exact cosine search intentionally has no ANN index
-- yet: this Help corpus is small, and an exact scan preserves perfect recall.
CREATE UNIQUE INDEX help_article_chunks_article_chunk_key
  ON public.help_article_chunks (article_id, chunk_index);
CREATE INDEX help_article_chunks_content_hash_idx
  ON public.help_article_chunks (content_hash);
CREATE INDEX help_article_chunks_model_embedded_idx
  ON public.help_article_chunks (embedding_model, embedded_at);

ALTER TABLE public.help_article_chunks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Read help_article_chunks"
  ON public.help_article_chunks
  FOR SELECT
  TO public
  USING (
    EXISTS (
      SELECT 1
      FROM public.help_articles article
      WHERE article.id = help_article_chunks.article_id
        AND (
          (SELECT public.is_platform_admin())
          OR (
            article.status = 'published'
            AND article.updated_at = help_article_chunks.source_updated_at
          )
        )
    )
  );

CREATE POLICY "Write help_article_chunks"
  ON public.help_article_chunks
  FOR ALL
  TO public
  USING ((SELECT public.is_platform_admin()))
  WITH CHECK ((SELECT public.is_platform_admin()));

-- Keep the public guide current with the retrieval change. This describes the
-- user-visible guarantee in plain language without exposing provider secrets or
-- implementation-only tuning values.
UPDATE public.help_articles
SET body = replace(
      body,
      '<h2>Follow the answer</h2>',
      '<h2>How Mink AI finds the right guide</h2><p>Mink AI checks exact StoreMink words, article titles, and categories, then also compares the meaning of your question with small sections of published guides. It combines both result lists so an exact button name stays important while everyday wording can still find the correct instructions.</p><p>Only current, published Help Centre content is used. If meaning-based search is temporarily unavailable, normal Help Centre search continues to work and Mink AI does not guess from an unverified source.</p><h2>Follow the answer</h2>'
    ),
    updated_at = now()
WHERE slug = 'use-storemink-help-assistant'
  AND status = 'published'
  AND body NOT LIKE '%<h2>How Mink AI finds the right guide</h2>%';
