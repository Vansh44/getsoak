/* eslint-disable @typescript-eslint/no-explicit-any */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => "203.0.113.10" })),
}));
vi.mock("@/lib/rate-limit", () => ({
  clientIp: vi.fn(() => "203.0.113.10"),
  rateLimit: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("@/lib/ai/gemini", () => ({ callGemini: vi.fn() }));
vi.mock("@/app/actions/help-actions", () => ({
  searchPublishedHelpWithAi: vi.fn(),
}));
vi.mock("@/lib/help/queries", () => ({
  getPublishedHelpDocumentsForAssistant: vi.fn(),
}));
vi.mock("@/lib/help/vector-search", () => ({
  searchHelpArticleChunksByMeaning: vi.fn(),
}));

import { callGemini } from "@/lib/ai/gemini";
import { rateLimit } from "@/lib/rate-limit";
import { searchPublishedHelpWithAi } from "@/app/actions/help-actions";
import { getPublishedHelpDocumentsForAssistant } from "@/lib/help/queries";
import { searchHelpArticleChunksByMeaning } from "@/lib/help/vector-search";
import { askHelpAssistant } from "./help-assistant-actions";

const DOCUMENT = {
  slug: "process-an-in-store-sale",
  categorySlug: "point-of-sale",
  categoryTitle: "Point of Sale",
  title: "Process an in-store sale",
  excerpt: "Complete a counter checkout.",
  body: "<h2>Take payment</h2><ol><li>Select <strong>Sell</strong>.</li><li>Select <strong>Take payment</strong>.</li></ol>",
  updatedAt: "2026-08-25T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(rateLimit).mockResolvedValue({ allowed: true } as any);
  vi.mocked(searchPublishedHelpWithAi).mockResolvedValue({
    mode: "ai",
    results: [
      {
        title: DOCUMENT.title,
        url: "/help/point-of-sale/process-an-in-store-sale",
        excerpt: DOCUMENT.excerpt,
      },
    ],
  });
  vi.mocked(getPublishedHelpDocumentsForAssistant).mockResolvedValue([
    DOCUMENT,
  ] as any);
  vi.mocked(searchHelpArticleChunksByMeaning).mockResolvedValue({
    status: "no-match",
    matches: [],
  });
  vi.mocked(callGemini).mockResolvedValue({
    text: JSON.stringify({
      answer: "Open the register and take payment.",
      steps: ["Open Sell.", "Select Take payment."],
      notes: ["Review the total before completing the sale."],
      sourceSlugs: [DOCUMENT.slug, "invented-guide"],
      followUps: ["How do I split a payment?"],
      clarificationPrompts: [],
      needsHuman: false,
    }),
  });
});

describe("askHelpAssistant", () => {
  it("uses conversation context and returns only validated published sources", async () => {
    const result = await askHelpAssistant({
      message: "What should I tap next?",
      history: [
        { role: "user", content: "I am processing a POS sale" },
        { role: "assistant", content: "Add the products to the cart." },
      ],
    });

    expect(searchPublishedHelpWithAi).toHaveBeenCalledWith(
      "I am processing a POS sale What should I tap next?",
    );
    expect(getPublishedHelpDocumentsForAssistant).toHaveBeenCalledWith([
      DOCUMENT.slug,
    ]);
    expect(callGemini).toHaveBeenCalledWith(
      expect.stringContaining("ONLY the PUBLISHED HELP DOCUMENTS"),
      expect.stringContaining("Select Take payment"),
      expect.objectContaining({
        temperature: 0.2,
        responseMimeType: "application/json",
      }),
    );
    expect(result).toEqual({
      success: true,
      data: {
        answer: "Open the register and take payment.",
        steps: ["Open Sell.", "Select Take payment."],
        notes: ["Review the total before completing the sale."],
        sources: [
          {
            title: DOCUMENT.title,
            url: "/help/point-of-sale/process-an-in-store-sale",
            excerpt: DOCUMENT.excerpt,
          },
        ],
        clarificationPrompts: [],
        followUps: ["How do I split a payment?"],
        needsHuman: false,
      },
    });
  });

  it("does not contaminate a self-contained topic switch with older context", async () => {
    await askHelpAssistant({
      message: "Is there a guide for connecting DNS?",
      history: [
        { role: "user", content: "How do I process a POS sale?" },
        { role: "assistant", content: "Open Sell." },
      ],
    });

    expect(searchPublishedHelpWithAi).toHaveBeenCalledWith(
      "Is there a guide for connecting DNS?",
    );
    expect(searchHelpArticleChunksByMeaning).toHaveBeenCalledWith(
      "Is there a guide for connecting DNS?",
    );
  });

  it("does not ask the model to guess when no published guide supports the query", async () => {
    vi.mocked(searchPublishedHelpWithAi).mockResolvedValue({
      mode: "keyword",
      results: [],
    });
    vi.mocked(getPublishedHelpDocumentsForAssistant).mockResolvedValue([]);

    const result = await askHelpAssistant({
      message: "Can StoreMink teleport my orders?",
    });

    expect(result).toMatchObject({
      success: true,
      data: {
        needsHuman: true,
        sources: [],
        steps: [],
        followUps: [],
        clarificationPrompts: [
          "The StoreMink page or menu you are using",
          "What you want to complete and what happened after your last step",
        ],
      },
    });
    expect(callGemini).not.toHaveBeenCalled();
  });

  it("falls back to verified guides when answer generation is unavailable", async () => {
    vi.mocked(callGemini).mockResolvedValue({ error: "AI unavailable" });

    const result = await askHelpAssistant({
      message: "How do I take payment?",
    });

    expect(result).toMatchObject({
      success: true,
      data: {
        sources: [
          {
            url: "/help/point-of-sale/process-an-in-store-sale",
          },
        ],
      },
    });
  });

  it("uses a semantic-only article and puts its best section first", async () => {
    vi.mocked(searchPublishedHelpWithAi).mockResolvedValue({
      mode: "keyword",
      results: [],
    });
    vi.mocked(searchHelpArticleChunksByMeaning).mockResolvedValue({
      status: "ok",
      matches: [
        {
          articleId: "article-1",
          articleSlug: DOCUMENT.slug,
          chunkId: "chunk-late",
          categorySlug: DOCUMENT.categorySlug,
          categoryTitle: DOCUMENT.categoryTitle,
          title: DOCUMENT.title,
          excerpt: DOCUMENT.excerpt,
          heading: "Resume a held sale",
          headingAnchor: "resume-a-held-sale",
          content: "Open Held sales, select the sale, and choose Resume.",
          similarity: 0.84,
          sourceUpdatedAt: "2026-08-25 00:00:00+00",
        },
      ],
    });

    const result = await askHelpAssistant({
      message: "How can I continue a parked counter order?",
    });

    expect(getPublishedHelpDocumentsForAssistant).toHaveBeenCalledWith([
      DOCUMENT.slug,
    ]);
    expect(callGemini).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining(
        "Open Held sales, select the sale, and choose Resume.",
      ),
      expect.any(Object),
    );
    expect(result).toMatchObject({
      success: true,
      data: {
        sources: [{ url: `/help/point-of-sale/${DOCUMENT.slug}` }],
      },
    });
  });

  it("drops semantic text from an older article revision", async () => {
    vi.mocked(searchHelpArticleChunksByMeaning).mockResolvedValue({
      status: "ok",
      matches: [
        {
          articleId: "article-1",
          articleSlug: DOCUMENT.slug,
          chunkId: "stale-chunk",
          categorySlug: DOCUMENT.categorySlug,
          categoryTitle: DOCUMENT.categoryTitle,
          title: DOCUMENT.title,
          excerpt: DOCUMENT.excerpt,
          heading: "Old instructions",
          headingAnchor: "old-instructions",
          content: "STALE VECTOR INSTRUCTIONS",
          similarity: 0.92,
          sourceUpdatedAt: "2026-08-24 00:00:00+00",
        },
      ],
    });

    await askHelpAssistant({ message: "How do I process a POS sale?" });

    const prompt = vi.mocked(callGemini).mock.calls[0]?.[1] ?? "";
    expect(prompt).not.toContain("STALE VECTOR INSTRUCTIONS");
    expect(prompt).toContain("Select Take payment");
  });

  it("validates public input and enforces the per-IP assistant limit", async () => {
    await expect(askHelpAssistant({ message: " " })).resolves.toEqual({
      error:
        "Please enter a complete StoreMink question, such as “How do I process a POS sale?”",
    });
    await expect(
      askHelpAssistant({
        message: "ll",
        history: [{ role: "user", content: "How do I process a POS sale?" }],
      }),
    ).resolves.toEqual({
      error:
        "Please enter a complete StoreMink question, such as “How do I process a POS sale?”",
    });
    await expect(
      askHelpAssistant({ message: "x".repeat(1_001) }),
    ).resolves.toEqual({
      error: "Keep your question under 1,000 characters.",
    });
    expect(rateLimit).not.toHaveBeenCalled();

    vi.mocked(rateLimit).mockResolvedValue({ allowed: false } as any);
    const limited = await askHelpAssistant({ message: "How do I add stock?" });
    expect(limited).toEqual({
      error:
        "You’ve reached the Help Assistant limit for now. Please try again later or email support@storemink.com.",
    });
    expect(rateLimit).toHaveBeenCalledWith("help:assistant:203.0.113.10", {
      max: 20,
      windowSeconds: 3600,
    });
    expect(searchPublishedHelpWithAi).not.toHaveBeenCalled();
  });

  it("rejects unrelated random input before lexical or vector retrieval", async () => {
    const result = await askHelpAssistant({
      message: "asdfgh",
      history: [
        { role: "user", content: "How do I process a POS sale?" },
        { role: "assistant", content: "Open Sell." },
      ],
    });

    expect(result).toEqual({
      error:
        "Please enter a complete StoreMink question, such as “How do I process a POS sale?”",
    });
    expect(searchPublishedHelpWithAi).not.toHaveBeenCalled();
    expect(searchHelpArticleChunksByMeaning).not.toHaveBeenCalled();
    expect(callGemini).not.toHaveBeenCalled();
  });

  it("keeps all six lexical candidates when vectors only reinforce one", async () => {
    const documents = Array.from({ length: 6 }, (_, index) => ({
      ...DOCUMENT,
      slug: `guide-${index + 1}`,
      title: `Guide ${index + 1}`,
    }));
    vi.mocked(searchPublishedHelpWithAi).mockResolvedValue({
      mode: "keyword",
      results: documents.map((document) => ({
        title: document.title,
        url: `/help/${document.categorySlug}/${document.slug}`,
        excerpt: document.excerpt,
      })),
    });
    vi.mocked(searchHelpArticleChunksByMeaning).mockResolvedValue({
      status: "ok",
      matches: [
        {
          articleId: "article-1",
          articleSlug: documents[0].slug,
          chunkId: "chunk-1",
          categorySlug: DOCUMENT.categorySlug,
          categoryTitle: DOCUMENT.categoryTitle,
          title: documents[0].title,
          excerpt: DOCUMENT.excerpt,
          heading: "Checkout",
          headingAnchor: "checkout",
          content: "Take payment.",
          similarity: 0.91,
          sourceUpdatedAt: DOCUMENT.updatedAt,
        },
      ],
    });
    vi.mocked(getPublishedHelpDocumentsForAssistant).mockResolvedValue(
      documents as any,
    );

    await askHelpAssistant({ message: "How do I manage my store?" });

    expect(getPublishedHelpDocumentsForAssistant).toHaveBeenCalledWith(
      documents.map((document) => document.slug),
    );
  });

  it("does not present a generated answer when no cited slug validates", async () => {
    vi.mocked(callGemini).mockResolvedValue({
      text: JSON.stringify({
        answer: "Use an invented control.",
        steps: ["Select an invented button."],
        notes: [],
        sourceSlugs: ["invented-guide"],
        followUps: [],
        clarificationPrompts: [],
        needsHuman: false,
      }),
    });

    const result = await askHelpAssistant({
      message: "How do I take payment?",
    });

    expect(result).toMatchObject({
      success: true,
      data: {
        needsHuman: true,
        steps: [],
        sources: [{ url: "/help/point-of-sale/process-an-in-store-sale" }],
      },
    });
    expect(result).not.toMatchObject({
      data: { answer: "Use an invented control." },
    });
  });

  it("never exposes clarification prompts as clickable follow-up questions", async () => {
    vi.mocked(callGemini).mockResolvedValue({
      text: JSON.stringify({
        answer: "I need a little more context to confirm the right steps.",
        steps: [],
        notes: [],
        sourceSlugs: [DOCUMENT.slug],
        followUps: ["Which StoreMink page are you on?"],
        clarificationPrompts: [
          "The StoreMink page or menu you are using",
          "The result you expected",
        ],
        needsHuman: true,
      }),
    });

    const result = await askHelpAssistant({
      message: "How do I fix this StoreMink issue?",
    });

    expect(result).toMatchObject({
      success: true,
      data: {
        needsHuman: true,
        followUps: [],
        clarificationPrompts: [
          "The StoreMink page or menu you are using",
          "The result you expected",
        ],
      },
    });
  });

  it("retries a transient published-document read once", async () => {
    vi.mocked(getPublishedHelpDocumentsForAssistant)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([DOCUMENT] as any);

    const result = await askHelpAssistant({
      message: "How do I process a POS sale?",
    });

    expect(getPublishedHelpDocumentsForAssistant).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      success: true,
      data: {
        sources: [{ url: "/help/point-of-sale/process-an-in-store-sale" }],
      },
    });
  });
});
