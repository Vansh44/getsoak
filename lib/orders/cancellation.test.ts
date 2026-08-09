import { describe, expect, it } from "vitest";
import {
  CANCEL_REASONS,
  canCustomerCancel,
  cancelReasonLabel,
  describeWindow,
  isCancelReason,
  isFulfilled,
  isRefundDestination,
  normalizeApproval,
  normalizeWindow,
  refundDestinationsFor,
  rulesFromSettings,
  windowHours,
  type CancellationRules,
} from "./cancellation";

const NOW = new Date("2026-08-09T12:00:00Z");
const hoursAgo = (h: number) =>
  new Date(NOW.getTime() - h * 3_600_000).toISOString();

const rules = (over: Partial<CancellationRules> = {}): CancellationRules => ({
  allowed: true,
  window: "until_fulfilled",
  customHours: 24,
  approval: "require_approval",
  ...over,
});

const order = (over: Record<string, unknown> = {}) => ({
  status: "pending",
  createdAt: hoursAgo(1),
  ...over,
});

describe("normalizeWindow", () => {
  it("reads the five windows", () => {
    for (const w of [
      "none",
      "until_fulfilled",
      "1h",
      "24h",
      "custom",
    ] as const) {
      expect(normalizeWindow(w)).toBe(w);
    }
  });

  it("falls back to until_fulfilled on anything unknown", () => {
    for (const v of [undefined, null, "", "2h", 5, {}]) {
      expect(normalizeWindow(v)).toBe("until_fulfilled");
    }
  });
});

describe("normalizeApproval", () => {
  // ★ The fallback is the SAFE half. An automatic approval moves money with
  // nobody looking, so it must never be what a typo resolves to.
  it("only 'auto' means auto; everything else requires approval", () => {
    expect(normalizeApproval("auto")).toBe("auto");
    for (const v of [undefined, null, "", "AUTO", "yes", 1]) {
      expect(normalizeApproval(v)).toBe("require_approval");
    }
  });
});

