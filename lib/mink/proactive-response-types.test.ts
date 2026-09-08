import { describe, it, expect } from "vitest";
import {
  rankResponseSignals,
  isResponseSignal,
  RESPONSE_LIMITS,
} from "./proactive-response-types";
import {
  buildBusinessBriefResult,
  type BusinessBriefSnapshot,
} from "./business-brief-types";
const snapshot: BusinessBriefSnapshot = {
  period: "daily",
  rangeLabel: "Yesterday",
  comparisonLabel: "Previous day",
  fromInclusive: "2026-09-05T00:00:00Z",
  toExclusive: "2026-09-06T00:00:00Z",
  timeZone: "Asia/Kolkata",
  currency: "INR",
  locationLabel: "Shop and Delhi",
  netSales: 50,
  previousNetSales: 100,
  orders: 5,
  previousOrders: 10,
  returns: 10,
  previousReturns: 5,
  createdOrders: 10,
  failedPaymentOrders: 3,
  locations: [
    {
      id: "Delhi",
      name: "Delhi",
      trackedItems: 20,
      lowStock: 2,
      outOfStock: 1,
    },
  ],
  dataAsOf: "2026-09-06T00:00:00Z",
};
describe("proactive triage", () => {
  it("ranks only evidenced signals with explicit unknown impact", () => {
    const plans = rankResponseSignals(
      buildBusinessBriefResult(snapshot),
      "brief",
    );
    expect(plans.map((p) => p.signal)).toEqual([
      "inventory",
      "payments",
      "sales",
      "returns",
    ]);
    expect(plans.map((p) => p.rank)).toEqual([1, 2, 3, 4]);
    expect(plans.every((p) => p.impact.includes("unknown"))).toBe(true);
  });
  it.each(["sales", "returns", "payments", "inventory"])(
    "respects a %s-only watch",
    (kind) => {
      expect(
        rankResponseSignals(buildBusinessBriefResult(snapshot), kind).map(
          (p) => p.signal,
        ),
      ).toEqual([kind]);
    },
  );
  it("never converts insufficient data or no signal into a remedy", () => {
    const result = buildBusinessBriefResult({
      ...snapshot,
      previousOrders: 0,
      previousReturns: 0,
      createdOrders: 0,
      locations: [],
    });
    expect(rankResponseSignals(result, "brief")).toEqual([]);
  });
  it.each([null, "run_shell", {}, "inventory; DROP TABLE stores"])(
    "rejects invalid action keys",
    (value) => expect(isResponseSignal(value)).toBe(false),
  );
  it("makes the read-only, bounded approval contract explicit", () => {
    expect(RESPONSE_LIMITS).toContain("20 detail rows");
    expect(RESPONSE_LIMITS).toContain("No business changes");
  });
});
