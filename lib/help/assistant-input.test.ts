import { describe, expect, it } from "vitest";
import {
  helpAssistantQuestionError,
  normalizeHelpAssistantQuestion,
} from "./assistant-input";

describe("Help Assistant input", () => {
  it("normalizes user questions without changing their language", () => {
    expect(normalizeHelpAssistantQuestion("  How   do I pay? \n")).toBe(
      "How do I pay?",
    );
    expect(normalizeHelpAssistantQuestion("मैं भुगतान कैसे लूँ?")).toBe(
      "मैं भुगतान कैसे लूँ?",
    );
  });

  it("rejects one-token keyboard noise but permits known topics and follow-ups", () => {
    expect(helpAssistantQuestionError("ll")).toMatch(/complete StoreMink/i);
    expect(helpAssistantQuestionError("asdf")).toMatch(/complete StoreMink/i);
    expect(helpAssistantQuestionError("asdfgh")).toMatch(/complete StoreMink/i);
    expect(helpAssistantQuestionError("asdfgh!")).toMatch(
      /complete StoreMink/i,
    );
    expect(helpAssistantQuestionError("POS")).toBeNull();
    expect(helpAssistantQuestionError("inventory")).toBeNull();
    expect(helpAssistantQuestionError("login?")).toBeNull();
    expect(
      helpAssistantQuestionError("why", { hasConversationContext: true }),
    ).toBeNull();
    expect(helpAssistantQuestionError("why")).toMatch(/complete StoreMink/i);
  });
});