describe("canCustomerCancel — gates", () => {
  it("allows a fresh pending order", () => {
    expect(canCustomerCancel(order(), rules(), NOW)).toEqual({ ok: true });
  });

  it("refuses when the merchant hasn't switched it on", () => {
    const r = canCustomerCancel(order(), rules({ allowed: false }), NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("disabled");
  });

  it("refuses when the window is 'No cancellations'", () => {
    const r = canCustomerCancel(order(), rules({ window: "none" }), NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("disabled");
  });

  it("refuses an already-cancelled order", () => {
    const r = canCustomerCancel(order({ status: "cancelled" }), rules(), NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("already_cancelled");
  });

  // ★ ONE ACTIVE REQUEST PER ORDER. Two would give the merchant two decisions
  // to make about one order.
  it("refuses a second request while one is pending", () => {
    const r = canCustomerCancel(
      order({ cancellationStatus: "requested" }),
      rules(),
      NOW,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("already_requested");
  });

  // ★ A DECLINE MUST STICK. Re-asking after a decline would make "declined"
  // mean nothing.
  it("refuses re-asking after a decline", () => {
    const r = canCustomerCancel(
      order({ cancellationStatus: "declined" }),
      rules(),
      NOW,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("already_requested");
  });

  it("refuses once fulfilled, and points at returns", () => {
    for (const status of ["shipped", "delivered", "completed"]) {
      const r = canCustomerCancel(order({ status }), rules(), NOW);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe("fulfilled");
        expect(r.reason).toMatch(/return it instead/i);
      }
    }
  });

  it("refuses a collected pickup", () => {
    const r = canCustomerCancel(
      order({ collectedAt: hoursAgo(1) }),
      rules(),
      NOW,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("fulfilled");
  });
});

describe("canCustomerCancel — the window", () => {
  // ★ FIRST-CLASS, not a very long duration. An order placed a year ago is
  // still cancellable if nobody has packed it.
  it("★ 'until fulfilled' ignores elapsed time entirely", () => {
    const r = canCustomerCancel(
      order({ createdAt: hoursAgo(24 * 365) }),
      rules({ window: "until_fulfilled" }),
      NOW,
    );
    expect(r).toEqual({ ok: true });
  });

  it("1h allows inside and refuses outside", () => {
    expect(
      canCustomerCancel(
        order({ createdAt: hoursAgo(0.5) }),
        rules({ window: "1h" }),
        NOW,
      ).ok,
    ).toBe(true);
    const late = canCustomerCancel(
      order({ createdAt: hoursAgo(2) }),
      rules({ window: "1h" }),
      NOW,
    );
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.code).toBe("window_expired");
  });

  it("24h allows inside and refuses outside", () => {
    expect(
      canCustomerCancel(
        order({ createdAt: hoursAgo(23) }),
        rules({ window: "24h" }),
        NOW,
      ).ok,
    ).toBe(true);
    expect(
      canCustomerCancel(
        order({ createdAt: hoursAgo(25) }),
        rules({ window: "24h" }),
        NOW,
      ).ok,
    ).toBe(false);
  });

  it("custom uses the merchant's hours", () => {
    const custom = rules({ window: "custom", customHours: 6 });
    expect(
      canCustomerCancel(order({ createdAt: hoursAgo(5) }), custom, NOW).ok,
    ).toBe(true);
    expect(
      canCustomerCancel(order({ createdAt: hoursAgo(7) }), custom, NOW).ok,
    ).toBe(false);
  });

  // ★ FAILS OPEN on our own data problem, matching lib/returns/eligibility.ts:
  // refusing a genuine cancellation because a legacy row has no timestamp makes
  // the customer pay for it.
  it("★ a dateless order is not an expired one", () => {
    expect(
      canCustomerCancel(
        order({ createdAt: null }),
        rules({ window: "1h" }),
        NOW,
      ),
    ).toEqual({ ok: true });
  });
});

describe("windowHours", () => {
  it("maps the fixed windows", () => {
    expect(windowHours(rules({ window: "1h" }))).toBe(1);
    expect(windowHours(rules({ window: "24h" }))).toBe(24);
  });

  // A custom window of 0 would refuse everything while the setting reads as
  // enabled — the least diagnosable state to leave a merchant in.
  it("falls back to a day on a junk custom value", () => {
    for (const h of [0, -3, NaN]) {
      expect(windowHours(rules({ window: "custom", customHours: h }))).toBe(24);
    }
    expect(windowHours(rules({ window: "custom", customHours: 6 }))).toBe(6);
  });
});

describe("describeWindow", () => {
  it("reads as prose for customer-facing copy", () => {
    expect(describeWindow(rules({ window: "until_fulfilled" }))).toMatch(
      /until the order is fulfilled/,
    );
    expect(describeWindow(rules({ window: "1h" }))).toBe("1 hour");
    expect(describeWindow(rules({ window: "24h" }))).toBe("24 hours");
    expect(describeWindow(rules({ window: "custom", customHours: 6 }))).toBe(
      "6 hours",
    );
    expect(describeWindow(rules({ window: "custom", customHours: 1 }))).toBe(
      "1 hour",
    );
  });
});

describe("isFulfilled", () => {
  it("covers the statuses where the goods have gone", () => {
    expect(isFulfilled("shipped")).toBe(true);
    expect(isFulfilled("delivered")).toBe(true);
    expect(isFulfilled("completed")).toBe(true);
    expect(isFulfilled("pending")).toBe(false);
    expect(isFulfilled("processing")).toBe(false);
    expect(isFulfilled(null)).toBe(false);
  });
});

describe("cancel reasons", () => {
  it("is a fixed vocabulary with stable codes", () => {
    expect(CANCEL_REASONS.length).toBeGreaterThan(3);
    expect(isCancelReason("fraudulent")).toBe(true);
    expect(isCancelReason("made_up")).toBe(false);
    expect(cancelReasonLabel("staff_error")).toBe("Staff error");
  });

  // An unknown code renders rather than blanking a dashboard row.
  it("labels an unknown code as Other", () => {
    expect(cancelReasonLabel("gone")).toBe("Other");
    expect(cancelReasonLabel(null)).toBe("Other");
  });
});

describe("refundDestinationsFor", () => {
  it("offers the gateway only when money actually went through it", () => {
    expect(
      refundDestinationsFor({
        paymentMethod: "razorpay",
        paymentStatus: "paid",
        customerId: "c1",
      }),
    ).toEqual(["original", "store_credit", "later"]);
  });

  it("never offers the gateway on an unpaid or COD order", () => {
    expect(
      refundDestinationsFor({
        paymentMethod: "cash_on_delivery",
        paymentStatus: "paid",
        customerId: "c1",
      }),
    ).toEqual(["store_credit", "later"]);
    expect(
      refundDestinationsFor({
        paymentMethod: "razorpay",
        paymentStatus: "pending",
        customerId: "c1",
      }),
    ).toEqual(["later"]);
  });

  // A walk-in POS sale has no account to credit.
  it("needs a customer to offer store credit", () => {
    expect(
      refundDestinationsFor({
        paymentMethod: "razorpay",
        paymentStatus: "paid",
        customerId: null,
      }),
    ).toEqual(["original", "later"]);
  });

  // ★ "Later" is always available: it records an obligation rather than moving
  // money, and an unpaid order still needs a way to say "nothing owed".
  it("★ always offers 'later'", () => {
    expect(refundDestinationsFor({})).toEqual(["later"]);
  });

  it("validates the destination ids", () => {
    expect(isRefundDestination("original")).toBe(true);
    expect(isRefundDestination("store_credit")).toBe(true);
    expect(isRefundDestination("later")).toBe(true);
    expect(isRefundDestination("cash")).toBe(false);
  });
});

describe("rulesFromSettings", () => {
  it("folds the registry values into one shape", () => {
    expect(
      rulesFromSettings({
        "orders.allowCustomerCancellation": true,
        "orders.cancellationWindow": "custom",
        "orders.cancellationWindowHours": 6,
        "orders.cancellationApproval": "auto",
      }),
    ).toEqual({
      allowed: true,
      window: "custom",
      customHours: 6,
      approval: "auto",
    });
  });

  // An empty settings object is a valid state (a store that has never touched
  // these), and it must resolve to the SAFE defaults: off, and approval needed.
  it("★ an empty object is off, and requires approval", () => {
    expect(rulesFromSettings({})).toEqual({
      allowed: false,
      window: "until_fulfilled",
      customHours: 24,
      approval: "require_approval",
    });
  });
});
