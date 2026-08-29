import { describe, expect, it } from "vitest";
import { redactMinkFeedbackDetails } from "./feedback";

describe("redactMinkFeedbackDetails", () => {
  it("removes common private values before support storage", () => {
    expect(
      redactMinkFeedbackDetails(
        "Email a@b.com phone +91 98765 43210 token=abc123 order 10000000-0000-4000-8000-000000000001",
      ),
    ).toBe(
      "Email [email redacted] phone [phone redacted] token: [redacted] order [identifier redacted]",
    );
  });

  it("returns null for empty feedback and bounds stored detail", () => {
    expect(redactMinkFeedbackDetails("  ")).toBeNull();
    expect(redactMinkFeedbackDetails("x".repeat(800))).toHaveLength(500);
  });
});
