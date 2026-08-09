import { describe, expect, it } from "vitest";
import {
  MAX_EXTRA_LOCATIONS,
  canAddLocation,
  describeLocationChange,
  extraLocationPaise,
  locationAllowance,
  releasableLocations,
  requiredBilledLocations,
  subscriptionTotalPaise,
  validateBilledLocations,
} from "./location-billing";

// Pro includes 2; basic and free include none.
const PRO = "pro";
const BASIC = "basic";
const FREE = "free";

describe("extraLocationPaise", () => {
  it("prices monthly and yearly, yearly at 10x", () => {
    expect(extraLocationPaise("monthly")).toBe(100_000); // ₹1,000
    expect(extraLocationPaise("yearly")).toBe(1_000_000); // ₹10,000
    // The "two months free" relationship PLAN_META promises. If this breaks,
    // the add-on is quietly on different terms from the plan it rides on.
    expect(extraLocationPaise("yearly")).toBe(
      extraLocationPaise("monthly") * 10,
    );
  });
});

// ★ THE OPERATOR SETS THIS PRICE (plans_05). The module stays pure by taking it
// as a parameter; the constant is only the value that applies until someone has
// set one.
describe("extraLocationPaise — operator override", () => {
  const OVERRIDE = { monthlyInr: 2500, yearlyInr: 25000 };

  it("uses the operator's price when given one", () => {
    expect(extraLocationPaise("monthly", OVERRIDE)).toBe(250_000);
    expect(extraLocationPaise("yearly", OVERRIDE)).toBe(2_500_000);
  });

  it("falls back to the constant when none is given", () => {
    expect(extraLocationPaise("monthly")).toBe(100_000);
  });

  // A junk override must not become NaN paise on an invoice, or a free
  // location. Both are worse than briefly charging the old price.
  it("falls back rather than charging NaN or nothing", () => {
    expect(
      extraLocationPaise("monthly", {
        monthlyInr: NaN,
        yearlyInr: 0,
      } as never),
    ).toBe(100_000);
    expect(
      extraLocationPaise("monthly", { monthlyInr: -5, yearlyInr: 0 }),
    ).toBe(100_000);
  });

  it("carries into the subscription total and the copy", () => {
    expect(subscriptionTotalPaise(500_000, 2, "monthly", OVERRIDE)).toBe(
      1_000_000,
    );
    // The sentence a merchant reads before confirming is derived from the SAME
    // paise figure the charge uses, so the two can never disagree.
    expect(describeLocationChange(0, 1, "monthly", OVERRIDE)).toMatch(
      /₹2,500\/month/,
    );
  });
});

describe("subscriptionTotalPaise", () => {
  it("adds the locations to the tier's own price", () => {
    // Pro monthly ₹5,000 + 2 locations = ₹7,000
    expect(subscriptionTotalPaise(500_000, 2, "monthly")).toBe(700_000);
    expect(subscriptionTotalPaise(5_000_000, 2, "yearly")).toBe(7_000_000);
  });

  it("is the plan price alone at zero", () => {
    expect(subscriptionTotalPaise(500_000, 0, "monthly")).toBe(500_000);
  });

  it("treats junk as zero rather than producing NaN", () => {
    // This number becomes a charge against a live mandate. NaN reaching
    // Razorpay is a 400 at best; silently charging something is worse.
    expect(subscriptionTotalPaise(500_000, -3, "monthly")).toBe(500_000);
    expect(subscriptionTotalPaise(500_000, 1.7, "monthly")).toBe(600_000);
    expect(
      subscriptionTotalPaise(500_000, NaN as unknown as number, "monthly"),
    ).toBe(500_000);
  });
});

describe("locationAllowance", () => {
  it("is included + billed on Pro", () => {
    expect(locationAllowance(PRO, 0)).toBe(2);
    expect(locationAllowance(PRO, 3)).toBe(5);
  });

  // ★ Soft-on-downgrade (invariant 1). A lapsed Pro store keeps every location
  // it has — nothing is deleted — but may not create more, and paying for
  // extras must not be a back door to POS on a plan that doesn't include it.
  it("is zero without POS, even when locations are billed", () => {
    expect(locationAllowance(BASIC, 5)).toBe(0);
    expect(locationAllowance(FREE, 5)).toBe(0);
  });

  it("treats billed as additive, never as a total", () => {
    // If Pro's included count ever rises to 3, someone paying for 1 gains
    // headroom rather than being charged for what is now free.
    expect(locationAllowance(PRO, 1)).toBe(3);
  });
});

