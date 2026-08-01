import { describe, it, expect, vi, beforeEach } from "vitest";

// The pure question this file exists to answer: given some shops and some
// stock, which ones may a shopper collect this basket from?

const mocks = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  store: { id: "s1", plan: "pro" } as Record<string, unknown>,
  locRows: [] as Record<string, unknown>[],
  levelRows: [] as Record<string, unknown>[],
}));

vi.mock("@/lib/settings/resolve", () => ({
  getStoreSettings: vi.fn(async () => mocks.settings),
}));
vi.mock("@/lib/store/resolve", () => ({
  getCurrentStore: vi.fn(async () => mocks.store),
}));
vi.mock("@/lib/inventory/reservations", () => ({
  releaseHold: vi.fn(async () => true),
}));
vi.mock("@/lib/notifications/record", () => ({ recordEvent: vi.fn() }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (fn: (db: unknown) => unknown) => {
    // pickupLocationsFor runs both selects inside ONE withService callback and
    // returns them as a tuple; the fake db just hands each one back in order.
    let call = 0;
    const rows = () => (call++ === 0 ? mocks.locRows : mocks.levelRows);
    const chain = {
      select: () => chain,
      from: () => chain,
      where: () => Promise.resolve(rows()),
    };
    return fn(chain);
  }),
}));

const {
  pickupLocationsFor,
  pickupEnabled,
  pickupHoldDays,
  hoursUntil,
  PICKUP_WARN_HOURS,
  readyOn,
} = await import("./pickup");

const shop = (id: string, caps: Record<string, boolean>) => ({
  id,
  name: `Shop ${id}`,
  type: "shop",
  address: { line1: "1 High St", city: "Delhi" },
  active: true,
  capabilities: caps,
});

const level = (loc: string, onHand: number, reserved = 0) => ({
  location_id: loc,
  product_id: "p1",
  variant_id: null,
  on_hand: onHand,
  reserved,
});

const basket = [
  { productId: "p1", variantId: null, quantity: 2, needsStock: true },
];

beforeEach(() => {
  mocks.settings = { "fulfilment.offerPickup": true };
  mocks.store = { id: "s1", plan: "pro" };
  mocks.locRows = [shop("a", { pos: true, pickup: true })];
  mocks.levelRows = [level("a", 5)];
});

describe("pickupEnabled", () => {
  it("is off unless the merchant turned it on", async () => {
    mocks.settings = {};
    expect(await pickupEnabled()).toBe(false);
  });
});

describe("pickupHoldDays", () => {
  it("falls back to 5 for a missing or nonsense value", async () => {
    mocks.settings = { "fulfilment.pickupHoldDays": "not a number" };
    expect(await pickupHoldDays()).toBe(5);
  });
});

describe("pickupLocationsFor", () => {
  it("offers a capable shop that has the stock", async () => {
    const out = await pickupLocationsFor("s1", basket);
    expect(out.map((o) => [o.id, o.hasStock])).toEqual([["a", true]]);
  });

  it("offers nothing when pickup is switched off", async () => {
    mocks.settings = {};
    expect(await pickupLocationsFor("s1", basket)).toEqual([]);
  });

  it("skips a shop without the pickup capability", async () => {
    mocks.locRows = [shop("a", { pos: true, pickup: false })];
    expect(await pickupLocationsFor("s1", basket)).toEqual([]);
  });

  it("skips pickup when the shop has no till — someone must hand it over", async () => {
    mocks.locRows = [shop("a", { pos: false, pickup: true })];
    expect(await pickupLocationsFor("s1", basket)).toEqual([]);
  });

  it("skips pickup below the Pro plan", async () => {
    mocks.store = { id: "s1", plan: "basic" };
    expect(await pickupLocationsFor("s1", basket)).toEqual([]);
  });

  it("counts AVAILABLE, not on-hand — someone else's hold is not yours to promise", async () => {
    mocks.levelRows = [level("a", 5, 4)];
    const out = await pickupLocationsFor("s1", basket);
    expect(out[0].hasStock).toBe(false);
  });

  it("still lists a short shop, flagged, rather than hiding it", async () => {
    mocks.locRows = [
      shop("a", { pos: true, pickup: true }),
      shop("b", { pos: true, pickup: true }),
    ];
    mocks.levelRows = [level("a", 5), level("b", 1)];
    const out = await pickupLocationsFor("s1", basket);
    expect(out.map((o) => [o.id, o.hasStock])).toEqual([
      ["a", true],
      ["b", false],
    ]);
  });

  it("does not let an untracked line disqualify a shop with no level row", async () => {
    mocks.levelRows = [];
    const out = await pickupLocationsFor("s1", [
      { productId: "p1", variantId: null, quantity: 2, needsStock: false },
    ]);
    expect(out[0].hasStock).toBe(true);
  });
});

describe("hoursUntil", () => {
  const now = new Date("2026-08-01T12:00:00Z");

  it("rounds up — 90 minutes left is '2 hours', never '1'", () => {
    expect(hoursUntil("2026-08-01T13:30:00Z", now)).toBe(2);
  });

  it("floors at zero rather than counting backwards past the deadline", () => {
    expect(hoursUntil("2026-07-31T12:00:00Z", now)).toBe(0);
  });

  it("survives a nonsense date instead of emitting NaN into an email", () => {
    expect(hoursUntil("not a date", now)).toBe(0);
  });
});

describe("PICKUP_WARN_HOURS", () => {
  const CRON_INTERVAL_HOURS = 24; // expire-pending-payments runs daily

  // The window and the schedule are not in phase, so the notice an order
  // actually gets is (W − I, W]. At W = I that bottoms out at ~nothing: an
  // order expiring just after a run is warned just before it lapses. Twice the
  // interval is what makes the WORST case a full interval of notice.
  it("gives at least one full cron interval of notice, worst case", () => {
    expect(PICKUP_WARN_HOURS - CRON_INTERVAL_HOURS).toBeGreaterThanOrEqual(
      CRON_INTERVAL_HOURS,
    );
  });
});

describe("readyOn", () => {
  const now = new Date("2026-07-29T10:00:00Z"); // a Wednesday

  it("calls out same-day rather than printing today's date", () => {
    const r = readyOn(0, now);
    expect(r.today).toBe(true);
    expect(r.date).toBe("");
    expect(r.long).toBe("Today");
  });

  it("gives a real date, not a countdown the shopper has to work out", () => {
    const r = readyOn(2, now);
    expect(r.today).toBe(false);
    expect(r.date).toBe("Fri, 31 Jul");
    expect(r.long).toBe("Friday, 31 July");
  });

  it("rolls over a month boundary", () => {
    expect(readyOn(3, now).date).toBe("Sat, 1 Aug");
  });
});
