import { describe, expect, it } from "vitest";
import {
  AFA_EXEMPT_LIMIT_PAISE,
  COLLECTION_LEAD_DAYS,
  GRACE_HOURS,
  PERIOD_DAYS,
  collectionRoute,
  collectionStartsAt,
  cycleFrom,
  graceEndsAt,
  isCollectionDue,
  isGraceExpired,
  mandateSizePaise,
  nextCycle,
} from "./cycle";

const utc = (s: string) => new Date(s);
const iso = (d: Date) => d.toISOString();

describe("PERIOD_DAYS", () => {
  it("is 30 and 365 — durations, not calendar units", () => {
    expect(PERIOD_DAYS.monthly).toBe(30);
    expect(PERIOD_DAYS.yearly).toBe(365);
  });
});

describe("the cycle tiles the timeline", () => {
  it("makes each cycle's end the next one's start, exactly", () => {
    const first = cycleFrom(utc("2026-08-01T00:00:00.000Z"), "monthly", 1);
    const second = nextCycle(first, "monthly");
    expect(iso(second.start)).toBe(iso(first.end));
    expect(second.seq).toBe(2);
  });

  it("drifts the billing date, which is the accepted consequence", () => {
    // 1 Aug → 31 Aug → 30 Sep. "We bill on the 1st" is never true.
    let c = cycleFrom(utc("2026-08-01T00:00:00.000Z"), "monthly", 1);
    expect(iso(c.end)).toBe("2026-08-31T00:00:00.000Z");
    c = nextCycle(c, "monthly");
    expect(iso(c.end)).toBe("2026-09-30T00:00:00.000Z");
  });

  it("preserves the time of day across cycles", () => {
    const c = cycleFrom(utc("2026-08-01T10:30:00.000Z"), "monthly", 1);
    expect(iso(c.end)).toBe("2026-08-31T10:30:00.000Z");
  });
});

// The spec's §56 edge-case list, asserted in the INVERTED direction: under a
// true duration model these dates must get NO special handling at all.
describe("30 days means 30 days — no calendar special-casing", () => {
  it.each([
    [
      "2027-01-31T00:00:00.000Z",
      "2027-03-02T00:00:00.000Z",
      "31 Jan, non-leap",
    ],
    ["2028-01-31T00:00:00.000Z", "2028-03-01T00:00:00.000Z", "31 Jan, leap"],
    ["2027-02-01T00:00:00.000Z", "2027-03-03T00:00:00.000Z", "Feb, non-leap"],
    ["2028-02-01T00:00:00.000Z", "2028-03-02T00:00:00.000Z", "Feb, leap"],
    ["2027-01-28T00:00:00.000Z", "2027-02-27T00:00:00.000Z", "the 28th"],
    ["2027-01-29T00:00:00.000Z", "2027-02-28T00:00:00.000Z", "the 29th"],
    ["2027-01-30T00:00:00.000Z", "2027-03-01T00:00:00.000Z", "the 30th"],
    ["2027-12-15T00:00:00.000Z", "2028-01-14T00:00:00.000Z", "year boundary"],
  ])("%s + 30d = %s (%s)", (start, end) => {
    expect(iso(cycleFrom(utc(start), "monthly", 1).end)).toBe(end);
  });

  it("never clamps to a day-of-month", () => {
    // A calendar-month implementation would return 28 Feb here. We must not.
    expect(
      iso(cycleFrom(utc("2027-01-31T00:00:00.000Z"), "monthly", 1).end),
    ).not.toBe("2027-02-28T00:00:00.000Z");
  });
});

describe("yearly is 365 days, not an anniversary", () => {
  it("lands on the anniversary in a non-leap year", () => {
    expect(
      iso(cycleFrom(utc("2027-01-01T00:00:00.000Z"), "yearly", 1).end),
    ).toBe("2028-01-01T00:00:00.000Z");
  });

  it("★ drifts a day when the cycle spans a leap year", () => {
    // 2028 has 366 days, so 365 days from 1 Jan 2028 is 31 Dec 2028 — one day
    // SHY of the anniversary. Intended: this is the 30-day rule applied
    // consistently. Do not "fix" it into date arithmetic.
    expect(
      iso(cycleFrom(utc("2028-01-01T00:00:00.000Z"), "yearly", 1).end),
    ).toBe("2028-12-31T00:00:00.000Z");
  });
});

describe("collection timing (the X+3 rule)", () => {
  it("starts collection COLLECTION_LEAD_DAYS before the cycle", () => {
    expect(COLLECTION_LEAD_DAYS).toBe(4);
    expect(iso(collectionStartsAt(utc("2026-09-01T00:00:00.000Z")))).toBe(
      "2026-08-28T00:00:00.000Z",
    );
  });

  it("is due inclusively, so a worker on the boundary acts", () => {
    const cycleStart = utc("2026-09-01T00:00:00.000Z");
    expect(isCollectionDue(cycleStart, utc("2026-08-27T23:59:59.999Z"))).toBe(
      false,
    );
    expect(isCollectionDue(cycleStart, utc("2026-08-28T00:00:00.000Z"))).toBe(
      true,
    );
  });

  it("leaves the whole X+3 window before the cycle starts", () => {
    const cycleStart = utc("2026-09-01T00:00:00.000Z");
    const gap = cycleStart.getTime() - collectionStartsAt(cycleStart).getTime();
    expect(gap / (24 * 60 * 60 * 1000)).toBeGreaterThanOrEqual(3);
  });
});

