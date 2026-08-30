import { describe, expect, it } from "vitest";
import { minkShadowMeter } from "./metering";

describe("minkShadowMeter", () => {
  it("segments successful lookup and analysis runs without charging", () => {
    expect(
      minkShadowMeter({ status: "succeeded", toolCalls: 1, usageKnown: true }),
    ).toEqual({ shadowCredits: 3, costCohort: "read_lookup" });
    expect(
      minkShadowMeter({ status: "succeeded", toolCalls: 3, usageKnown: true }),
    ).toEqual({ shadowCredits: 3, costCohort: "read_analysis" });
  });

  it("never presents unknown usage as free pilot consumption", () => {
    expect(
      minkShadowMeter({ status: "cancelled", toolCalls: 0, usageKnown: false }),
    ).toEqual({ shadowCredits: 0, costCohort: "read_unknown" });
  });
});
