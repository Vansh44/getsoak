import { describe, expect, it } from "vitest";
import {
  buildHelpArticleChunks,
  HELP_CHUNK_INDEX_VERSION,
  HELP_CHUNK_MAX_CHARS,
} from "./chunks";

const SOURCE = {
  title: "Process an in-store sale",
  excerpt: "Add items and complete checkout from the StoreMink register.",
  categoryTitle: "Point of Sale",
};

describe("buildHelpArticleChunks", () => {
  it("keeps headings and removes HTML from retrieval content", () => {
    const chunks = buildHelpArticleChunks({
      ...SOURCE,
      body: "<p>Before you start.</p><h2>Complete checkout</h2><ol><li>Open Sell.</li><li>Scan a product.</li></ol>",
    });

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({
      chunkIndex: 0,
      heading: null,
      content: "Before you start.",
    });
    expect(chunks[1]).toMatchObject({
      chunkIndex: 1,
      heading: "Complete checkout",
      headingAnchor: "complete-checkout",
      headingLevel: 2,
    });
    expect(chunks[1].content).toContain("Open Sell.");
    expect(chunks[1].embeddingText).toContain("Category: Point of Sale");
    expect(chunks[1].embeddingText).toContain(
      "Article: Process an in-store sale",
    );
    expect(chunks[1].embeddingText).not.toContain("<li>");
  });

  it("splits oversized sections into bounded chunks", () => {
    const paragraph = `${"Complete the sale and print the receipt. ".repeat(80)}Done.`;
    const chunks = buildHelpArticleChunks({
      ...SOURCE,
      body: `<h2>Checkout</h2><p>${paragraph}</p>`,
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(
      chunks.every((chunk) => chunk.content.length <= HELP_CHUNK_MAX_CHARS),
    ).toBe(true);
    expect(chunks.map((chunk) => chunk.chunkIndex)).toEqual(
      chunks.map((_, index) => index),
    );
  });

  it("falls back to the excerpt and produces stable content hashes", () => {
    const first = buildHelpArticleChunks({ ...SOURCE, body: null });
    const second = buildHelpArticleChunks({ ...SOURCE, body: "" });

    expect(first).toHaveLength(1);
    expect(first[0].content).toBe(SOURCE.excerpt);
    expect(first[0].contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(second[0].contentHash).toBe(first[0].contentHash);
  });

  it("uses title and category as a stable fallback for an empty published guide", () => {
    const chunks = buildHelpArticleChunks({
      ...SOURCE,
      excerpt: null,
      body: "<h2>Checkout</h2>",
    });

    expect(HELP_CHUNK_INDEX_VERSION).toBe(2);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      chunkIndex: 0,
      heading: null,
      content: "Process an in-store sale\nCategory: Point of Sale",
    });
    expect(chunks[0].embeddingText).toContain(
      "Article: Process an in-store sale",
    );
  });

  it("decodes HTML entities before storing and embedding plain text", () => {
    const [chunk] = buildHelpArticleChunks({
      ...SOURCE,
      title: "Shipping &amp; delivery",
      excerpt: "Rates &amp; promises",
      body: "<h2>Rates &amp; zones</h2><p>Tea &amp; coffee cost &#8377;50.</p>",
    });

    expect(chunk.heading).toBe("Rates & zones");
    expect(chunk.content).toBe("Tea & coffee cost ₹50.");
    expect(chunk.embeddingText).toContain("Article: Shipping & delivery");
    expect(chunk.embeddingText).not.toContain("&amp;");
  });

  it("bounds operator-owned metadata before it reaches the provider", () => {
    const chunks = buildHelpArticleChunks({
      ...SOURCE,
      categoryTitle: "C".repeat(10_000),
      body: null,
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0].embeddingText.length).toBeLessThan(2_000);
    expect(chunks[0].embeddingText).not.toContain("C".repeat(501));
  });
});