describe("the grace window", () => {
  it("is 48 hours from the established failure", () => {
    expect(GRACE_HOURS).toBe(48);
    expect(iso(graceEndsAt(utc("2026-08-01T10:00:00.000Z")))).toBe(
      "2026-08-03T10:00:00.000Z",
    );
  });

  it("★ is not expired AT the boundary — the merchant keeps the full 48h", () => {
    const ends = utc("2026-08-03T10:00:00.000Z");
    expect(isGraceExpired(ends, utc("2026-08-03T09:59:59.999Z"))).toBe(false);
    expect(isGraceExpired(ends, ends)).toBe(false);
    expect(isGraceExpired(ends, utc("2026-08-03T10:00:00.001Z"))).toBe(true);
  });
});

describe("collectionRoute — both ceilings, always", () => {
  const base = { mandateStatus: "active" as const, mandateMaxPaise: 27_000_00 };

  it("auto-collects within the mandate and the AFA limit", () => {
    expect(collectionRoute({ ...base, totalPaise: 1_770_00 })).toEqual({
      auto: true,
    });
  });

  it("treats the AFA limit as inclusive", () => {
    expect(
      collectionRoute({ ...base, totalPaise: AFA_EXEMPT_LIMIT_PAISE }),
    ).toEqual({ auto: true });
    expect(
      collectionRoute({ ...base, totalPaise: AFA_EXEMPT_LIMIT_PAISE + 1 }),
    ).toEqual({ auto: false, reason: "over_afa_limit" });
  });

  it("★ refuses over the AFA limit even when the mandate allows it", () => {
    // Basic yearly + GST = ₹17,700 against a ₹27,000 mandate: authorised, but
    // NOT automatic. A big mandate does not make a big debit silent.
    expect(collectionRoute({ ...base, totalPaise: 17_700_00 })).toEqual({
      auto: false,
      reason: "over_afa_limit",
    });
  });

  it("refuses over the mandate ceiling", () => {
    expect(
      collectionRoute({
        ...base,
        mandateMaxPaise: 3_000_00,
        totalPaise: 5_900_00,
      }),
    ).toEqual({ auto: false, reason: "over_mandate" });
  });

  it("★ fails closed on an unrecorded mandate maximum", () => {
    expect(
      collectionRoute({ ...base, mandateMaxPaise: null, totalPaise: 100 }),
    ).toEqual({ auto: false, reason: "over_mandate" });
  });

  it.each(["pending", "unknown", "revoked", "expired", "failed"] as const)(
    "★ never auto-collects on a %s mandate",
    (mandateStatus) => {
      expect(
        collectionRoute({
          mandateStatus,
          mandateMaxPaise: 27_000_00,
          totalPaise: 100,
        }),
      ).toEqual({ auto: false, reason: "no_mandate" });
    },
  );

  it("refuses when there is no mandate at all", () => {
    expect(
      collectionRoute({
        mandateStatus: null,
        mandateMaxPaise: null,
        totalPaise: 100,
      }),
    ).toEqual({ auto: false, reason: "no_mandate" });
  });
});

describe("mandateSizePaise", () => {
  it.each([
    ["basic monthly", 1_500_00, 0, 3_000_00],
    ["basic yearly", 15_000_00, 0, 27_000_00],
    ["pro monthly", 5_000_00, 0, 9_000_00],
    ["pro yearly", 50_000_00, 0, 89_000_00],
    ["pro monthly + 2 locations", 5_000_00, 2_000_00, 13_000_00],
  ])("sizes %s correctly", (_label, planPaise, locationsPaise, expected) => {
    expect(mandateSizePaise({ planPaise, locationsPaise })).toBe(expected);
  });

  it("★ provisions for tax ONLY under exclusive pricing", () => {
    // Exclusive: ₹15,000 → ₹17,700 when GST is switched on, so the ceiling
    // must already cover it. Inclusive: the charge never moves, so provisioning
    // would quote a needlessly alarming number on the authorisation screen.
    const excl = mandateSizePaise({ planPaise: 15_000_00 });
    const incl = mandateSizePaise({ planPaise: 15_000_00, taxInclusive: true });
    expect(excl).toBe(27_000_00);
    expect(incl).toBe(23_000_00); // 15,000 × 1.5, rounded up to the nearest ₹1,000
    expect(incl).toBeLessThan(excl);
  });

  it("★ an inclusive mandate still covers the renewal it has to pay", () => {
    for (const plan of [1_500_00, 5_000_00, 15_000_00, 50_000_00]) {
      expect(
        mandateSizePaise({ planPaise: plan, taxInclusive: true }),
      ).toBeGreaterThanOrEqual(plan);
    }
  });

  it("★ always provisions for tax, so a later GST switch cannot refuse a renewal", () => {
    // Basic yearly is ₹15,000 today and ₹17,700 once GST is on. A mandate
    // sized on the bare price would be refused at that renewal.
    expect(mandateSizePaise({ planPaise: 15_000_00 })).toBeGreaterThan(
      17_700_00,
    );
  });

  it("never sizes below the renewal it has to cover", () => {
    for (const plan of [1_00, 1_500_00, 15_000_00, 50_000_00, 1_50_000_00]) {
      expect(mandateSizePaise({ planPaise: plan })).toBeGreaterThanOrEqual(
        plan,
      );
    }
  });

  it("treats a missing location cost as zero rather than NaN", () => {
    expect(mandateSizePaise({ planPaise: 1_500_00 })).toBe(3_000_00);
  });

  it("ignores negative inputs rather than shrinking the ceiling", () => {
    expect(
      mandateSizePaise({ planPaise: 1_500_00, locationsPaise: -9_999_00 }),
    ).toBe(3_000_00);
  });

  it("returns whole paise", () => {
    const n = mandateSizePaise({ planPaise: 1_234_57, locationsPaise: 7_77 });
    expect(Number.isInteger(n)).toBe(true);
  });
});
