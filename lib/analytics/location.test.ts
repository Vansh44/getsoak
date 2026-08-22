import { describe, expect, it } from "vitest";
import { resolveAnalyticsLocation } from "./location";

const options = [
  { id: "delhi", name: "Delhi" },
  { id: "mumbai", name: "Mumbai" },
];

describe("analytics location selection", () => {
  it("keeps an unrestricted owner's aggregate view", () => {
    expect(resolveAnalyticsLocation(undefined, null, options)).toEqual({
      locationIds: null,
      includeUnassigned: true,
      selectedId: null,
    });
  });

  it("uses one validated physical location without online orders", () => {
    expect(resolveAnalyticsLocation("mumbai", null, options)).toEqual({
      locationIds: ["mumbai"],
      includeUnassigned: false,
      selectedId: "mumbai",
    });
  });

  it("cannot widen or select outside a restricted viewer's options", () => {
    expect(resolveAnalyticsLocation("delhi", ["mumbai"], [options[1]])).toEqual(
      {
        locationIds: ["mumbai"],
        includeUnassigned: true,
        selectedId: null,
      },
    );
  });

  it("treats repeated query values as their first value", () => {
    expect(
      resolveAnalyticsLocation(["delhi", "mumbai"], null, options).selectedId,
    ).toBe("delhi");
  });
});
