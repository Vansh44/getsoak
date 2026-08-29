import { describe, expect, it } from "vitest";
import { estimateMinkCost } from "./cost";

const usage = {
  promptTokens: 1_000,
  outputTokens: 200,
  thoughtTokens: 50,
  totalTokens: 1_250,
};

describe("estimateMinkCost", () => {
  it("prices Gemini 3.7 Flash response and thought tokens as output", () => {
    expect(
      estimateMinkCost({
        model: "gemini-3.7-flash",
        location: "global",
        usage,
        at: new Date("2026-08-29T00:00:00Z"),
      }),
    ).toEqual({
      estimatedCostMicrousd: 1_688,
      pricingVersion: "gemini-3.7-flash-global-2026-intro",
    });
  });

  it("uses the documented standard rate from 2027", () => {
    expect(
      estimateMinkCost({
        model: "gemini-3.7-flash",
        location: "global",
        usage,
        at: new Date("2027-01-01T00:00:00Z"),
      }).estimatedCostMicrousd,
    ).toBe(3_375);
  });

  it("keeps unknown models visibly unpriced instead of treating them as free", () => {
    expect(
      estimateMinkCost({
        model: "future-model",
        location: "global",
        usage,
      }),
    ).toEqual({ estimatedCostMicrousd: null, pricingVersion: null });
  });
});
