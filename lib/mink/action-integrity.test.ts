import { describe, expect, it } from "vitest";
import { hashMinkActionPayload } from "./action-integrity";

describe("Mink action payload integrity", () => {
  it("is stable across nested JSON object-key ordering", () => {
    expect(
      hashMinkActionPayload({
        storeId: "store-1",
        before: {
          status: "pending",
          payment: { method: "cod", state: "pending" },
        },
        after: { status: "processing", note: null },
      }),
    ).toBe(
      hashMinkActionPayload({
        after: { note: null, status: "processing" },
        before: {
          payment: { state: "pending", method: "cod" },
          status: "pending",
        },
        storeId: "store-1",
      }),
    );
  });

  it("preserves array order and detects business-value changes", () => {
    const original = hashMinkActionPayload({
      ids: ["one", "two"],
      status: "pending",
    });
    expect(
      hashMinkActionPayload({ ids: ["two", "one"], status: "pending" }),
    ).not.toBe(original);
    expect(
      hashMinkActionPayload({ ids: ["one", "two"], status: "processing" }),
    ).not.toBe(original);
  });
});
