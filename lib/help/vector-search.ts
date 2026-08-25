import "server-only";

import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { withAnon } from "@/lib/db/client";
import { HELP_CHUNK_INDEX_VERSION } from "@/lib/help/chunks";
import { embedHelpQuery } from "@/lib/help/embeddings";
import { logInfo, logWarn } from "@/lib/observability/logger";

const DEFAULT_MIN_SIMILARITY = 0.55;
const MAX_CHUNKS_PER_ARTICLE = 3;
const MAX_VECTOR_MATCHES = 40;

export interface HelpVectorChunkMatch {
  articleId: string;
  articleSlug: string;
  chunkId: string;
  categorySlug: string;
  categoryTitle: string;
  title: string;
  excerpt: string | null;
  heading: string | null;
  headingAnchor: string | null;
  content: string;
  sourceUpdatedAt: string;
  similarity: number;
}

export interface HelpVectorSearchResult {
  status: "ok" | "no-match" | "unavailable";
  matches: HelpVectorChunkMatch[];
}

interface VectorRow {
  article_id?: unknown;
  article_slug?: unknown;
  chunk_id?: unknown;
  category_slug?: unknown;
  category_title?: unknown;
  title?: unknown;
  excerpt?: unknown;
  heading?: unknown;
  heading_anchor?: unknown;
  content?: unknown;
  source_updated_at?: unknown;
  similarity?: unknown;
}

function queryHash(query: string): string {
  return createHash("sha256").update(query, "utf8").digest("hex").slice(0, 12);
}

function minSimilarity(): number {
  const raw = process.env.HELP_VECTOR_MIN_SIMILARITY?.trim();
  if (!raw) return DEFAULT_MIN_SIMILARITY;
  const configured = Number(raw);
  return Number.isFinite(configured) && configured >= 0 && configured <= 1
    ? configured
    : DEFAULT_MIN_SIMILARITY;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function mapRow(row: VectorRow): HelpVectorChunkMatch | null {
  const articleId = text(row.article_id);
  const articleSlug = text(row.article_slug);
  const chunkId = text(row.chunk_id);
  const categorySlug = text(row.category_slug);
  const categoryTitle = text(row.category_title);
  const title = text(row.title);
  const content = text(row.content);
  const sourceUpdatedAt = text(row.source_updated_at);
  const similarity = Number(row.similarity);
  if (
    !articleId ||
    !articleSlug ||
    !chunkId ||
    !categorySlug ||
    !categoryTitle ||
    !title ||
    !content ||
    !sourceUpdatedAt ||
    !Number.isFinite(similarity)
  ) {
    return null;
  }
  return {
    articleId,
    articleSlug,
    chunkId,
    categorySlug,
    categoryTitle,
    title,
    excerpt: text(row.excerpt),
    heading: text(row.heading),
    headingAnchor: text(row.heading_anchor),
    content,
    sourceUpdatedAt,
    similarity,
  };
}

/**
 * Exact cosine search over current, published Help chunks. Every failure is a
 * typed empty result so the lexical/category retriever remains available.
 * Query text is never logged; only a short one-way hash is emitted for tracing.
 */
export async function searchHelpArticleChunksByMeaning(
  rawQuery: string,
  limit = 24,
): Promise<HelpVectorSearchResult> {
  const startedAt = Date.now();
  const query = rawQuery.normalize("NFKC").trim().slice(0, 1_200);
  const hash = queryHash(query);
  const boundedLimit = Math.min(
    MAX_VECTOR_MATCHES,
    Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 24),
  );
  const embedded = await embedHelpQuery(query);
  if (!embedded.ok) {
    logWarn("help.semantic_retrieval unavailable", {
      queryHash: hash,
      stage: "embedding",
      code: embedded.error.code,
      retryable: embedded.error.retryable,
      ms: Date.now() - startedAt,
    });
    return { status: "unavailable", matches: [] };
  }

  const threshold = minSimilarity();
  const vector = JSON.stringify(embedded.value);
  try {
    const result = await withAnon((db) =>
      db.execute(sql`
        WITH scored_chunks AS (
          SELECT
            article.id::text AS article_id,
            article.slug AS article_slug,
            chunk.id::text AS chunk_id,
            category.slug AS category_slug,
            category.title AS category_title,
            article.title,
            article.excerpt,
            chunk.heading,
            chunk.heading_anchor,
            chunk.content,
            chunk.source_updated_at::text AS source_updated_at,
            (1 - (chunk.embedding <=> ${vector}::public.vector))::double precision AS similarity
          FROM public.help_article_chunks AS chunk
          INNER JOIN public.help_articles AS article ON article.id = chunk.article_id
          INNER JOIN public.help_categories AS category ON category.id = article.category_id
          WHERE article.status = 'published'
            AND article.updated_at = chunk.source_updated_at
            AND chunk.embedding_model = ${embedded.model}
            AND chunk.index_version = ${HELP_CHUNK_INDEX_VERSION}
            AND (1 - (chunk.embedding <=> ${vector}::public.vector)) >= ${threshold}
        ), ranked_chunks AS (
          SELECT
            scored_chunks.*,
            ROW_NUMBER() OVER (
              PARTITION BY article_id
              ORDER BY similarity DESC, chunk_id
            ) AS article_chunk_rank
          FROM scored_chunks
        )
        SELECT
          article_id,
          article_slug,
          chunk_id,
          category_slug,
          category_title,
          title,
          excerpt,
          heading,
          heading_anchor,
          content,
          source_updated_at,
          similarity
        FROM ranked_chunks
        WHERE article_chunk_rank <= ${MAX_CHUNKS_PER_ARTICLE}
        ORDER BY similarity DESC, chunk_id
        LIMIT ${boundedLimit}
      `),
    );
    const matches = (result.rows as VectorRow[])
      .map(mapRow)
      .filter((row): row is HelpVectorChunkMatch => row !== null);
    logInfo("help.semantic_retrieval complete", {
      queryHash: hash,
      backend: embedded.backend,
      model: embedded.model,
      candidates: matches.length,
      minSimilarity: threshold,
      ms: Date.now() - startedAt,
    });
    return {
      status: matches.length > 0 ? "ok" : "no-match",
      matches,
    };
  } catch (error) {
    logWarn("help.semantic_retrieval unavailable", {
      queryHash: hash,
      stage: "database",
      error: error instanceof Error ? error.message : String(error),
      ms: Date.now() - startedAt,
    });
    return { status: "unavailable", matches: [] };
  }
}
