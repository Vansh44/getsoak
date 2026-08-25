import { beforeEach, describe, expect, it, vi } from "vitest";

const selectRows = vi.hoisted(() => [] as unknown[][]);
const execute = vi.hoisted(() => vi.fn(async () => ({ rows: [] })));
const deleteWhere = vi.hoisted(() => vi.fn(async () => undefined));
const insertValues = vi.hoisted(() =>
  vi.fn(async (values: unknown) => {
    void values;
  }),
);
const embedHelpDocuments = vi.hoisted(() => vi.fn());

function queryBuilder(rows: unknown[]) {
  const builder = {
    from: vi.fn(() => builder),
    leftJoin: vi.fn(() => builder),
    innerJoin: vi.fn(() => builder),
    where: vi.fn(() => builder),
    orderBy: vi.fn(() => builder),
    limit: vi.fn(async () => rows),
  };
  return builder;
}

const db = vi.hoisted(() => ({
  select: vi.fn(() => queryBuilder(selectRows.shift() ?? [])),
  delete: vi.fn(() => ({ where: deleteWhere })),
  insert: vi.fn(() => ({ values: insertValues })),
  execute,
}));

vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (callback: (value: typeof db) => unknown) =>
    callback(db),
  ),
}));
vi.mock("@/lib/help/embeddings", () => ({
  HELP_EMBEDDING_MAX_DOCUMENTS: 100,
  HELP_EMBEDDING_MAX_TITLE_CHARS: 500,
  configuredHelpEmbeddingModel: vi.fn(() => "gemini-embedding-001"),
  embedHelpDocuments,
}));
vi.mock("@/lib/observability/logger", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import {
  refreshHelpArticleEmbeddings,
  runHelpEmbeddingWorker,
} from "./embedding-worker";

const ARTICLE = {
  id: "article-1",
  title: "Process an in-store sale",
  excerpt: "Complete checkout.",
  body: "<h2>Checkout</h2><p>Scan a product and take payment.</p>",
  status: "published",
  categoryTitle: "Point of Sale",
  updatedAt: "2026-08-25T12:00:00.000Z",
};

const EMBEDDING = Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0));
const EMBED_SUCCESS = {
  ok: true as const,
  value: [EMBEDDING],
  backend: "gemini-api" as const,
  model: "gemini-embedding-001",
  dimensions: 768 as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  selectRows.splice(0);
  embedHelpDocuments.mockResolvedValue(EMBED_SUCCESS);
});

