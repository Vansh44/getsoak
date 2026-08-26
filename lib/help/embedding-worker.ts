import "server-only";

import { asc, eq, sql } from "drizzle-orm";
import {
  helpArticleChunks,
  helpArticles,
  helpCategories,
} from "@/drizzle/schema";
import { type Db, withService } from "@/lib/db/client";
import {
  buildHelpArticleChunks,
  HELP_CHUNK_INDEX_VERSION,
} from "@/lib/help/chunks";
import {
  configuredHelpEmbeddingModel,
  embedHelpDocuments,
  HELP_EMBEDDING_MAX_DOCUMENTS,
  HELP_EMBEDDING_MAX_TITLE_CHARS,
  type HelpEmbeddingBackend,
  type HelpEmbeddingError,
  type HelpEmbeddingErrorCode,
} from "@/lib/help/embeddings";
import { logInfo, logWarn } from "@/lib/observability/logger";

const MAX_ARTICLES_PER_RUN = 20;

interface ArticleSnapshot {
  id: string;
  title: string;
  excerpt: string | null;
  body: string | null;
  status: string;
  categoryTitle: string | null;
  updatedAt: string;
}

export type HelpEmbeddingRefreshResult =
  | { status: "indexed"; articleId: string; chunks: number }
  | { status: "removed"; articleId: string; chunks: 0 }
  | { status: "stale"; articleId: string; chunks: 0 }
  | {
      status: "failed";
      articleId: string;
      chunks: 0;
      code: HelpEmbeddingErrorCode;
      retryable: boolean;
      error: string;
    };

function embeddingDocumentTitle(articleTitle: string, heading: string | null) {
  const title = (heading ? `${articleTitle} — ${heading}` : articleTitle)
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, HELP_EMBEDDING_MAX_TITLE_CHARS)
    .trim();
  return title || "StoreMink Help Centre";
}

function sameArticleSnapshot(
  current: ArticleSnapshot | undefined,
  embedded: ArticleSnapshot,
): boolean {
  return Boolean(
    current &&
    current.id === embedded.id &&
    current.title === embedded.title &&
    current.excerpt === embedded.excerpt &&
    current.body === embedded.body &&
    current.status === "published" &&
    current.categoryTitle === embedded.categoryTitle &&
    current.updatedAt === embedded.updatedAt,
  );
}

function isArticleLocalFailure(
  result: Extract<HelpEmbeddingRefreshResult, { status: "failed" }>,
): boolean {
  // Invalid input is tied to one source document. Auth, configuration, provider
  // rejection, malformed responses, throttling, and transport errors can affect
  // every candidate, so a burst must stop and let the heartbeat retry them.
  return !result.retryable && result.code === "invalid-input";
}

async function acquireArticleRefreshLock(db: Db, articleId: string) {
  await db.execute(sql`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`help-article:${articleId}`}::text, 0)
    )
  `);
}

function failedRefresh(
  articleId: string,
  error: HelpEmbeddingError,
  startedAt: number,
): Extract<HelpEmbeddingRefreshResult, { status: "failed" }> {
  logWarn("help.embedding article failed", {
    articleId,
    code: error.code,
    retryable: error.retryable,
    ms: Date.now() - startedAt,
  });
  return {
    status: "failed",
    articleId,
    chunks: 0,
    code: error.code,
    retryable: error.retryable,
    error: error.message,
  };
}

function safeEmbeddedAt(sourceUpdatedAt: string): string {
  const sourceMillis = Date.parse(sourceUpdatedAt);
  // Postgres timestamps can carry more precision than JavaScript milliseconds,
  // and an application clock can trail the database slightly. One extra second
  // keeps the durable freshness invariant true in both cases.
  const sourceFloor = Number.isFinite(sourceMillis)
    ? sourceMillis + 1_000
    : Date.now();
  return new Date(Math.max(Date.now(), sourceFloor)).toISOString();
}

async function loadArticle(articleId: string): Promise<ArticleSnapshot | null> {
  const rows = await withService((db) =>
    db
      .select({
        id: helpArticles.id,
        title: helpArticles.title,
        excerpt: helpArticles.excerpt,
        body: helpArticles.body,
        status: helpArticles.status,
        categoryTitle: helpCategories.title,
        updatedAt: helpArticles.updatedAt,
      })
      .from(helpArticles)
      .leftJoin(helpCategories, eq(helpArticles.categoryId, helpCategories.id))
      .where(eq(helpArticles.id, articleId))
      .limit(1),
  );
  return rows[0] ?? null;
}

