// Which rail can carry a recurring charge — and, above all, when none can.
import { describe, it, expect } from "vitest";
import {
  AFA_EXEMPT_PAISE,
  autopayRailFor,
  normalizeMandateMethod,
} from "./mandate-types";
import { AFA_EXEMPT_LIMIT_PAISE } from "./cycle";

describe("AFA_EXEMPT_PAISE", () => {
  it("★★ agrees with the collection path's own copy", () => {
    // The constant is duplicated so this module can stay import-free and be
    // read by a client component. Duplicated, never allowed to drift.
    expect(AFA_EXEMPT_PAISE).toBe(AFA_EXEMPT_LIMIT_PAISE);
  });

  it("is ₹15,000 — the same for cards and UPI", () => {
    // The premise worth pinning: a card is NOT more permissive than UPI. Both
    // require the customer to authenticate every debit above this.
    expect(AFA_EXEMPT_PAISE).toBe(15_000 * 100);
  });
});

describe("autopayRailFor", () => {
  it("routes an ordinary monthly charge to UPI Autopay", () => {
    expect(autopayRailFor(2_400_00)).toBe("upi"); // Pro monthly
    expect(autopayRailFor(1_500_00)).toBe("upi"); // Basic monthly
  });

  it("★ the limit itself is INSIDE — it is a ceiling, not a barrier", () => {
    // Basic yearly is exactly ₹15,000 today. An off-by-one here would drop a
    // whole plan off autopay for no reason.
    expect(autopayRailFor(AFA_EXEMPT_PAISE)).toBe("upi");
    expect(autopayRailFor(AFA_EXEMPT_PAISE + 1)).toBeNull();
  });

  it("★★ refuses a charge no rail can carry automatically", () => {
    // Pro yearly at ₹24,000, and Basic yearly once GST is switched on. Null
    // means "request no mandate": a ceiling that can never be exercised is
    // authority we ask for and cannot use.
    expect(autopayRailFor(24_000_00)).toBeNull();
    expect(autopayRailFor(17_700_00)).toBeNull();
  });

  it("★ refuses nonsense rather than defaulting to a rail", () => {
    // A mandate is standing permission to debit. Nothing unparseable should
    // ever resolve to "yes, register one".
    expect(autopayRailFor(0)).toBeNull();
    expect(autopayRailFor(-1)).toBeNull();
    expect(autopayRailFor(Number.NaN)).toBeNull();
    expect(autopayRailFor(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("normalizeMandateMethod", () => {
  it("still coerces an unrecognised value to card", () => {
    expect(normalizeMandateMethod("upi")).toBe("upi");
    expect(normalizeMandateMethod("netbanking")).toBe("card");
    expect(normalizeMandateMethod(undefined)).toBe("card");
  });
});
