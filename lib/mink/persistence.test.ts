import { describe, expect, it } from "vitest";
import { conversationTitle } from "./persistence";

describe("conversationTitle", () => {
  it("normalises whitespace and caps titles without splitting the suffix", () => {
    expect(conversationTitle("  How   are my products?  ")).toBe(
      "How are my products?",
    );
    const title = conversationTitle("a".repeat(100));
    expect(title).toHaveLength(78);
    expect(title.endsWith("…")).toBe(true);
  });
});
