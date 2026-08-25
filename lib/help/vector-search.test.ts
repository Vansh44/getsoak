import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sqlParamValues, sqlText } from "@/app/actions/_test-helpers";

const execute = vi.hoisted(() => vi.fn());
const embedHelpQuery = vi.hoisted(() => vi.fn());
const logInfo = vi.hoisted(() => vi.fn());
const logWarn = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db/client", () => ({
  withAnon: vi.fn(async (callback: (db: unknown) => unknown) =>
    callback({ execute }),
  ),
}));
vi.mock("@/lib/help/embeddings", () => ({ embedHelpQuery }));
vi.mock("@/lib/observability/logger", () => ({ logInfo, logWarn }));

import { searchHelpArticleChunksByMeaning } from "./vector-search";

const ORIGINAL_MIN_SIMILARITY = process.env.HELP_VECTOR_MIN_SIMILARITY;

afterAll(() => {
  if (ORIGINAL_MIN_SIMILARITY === undefined) {
    delete process.env.HELP_VECTOR_MIN_SIMILARITY;
  } else {
    process.env.HELP_VECTOR_MIN_SIMILARITY = ORIGINAL_MIN_SIMILARITY;
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.HELP_VECTOR_MIN_SIMILARITY;
  embedHelpQuery.mockResolvedValue({
    ok: true,
    value: Array.from({ length: 768 }, (_, index) => (index === 0 ? 1 : 0)),
    backend: "gemini-api",
    model: "gemini-embedding-001",
    dimensions: 768,
  });
  execute.mockResolvedValue({ rows: [] });
});

describe("searchHelpArticleChunksByMeaning", () => {
  it("returns validated published chunk matches", async () => {
    execute.mockResolvedValue({
      rows: [
        {
          article_id: "article-1",
          article_slug: "process-an-in-store-sale",
          chunk_id: "chunk-1",
          category_slug: "point-of-sale",
          category_title: "Point of Sale",
          title: "Process an in-store sale",
          excerpt: "Complete a counter checkout.",
          heading: "Take payment",
          heading_anchor: "take-payment",
          content: "Choose the payment method and complete the sale.",
          source_updated_at: "2026-08-25 12:00:00+00",
          similarity: "0.82",
        },
      ],
    });

    const result = await searchHelpArticleChunksByMeaning(
      "How can I ring up a customer?",
    );

    expect(result.status).toBe("ok");
    expect(result.matches[0]).toMatchObject({
      articleSlug: "process-an-in-store-sale",
      chunkId: "chunk-1",
      sourceUpdatedAt: "2026-08-25 12:00:00+00",
      similarity: 0.82,
    });
    expect(logInfo).toHaveBeenCalledWith(
      "help.semantic_retrieval complete",
      expect.objectContaining({ candidates: 1 }),
    );
  });

  it("falls back to the default threshold when the environment value is blank", async () => {
    process.env.HELP_VECTOR_MIN_SIMILARITY = "   ";

    await searchHelpArticleChunksByMeaning("checkout");

    const query = execute.mock.calls[0]?.[0];
    const params = sqlParamValues(query);
    expect(params).toContain(0.55);
    expect(params).not.toContain(0);
  });

  it("uses a trimmed valid threshold and caps chunks per article before the global limit", async () => {
    process.env.HELP_VECTOR_MIN_SIMILARITY = " 0.72 ";

    await searchHelpArticleChunksByMeaning("checkout", 12);

    const query = execute.mock.calls[0]?.[0];
    expect(sqlParamValues(query)).toEqual(
      expect.arrayContaining(["gemini-embedding-001", 1, 0.72, 3, 12]),
    );
    expect(sqlText(query)).toMatch(/chunk\.index_version\s*=/i);
    expect(sqlText(query)).toMatch(
      /ROW_NUMBER\(\) OVER\s*\(\s*PARTITION BY article_id\s*ORDER BY similarity DESC, chunk_id\s*\)/i,
    );
    expect(sqlText(query)).toMatch(/WHERE article_chunk_rank <=/i);
    expect(sqlText(query).indexOf("WHERE article_chunk_rank <=")).toBeLessThan(
      sqlText(query).indexOf("LIMIT"),
    );
  });

  it("fails soft when embeddings are unavailable", async () => {
    embedHelpQuery.mockResolvedValue({
      ok: false,
      error: {
        code: "not-configured",
        message: "not configured",
        retryable: false,
      },
    });

    await expect(searchHelpArticleChunksByMeaning("checkout")).resolves.toEqual(
      { status: "unavailable", matches: [] },
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("fails soft when pgvector has not been migrated yet", async () => {
    execute.mockRejectedValue(
      new Error('relation "help_article_chunks" does not exist'),
    );

    await expect(searchHelpArticleChunksByMeaning("checkout")).resolves.toEqual(
      { status: "unavailable", matches: [] },
    );
    expect(logWarn).toHaveBeenCalledWith(
      "help.semantic_retrieval unavailable",
      expect.objectContaining({ stage: "database" }),
    );
  });

  it("drops malformed database rows instead of leaking them downstream", async () => {
    execute.mockResolvedValue({
      rows: [{ article_id: "article-1", similarity: "not-a-number" }],
    });

    await expect(searchHelpArticleChunksByMeaning("checkout")).resolves.toEqual(
      { status: "no-match", matches: [] },
    );
  });
});