describe("canAddLocation", () => {
  it("allows up to the allowance and refuses past it", () => {
    expect(canAddLocation(PRO, 0, 1)).toBe(true);
    expect(canAddLocation(PRO, 0, 2)).toBe(false);
    expect(canAddLocation(PRO, 1, 2)).toBe(true);
    expect(canAddLocation(PRO, 1, 3)).toBe(false);
  });

  it("refuses on a plan without POS regardless of what was billed", () => {
    expect(canAddLocation(BASIC, 4, 0)).toBe(false);
  });
});

describe("requiredBilledLocations", () => {
  it("is zero inside the included allowance", () => {
    expect(requiredBilledLocations(PRO, 0)).toBe(0);
    expect(requiredBilledLocations(PRO, 2)).toBe(0);
  });

  it("counts only what spills past it", () => {
    expect(requiredBilledLocations(PRO, 3)).toBe(1);
    expect(requiredBilledLocations(PRO, 7)).toBe(5);
  });

  it("is zero on a plan with no POS — there is nothing to bill for", () => {
    expect(requiredBilledLocations(BASIC, 9)).toBe(0);
  });
});

describe("releasableLocations", () => {
  it("reports paid slots nobody is using", () => {
    expect(releasableLocations(PRO, 3, 3)).toBe(2); // needs 1, pays 3
    expect(releasableLocations(PRO, 1, 3)).toBe(0); // needs 1, pays 1
  });

  it("never goes negative when under-billed", () => {
    // Can happen after an operator grants Pro to a store that already had
    // locations. It is a state to report, not to compute a refund from.
    expect(releasableLocations(PRO, 0, 5)).toBe(0);
  });
});

describe("validateBilledLocations", () => {
  it("accepts a count that covers what is in use", () => {
    expect(validateBilledLocations(PRO, 2, 4)).toEqual({ ok: true, count: 2 });
    expect(validateBilledLocations(PRO, 0, 2)).toEqual({ ok: true, count: 0 });
  });

  it("refuses non-integers and negatives", () => {
    expect(validateBilledLocations(PRO, 1.5, 0).ok).toBe(false);
    expect(validateBilledLocations(PRO, -1, 0).ok).toBe(false);
  });

  it("refuses on a plan without POS, pointing at the upgrade", () => {
    const r = validateBilledLocations(BASIC, 1, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/Pro/);
  });

  // ★ The count becomes an AMOUNT charged to a live mandate, so it is bounded.
  // Without this, one bad input mints a plan for lakhs a month.
  it("refuses an absurd count", () => {
    expect(validateBilledLocations(PRO, MAX_EXTRA_LOCATIONS, 0).ok).toBe(true);
    expect(validateBilledLocations(PRO, MAX_EXTRA_LOCATIONS + 1, 0).ok).toBe(
      false,
    );
  });

  // ★ REFUSED, NOT CLAMPED. Silently raising the number would charge for what
  // they didn't ask for; silently lowering it would leave them paying for a
  // release they thought went through — and they'd find out on their card.
  it("refuses dropping below the locations actually in use", () => {
    const r = validateBilledLocations(PRO, 0, 3); // needs 1
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/using 1 extra location/i);

    const many = validateBilledLocations(PRO, 1, 6); // needs 4
    expect(many.ok).toBe(false);
    if (!many.ok) expect(many.reason).toMatch(/using 4 extra locations/i);
  });
});

describe("describeLocationChange", () => {
  it("warns that adding charges now", () => {
    const s = describeLocationChange(0, 1, "monthly");
    expect(s).toMatch(/Adding 1 location/);
    expect(s).toMatch(/₹1,000\/month/);
    expect(s).toMatch(/charged the difference/i);
  });

  it("says releasing charges nothing today", () => {
    const s = describeLocationChange(2, 1, "monthly");
    expect(s).toMatch(/Releasing 1 location/);
    expect(s).toMatch(/end of this billing cycle/i);
    expect(s).toMatch(/Nothing is charged today/i);
  });

  it("pluralises and prices per period", () => {
    expect(describeLocationChange(0, 2, "yearly")).toMatch(
      /Adding 2 locations at ₹10,000\/year/,
    );
  });
});