describe("refreshHelpArticleEmbeddings", () => {
  it("embeds section chunks and atomically replaces the current revision", async () => {
    selectRows.push([ARTICLE], [ARTICLE]);

    const result = await refreshHelpArticleEmbeddings(ARTICLE.id);

    expect(result).toEqual({
      status: "indexed",
      articleId: ARTICLE.id,
      chunks: 1,
    });
    expect(embedHelpDocuments).toHaveBeenCalledWith([
      expect.objectContaining({
        title: "Process an in-store sale — Checkout",
        text: expect.stringContaining("Scan a product and take payment."),
      }),
    ]);
    expect(deleteWhere).toHaveBeenCalledOnce();
    expect(insertValues).toHaveBeenCalledWith([
      expect.objectContaining({
        articleId: ARTICLE.id,
        chunkIndex: 0,
        chunkCount: 1,
        sourceUpdatedAt: ARTICLE.updatedAt,
        indexVersion: 1,
        embeddingModel: "gemini-embedding-001",
      }),
    ]);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.invocationCallOrder[0]).toBeLessThan(
      deleteWhere.mock.invocationCallOrder[0],
    );
  });

  it("bounds a long article-and-heading title before embedding", async () => {
    const article = {
      ...ARTICLE,
      title: "A".repeat(300),
      body: `<h2>${"H".repeat(300)}</h2><p>Complete checkout.</p>`,
    };
    selectRows.push([article], [article]);

    await refreshHelpArticleEmbeddings(article.id);

    const documents = embedHelpDocuments.mock.calls[0][0] as {
      title: string;
    }[];
    expect(documents[0].title).toHaveLength(500);
    expect(documents[0].title).toContain(" — ");
  });

  it("indexes title/category fallback content when a published guide is empty", async () => {
    const article = { ...ARTICLE, excerpt: null, body: null };
    selectRows.push([article], [article]);

    await expect(
      refreshHelpArticleEmbeddings(article.id),
    ).resolves.toMatchObject({ status: "indexed", chunks: 1 });
    expect(embedHelpDocuments).toHaveBeenCalledWith([
      expect.objectContaining({
        text: expect.stringContaining("Category: Point of Sale"),
      }),
    ]);
  });

  it("does not replace vectors when the source changed during embedding", async () => {
    selectRows.push(
      [ARTICLE],
      [{ ...ARTICLE, updatedAt: "2026-08-25T12:01:00.000Z" }],
    );

    await expect(refreshHelpArticleEmbeddings(ARTICLE.id)).resolves.toEqual({
      status: "stale",
      articleId: ARTICLE.id,
      chunks: 0,
    });
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("does not replace vectors when source content changes within the same timestamp", async () => {
    selectRows.push([ARTICLE], [{ ...ARTICLE, body: "<p>A newer edit.</p>" }]);

    await expect(refreshHelpArticleEmbeddings(ARTICLE.id)).resolves.toEqual({
      status: "stale",
      articleId: ARTICLE.id,
      chunks: 0,
    });
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("removes derived chunks for an unpublished article", async () => {
    const draft = { ...ARTICLE, status: "draft" };
    selectRows.push([draft], [draft]);

    await expect(refreshHelpArticleEmbeddings(ARTICLE.id)).resolves.toEqual({
      status: "removed",
      articleId: ARTICLE.id,
      chunks: 0,
    });
    expect(embedHelpDocuments).not.toHaveBeenCalled();
    expect(deleteWhere).toHaveBeenCalledOnce();
  });

  it("does not delete a republished article index after an older refresh observed a draft", async () => {
    selectRows.push([{ ...ARTICLE, status: "draft" }], [ARTICLE]);

    await expect(refreshHelpArticleEmbeddings(ARTICLE.id)).resolves.toEqual({
      status: "stale",
      articleId: ARTICLE.id,
      chunks: 0,
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(deleteWhere).not.toHaveBeenCalled();
  });

  it("batches articles with more than the provider document limit and replaces atomically", async () => {
    const article = {
      ...ARTICLE,
      body: Array.from(
        { length: 101 },
        (_, index) => `<h2>Step ${index + 1}</h2><p>Complete this step.</p>`,
      ).join(""),
    };
    selectRows.push([article], [article]);
    embedHelpDocuments.mockImplementation(
      async (documents: { title: string; text: string }[]) => ({
        ...EMBED_SUCCESS,
        value: documents.map(() => EMBEDDING),
      }),
    );

    await expect(refreshHelpArticleEmbeddings(article.id)).resolves.toEqual({
      status: "indexed",
      articleId: article.id,
      chunks: 101,
    });
    expect(embedHelpDocuments).toHaveBeenCalledTimes(2);
    expect(
      embedHelpDocuments.mock.calls.map(([documents]) => documents.length),
    ).toEqual([100, 1]);
    const inserted = insertValues.mock.calls[0][0] as { chunkCount: number }[];
    expect(inserted).toHaveLength(101);
    expect(inserted.every((chunk) => chunk.chunkCount === 101)).toBe(true);
  });

  it("keeps embedded timestamps newer than a future source timestamp", async () => {
    const article = {
      ...ARTICLE,
      updatedAt: new Date(Date.now() + 60_000).toISOString(),
    };
    selectRows.push([article], [article]);

    await refreshHelpArticleEmbeddings(article.id);

    const [inserted] = insertValues.mock.calls[0][0] as {
      embeddedAt: string;
    }[];
    expect(Date.parse(inserted.embeddedAt)).toBeGreaterThan(
      Date.parse(article.updatedAt),
    );
  });

  it("keeps lexical search available when the provider fails", async () => {
    selectRows.push([ARTICLE]);
    embedHelpDocuments.mockResolvedValue({
      ok: false,
      error: {
        code: "rate-limited",
        message: "Try later",
        retryable: true,
      },
    });

    await expect(refreshHelpArticleEmbeddings(ARTICLE.id)).resolves.toEqual({
      status: "failed",
      articleId: ARTICLE.id,
      chunks: 0,
      code: "rate-limited",
      retryable: true,
      error: "Try later",
    });
    expect(deleteWhere).not.toHaveBeenCalled();
  });
});

describe("runHelpEmbeddingWorker", () => {
  it("does not self-chain an exact final batch", async () => {
    selectRows.push([{ id: ARTICLE.id }], [ARTICLE], [ARTICLE]);

    const result = await runHelpEmbeddingWorker(1);

    expect(result).toMatchObject({
      selected: 1,
      indexed: 1,
      failed: 0,
      skipped: 0,
      chunks: 1,
      remaining: false,
    });
    // One cleanup statement plus the per-article advisory transaction lock.
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("self-chains only when one lookahead candidate proves work remains", async () => {
    selectRows.push(
      [{ id: ARTICLE.id }, { id: "article-2" }],
      [ARTICLE],
      [ARTICLE],
    );

    await expect(runHelpEmbeddingWorker(1)).resolves.toMatchObject({
      selected: 1,
      indexed: 1,
      remaining: true,
    });
    expect(embedHelpDocuments).toHaveBeenCalledOnce();
  });

  it("continues after an article-local non-retryable failure", async () => {
    const second = { ...ARTICLE, id: "article-2" };
    selectRows.push(
      [{ id: ARTICLE.id }, { id: second.id }],
      [ARTICLE],
      [second],
      [second],
    );
    embedHelpDocuments
      .mockResolvedValueOnce({
        ok: false,
        error: {
          code: "invalid-input",
          message: "One document is invalid",
          retryable: false,
        },
      })
      .mockResolvedValueOnce(EMBED_SUCCESS);

    await expect(runHelpEmbeddingWorker(8)).resolves.toMatchObject({
      selected: 2,
      indexed: 1,
      skipped: 1,
      failed: 0,
      remaining: false,
    });
    expect(embedHelpDocuments).toHaveBeenCalledTimes(2);
  });

  it("stops the burst after a retryable provider-wide failure", async () => {
    selectRows.push([{ id: ARTICLE.id }, { id: "article-2" }], [ARTICLE]);
    embedHelpDocuments.mockResolvedValueOnce({
      ok: false,
      error: {
        code: "provider-unavailable",
        message: "Try later",
        retryable: true,
      },
    });

    await expect(runHelpEmbeddingWorker(8)).resolves.toMatchObject({
      selected: 2,
      indexed: 0,
      skipped: 0,
      failed: 1,
      remaining: false,
    });
    expect(embedHelpDocuments).toHaveBeenCalledOnce();
  });
});
