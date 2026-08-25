import { describe, expect, it } from "vitest";
import { fuseHelpRankings } from "./hybrid-ranking";

type Lexical = {
  articleId?: string;
  articleSlug?: string;
  title: string;
};

type VectorChunk = {
  articleId?: string;
  articleSlug?: string;
  chunkId?: string;
  content: string;
};

const lexical = (articleSlug: string, title = articleSlug): Lexical => ({
  articleSlug,
  title,
});

const chunk = (
  articleSlug: string,
  chunkId: string,
  content = chunkId,
): VectorChunk => ({ articleSlug, chunkId, content });

describe("fuseHelpRankings", () => {
  it("uses reciprocal-rank fusion while retaining source ranks and chunks", () => {
    const results = fuseHelpRankings(
      [lexical("a"), lexical("b"), lexical("c")],
      [chunk("b", "b-1"), chunk("c", "c-1"), chunk("d", "d-1")],
    );

    expect(results.map((result) => result.articleSlug)).toEqual([
      "b",
      "c",
      "a",
      "d",
    ]);
    expect(results[0]).toMatchObject({
      lexicalRank: 2,
      vectorRank: 1,
      bestLexical: { articleSlug: "b" },
      bestVector: { chunkId: "b-1" },
      vectorChunks: [{ chunkId: "b-1" }],
    });
    expect(results[0].score).toBeCloseTo(1 / 62 + 1 / 61, 12);
  });

  it("deduplicates by either id or slug and keeps distinct best-ranked chunks", () => {
    const duplicateChunk = {
      articleId: "article-1",
      articleSlug: "process-a-pos-sale",
      chunkId: "chunk-1",
      content: "duplicate",
    };
    const results = fuseHelpRankings(
      [
        {
          articleId: "article-1",
          title: "Process a POS sale",
        },
      ],
      [
        {
          articleId: "article-1",
          articleSlug: "process-a-pos-sale",
          chunkId: "chunk-1",
          content: "Add products to the cart.",
        },
        duplicateChunk,
        {
          articleSlug: "PROCESS-A-POS-SALE",
          chunkId: "chunk-2",
          content: "Take payment and complete the sale.",
        },
      ],
    );

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      articleId: "article-1",
      articleSlug: "process-a-pos-sale",
      lexicalRank: 1,
      vectorRank: 1,
      bestVector: { chunkId: "chunk-1", content: "Add products to the cart." },
    });
    expect(results[0].vectorChunks.map((item) => item.chunkId)).toEqual([
      "chunk-1",
      "chunk-2",
    ]);
    // Multiple chunks from one article preserve evidence, but contribute only
    // the article's best rank from each retrieval source.
    expect(results[0].score).toBeCloseTo(2 / 61, 12);
  });

  it("makes vector candidates additive instead of evicting lexical matches", () => {
    const lexicalCandidates = [lexical("lexical-a"), lexical("lexical-b")];
    const vectorCandidates = [
      chunk("vector-only", "v-1"),
      chunk("lexical-b", "b-1"),
    ];

    const bounded = fuseHelpRankings(lexicalCandidates, vectorCandidates, {
      limit: 2,
    });
    expect(new Set(bounded.map((item) => item.articleSlug))).toEqual(
      new Set(["lexical-a", "lexical-b"]),
    );
    // Semantic agreement may still promote a lexical result.
    expect(bounded[0].articleSlug).toBe("lexical-b");

    expect(
      fuseHelpRankings(lexicalCandidates, vectorCandidates, { limit: 3 }).map(
        (item) => item.articleSlug,
      ),
    ).toContain("vector-only");
  });

  it("uses deterministic source and input-order tie breaking", () => {
    const results = fuseHelpRankings(
      [lexical("lexical-first")],
      [chunk("vector-first", "v-1")],
    );

    // Both are rank 1 in one source and therefore have the same RRF score.
    // A lexical rank wins the source tie before original input order is used.
    expect(results.map((result) => result.articleSlug)).toEqual([
      "lexical-first",
      "vector-first",
    ]);
  });

  it("does not mutate inputs and ignores candidates without an article key", () => {
    const lexicalCandidates = Object.freeze([
      Object.freeze(lexical("kept")),
      Object.freeze({ articleId: undefined, title: "No identity" }),
    ]);
    const vectorCandidates = Object.freeze([
      Object.freeze(chunk("kept", "kept-1")),
      Object.freeze({ chunkId: "orphan", content: "No article identity" }),
    ]);

    const results = fuseHelpRankings(lexicalCandidates, vectorCandidates);

    expect(results).toHaveLength(1);
    expect(results[0].articleSlug).toBe("kept");
    expect(lexicalCandidates.map((item) => item.title)).toEqual([
      "kept",
      "No identity",
    ]);
    expect(vectorCandidates.map((item) => item.chunkId)).toEqual([
      "kept-1",
      "orphan",
    ]);
  });

  it("handles empty and bounded result sets", () => {
    expect(fuseHelpRankings([], [])).toEqual([]);
    expect(
      fuseHelpRankings([lexical("a")], [chunk("b", "b-1")], {
        limit: 0,
      }),
    ).toEqual([]);
  });
});