async function removeArticleChunksIfUnavailable(
  articleId: string,
): Promise<boolean> {
  return withService(async (db) => {
    await acquireArticleRefreshLock(db, articleId);
    const current = await db
      .select({ status: helpArticles.status })
      .from(helpArticles)
      .where(eq(helpArticles.id, articleId))
      .limit(1);
    if (current[0]?.status === "published") return false;
    await db
      .delete(helpArticleChunks)
      .where(eq(helpArticleChunks.articleId, articleId));
    return true;
  });
}

/** Build and atomically replace one article's semantic index. */
export async function refreshHelpArticleEmbeddings(
  articleId: string,
): Promise<HelpEmbeddingRefreshResult> {
  const startedAt = Date.now();
  const article = await loadArticle(articleId);
  if (!article || article.status !== "published") {
    const removed = await removeArticleChunksIfUnavailable(articleId);
    return {
      status: removed ? "removed" : "stale",
      articleId,
      chunks: 0,
    };
  }

  const chunks = buildHelpArticleChunks({
    title: article.title,
    excerpt: article.excerpt,
    categoryTitle: article.categoryTitle ?? "",
    body: article.body,
  });

  const documents = chunks.map((chunk) => ({
    title: embeddingDocumentTitle(article.title, chunk.heading),
    text: chunk.embeddingText,
  }));
  const embeddingValues: number[][] = [];
  let embeddingBackend: HelpEmbeddingBackend | null = null;
  let embeddingModel: string | null = null;
  for (
    let offset = 0;
    offset < documents.length;
    offset += HELP_EMBEDDING_MAX_DOCUMENTS
  ) {
    const embedded = await embedHelpDocuments(
      documents.slice(offset, offset + HELP_EMBEDDING_MAX_DOCUMENTS),
    );
    if (!embedded.ok) {
      return failedRefresh(articleId, embedded.error, startedAt);
    }
    if (
      (embeddingBackend && embeddingBackend !== embedded.backend) ||
      (embeddingModel && embeddingModel !== embedded.model)
    ) {
      return failedRefresh(
        articleId,
        {
          code: "invalid-response",
          message: "The embedding provider changed during article indexing.",
          retryable: true,
        },
        startedAt,
      );
    }
    embeddingBackend = embedded.backend;
    embeddingModel = embedded.model;
    embeddingValues.push(...embedded.value);
  }
  if (
    !embeddingBackend ||
    !embeddingModel ||
    embeddingValues.length !== chunks.length
  ) {
    return failedRefresh(
      articleId,
      {
        code: "invalid-response",
        message: "The embedding provider returned an incomplete article.",
        retryable: true,
      },
      startedAt,
    );
  }

  const embeddedAt = safeEmbeddedAt(article.updatedAt);
  const replaced = await withService(async (db) => {
    // Embedding happens outside the transaction, then replacement is serialized
    // per article. This avoids holding a database lock across a provider call
    // while preventing save/cron races from inserting the same unique ordinals.
    await acquireArticleRefreshLock(db, articleId);
    // Never let a slow provider response overwrite a newer article revision.
    // This read deliberately happens after acquiring the article lock. Compare
    // the complete embedding source too: two saves can share one timestamp at
    // the database's effective precision.
    const current = await db
      .select({
        id: helpArticles.id,
        title: helpArticles.title,
        excerpt: helpArticles.excerpt,
        body: helpArticles.body,
        status: helpArticles.status,
        categoryTitle: helpCategories.title,
        updatedAt: helpArticles.updatedAt,
      })
      .from(helpArticles)
      .leftJoin(helpCategories, eq(helpArticles.categoryId, helpCategories.id))
      .where(eq(helpArticles.id, articleId))
      .limit(1);
    if (!sameArticleSnapshot(current[0], article)) {
      return false;
    }

    await db
      .delete(helpArticleChunks)
      .where(eq(helpArticleChunks.articleId, articleId));
    await db.insert(helpArticleChunks).values(
      chunks.map((chunk, index) => ({
        articleId,
        chunkIndex: chunk.chunkIndex,
        chunkCount: chunks.length,
        heading: chunk.heading,
        headingAnchor: chunk.headingAnchor,
        headingLevel: chunk.headingLevel,
        content: chunk.content,
        tokenCount: chunk.tokenCount,
        contentHash: chunk.contentHash,
        sourceUpdatedAt: article.updatedAt,
        indexVersion: HELP_CHUNK_INDEX_VERSION,
        embedding: embeddingValues[index],
        embeddingModel,
        embeddedAt,
        createdAt: embeddedAt,
        updatedAt: embeddedAt,
      })),
    );
    return true;
  });
  if (!replaced) return { status: "stale", articleId, chunks: 0 };

  logInfo("help.embedding article indexed", {
    articleId,
    backend: embeddingBackend,
    model: embeddingModel,
    chunks: chunks.length,
    ms: Date.now() - startedAt,
  });
  return { status: "indexed", articleId, chunks: chunks.length };
}

