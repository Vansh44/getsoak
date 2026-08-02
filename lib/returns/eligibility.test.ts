import { describe, it, expect } from "vitest";
import { possessionDate, returnEligibility } from "./eligibility";

const ON = { enabled: true, windowDays: 7 };
const NOW = new Date("2026-08-10T12:00:00Z");

/** Delivered `daysAgo` before NOW. */
function delivered(daysAgo: number) {
  return {
    status: "delivered",
    deliveredAt: new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString(),
  };
}

describe("possessionDate — when the clock starts", () => {
  it("prefers delivery", () => {
    expect(
      possessionDate({
        status: "delivered",
        deliveredAt: "2026-08-01T00:00:00Z",
        collectedAt: "2026-08-05T00:00:00Z",
        createdAt: "2026-07-20T00:00:00Z",
      })?.toISOString(),
    ).toBe("2026-08-01T00:00:00.000Z");
  });

  it("falls back to collection for a pickup order", () => {
    expect(
      possessionDate({
        status: "delivered",
        deliveredAt: null,
        collectedAt: "2026-08-05T00:00:00Z",
      })?.toISOString(),
    ).toBe("2026-08-05T00:00:00.000Z");
  });

  it("★ uses created_at for a POS sale — they walked out with it", () => {
    expect(
      possessionDate({
        status: "completed",
        createdAt: "2026-08-05T00:00:00Z",
      })?.toISOString(),
    ).toBe("2026-08-05T00:00:00.000Z");
  });

  it("does NOT use created_at for a shipped order", () => {
    // The whole reason delivered_at exists: a window counted from checkout can
    // expire before a slow parcel arrives.
    expect(
      possessionDate({
        status: "delivered",
        createdAt: "2026-07-01T00:00:00Z",
      }),
    ).toBeNull();
  });

  it("ignores an unparseable timestamp", () => {
    expect(
      possessionDate({ status: "delivered", deliveredAt: "not a date" }),
    ).toBeNull();
  });
});

describe("returnEligibility", () => {
  it("is eligible inside the window", () => {
    const res = returnEligibility(delivered(2), null, ON, NOW);
    expect(res.eligible).toBe(true);
    expect(res.daysLeft).toBe(5);
    expect(res.until).toBe("2026-08-15T12:00:00.000Z");
  });

  it("expires after the window", () => {
    const res = returnEligibility(delivered(9), null, ON, NOW);
    expect(res.eligible).toBe(false);
    expect(res.reason).toBe("window_expired");
    expect(res.daysLeft).toBe(0);
  });

  it("is eligible on the last day", () => {
    expect(returnEligibility(delivered(7), null, ON, NOW).eligible).toBe(true);
  });

  it("refuses everything when returns are off", () => {
    const res = returnEligibility(
      delivered(1),
      null,
      { ...ON, enabled: false },
      NOW,
    );
    expect(res.eligible).toBe(false);
    expect(res.reason).toBe("returns_disabled");
  });

  it("★ final sale beats a still-open window", () => {
    const res = returnEligibility(delivered(1), { returnable: false }, ON, NOW);
    expect(res.eligible).toBe(false);
    expect(res.reason).toBe("final_sale");
  });

  it("★ an undelivered order is NOT_YET_DELIVERED, not expired", () => {
    // Distinct answers on purpose: telling someone their day-old order is too
    // old to return is worse than saying nothing.
    for (const status of ["pending", "processing", "shipped"]) {
      const res = returnEligibility({ status }, null, ON, NOW);
      expect(res.eligible).toBe(false);
      expect(res.reason).toBe("not_yet_delivered");
    }
  });

  it("refuses a cancelled order — there is nothing to send back", () => {
    const res = returnEligibility({ status: "cancelled" }, null, ON, NOW);
    expect(res.reason).toBe("order_not_eligible");
  });

  it("★ a per-product window overrides the store's", () => {
    const order = delivered(20);
    expect(returnEligibility(order, null, ON, NOW).eligible).toBe(false);
    expect(
      returnEligibility(order, { returnWindowDays: 30 }, ON, NOW).eligible,
    ).toBe(true);
  });

  it("★ a per-product window of ZERO means same-day, not 'use the default'", () => {
    // The reason the override is a null check and not `||`.
    const sameDay = returnEligibility(
      delivered(1),
      { returnWindowDays: 0 },
      ON,
      NOW,
    );
    expect(sameDay.eligible).toBe(false);
    expect(sameDay.reason).toBe("window_expired");

    // …and it still works on the day itself.
    expect(
      returnEligibility(delivered(0), { returnWindowDays: 0 }, ON, NOW)
        .eligible,
    ).toBe(true);
  });

  it("★ FAILS OPEN when a delivered order has no timestamp", () => {
    // A legacy row the backfill couldn't date. Refusing a genuine return
    // because OUR data is incomplete is the store's problem, not the
    // customer's.
    const res = returnEligibility({ status: "delivered" }, null, ON, NOW);
    expect(res.eligible).toBe(true);
    expect(res.until).toBeNull();
    expect(res.daysLeft).toBeNull();
  });

  it("a POS sale is returnable from the moment it's rung", () => {
    const res = returnEligibility(
      {
        status: "completed",
        createdAt: new Date(NOW.getTime() - 86_400_000).toISOString(),
      },
      null,
      ON,
      NOW,
    );
    expect(res.eligible).toBe(true);
    expect(res.daysLeft).toBe(6);
  });

  it("a returnable:true product doesn't override anything", () => {
    expect(
      returnEligibility(delivered(2), { returnable: true }, ON, NOW).eligible,
    ).toBe(true);
  });
});
