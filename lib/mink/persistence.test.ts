import { describe, expect, it } from "vitest";
import { conversationTitle, MINK_CONVERSATION_LIMIT } from "./persistence";

describe("conversationTitle", () => {
  it("keeps the product retention contract at ten conversations", () => {
    expect(MINK_CONVERSATION_LIMIT).toBe(10);
  });

  it("normalises whitespace and caps titles without splitting the suffix", () => {
    expect(conversationTitle("  How   are my products?  ")).toBe(
      "How are my products?",
    );
    const title = conversationTitle("a".repeat(100));
    expect(title).toHaveLength(78);
    expect(title.endsWith("…")).toBe(true);
  });
});