export interface HelpEmbeddingWorkerResult {
  selected: number;
  indexed: number;
  removed: number;
  stale: number;
  skipped: number;
  failed: number;
  chunks: number;
  remaining: boolean;
}

/**
 * Reconcile a bounded batch. Missing, stale, or old-model indexes are selected
 * directly from source state, making retries durable without a second queue.
 */
export async function runHelpEmbeddingWorker(
  requestedLimit = 8,
): Promise<HelpEmbeddingWorkerResult> {
  const model = configuredHelpEmbeddingModel();
  if (!model) {
    throw new Error("The Help embedding model is not configured correctly.");
  }
  const limit = Math.min(
    MAX_ARTICLES_PER_RUN,
    Math.max(
      1,
      Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : 8,
    ),
  );

  // Remove derived rows that can no longer be publicly used. The vector query
  // also joins published parents, so this is storage hygiene, not a security
  // dependency.
  await withService((db) =>
    db.execute(sql`
      DELETE FROM public.help_article_chunks AS chunk
      WHERE NOT EXISTS (
        SELECT 1 FROM public.help_articles AS article
        WHERE article.id = chunk.article_id
          AND article.status = 'published'
      )
    `),
  );

  const candidatePage = await withService((db) =>
    db
      .select({ id: helpArticles.id })
      .from(helpArticles)
      .innerJoin(helpCategories, eq(helpArticles.categoryId, helpCategories.id))
      .where(
        sql`
        ${helpArticles.status} = 'published'
        AND NOT EXISTS (
          SELECT 1
          FROM public.help_article_chunks AS chunk
          WHERE chunk.article_id = ${helpArticles.id}
            AND chunk.source_updated_at = ${helpArticles.updatedAt}
            AND chunk.embedding_model = ${model}
            AND chunk.index_version = ${HELP_CHUNK_INDEX_VERSION}
          HAVING COUNT(*)::integer = MIN(chunk.chunk_count)
            AND MIN(chunk.chunk_count) = MAX(chunk.chunk_count)
            AND MIN(chunk.chunk_index) = 0
            AND MAX(chunk.chunk_index) = MIN(chunk.chunk_count) - 1
        )
      `,
      )
      .orderBy(asc(helpArticles.updatedAt), asc(helpArticles.id))
      .limit(limit + 1),
  );
  const hasMore = candidatePage.length > limit;
  const candidates = candidatePage.slice(0, limit);

  const summary: HelpEmbeddingWorkerResult = {
    selected: candidates.length,
    indexed: 0,
    removed: 0,
    stale: 0,
    skipped: 0,
    failed: 0,
    chunks: 0,
    remaining: false,
  };
  let madeProgress = false;
  let halted = false;
  for (const candidate of candidates) {
    const result = await refreshHelpArticleEmbeddings(candidate.id);
    if (result.status === "failed") {
      if (isArticleLocalFailure(result)) {
        summary.skipped += 1;
        continue;
      }
      summary.failed += 1;
      halted = true;
      break;
    }
    summary[result.status] += 1;
    summary.chunks += result.chunks;
    madeProgress = true;
  }
  // Do not spin a self-chain when a full page contained only deterministic,
  // article-local failures. A later source edit or hourly heartbeat may retry
  // them, while successful pages continue draining immediately.
  summary.remaining = !halted && hasMore && madeProgress;
  logInfo("help.embedding worker complete", { ...summary });
  return summary;
}
