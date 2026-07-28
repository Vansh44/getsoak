import { describe, it, expect } from "vitest";
import {
  DEFAULT_STRATEGY_ID,
  canServe,
  eligible,
  getStrategy,
  pickFulfilmentLocation,
  type FulfilmentCandidate,
  type FulfilmentContext,
} from "./strategies";

const loc = (
  id: string,
  stock: Record<string, number>,
  over: Partial<FulfilmentCandidate> = {},
): FulfilmentCandidate => ({
  id,
  name: id,
  active: true,
  fulfilsOnline: true,
  stock: new Map(Object.entries(stock)),
  ...over,
});

const ctx = (over: Partial<FulfilmentContext> = {}): FulfilmentContext => ({
  candidates: [],
  lines: [{ key: "p1:", quantity: 2, needsStock: true }],
  priority: [],
  skipInactive: true,
  ...over,
});

describe("eligible", () => {
  it("drops locations that don't fulfil online", () => {
    const c = ctx({
      candidates: [
        loc("delhi", { "p1:": 5 }),
        loc("mumbai", { "p1:": 99 }, { fulfilsOnline: false }),
      ],
    });
    expect(eligible(c).map((x) => x.id)).toEqual(["delhi"]);
  });

  // A closed shop cannot pick and pack.
  it("drops inactive locations when skipInactive", () => {
    const c = ctx({
      candidates: [loc("delhi", { "p1:": 5 }, { active: false })],
    });
    expect(eligible(c)).toEqual([]);
    expect(eligible({ ...c, skipInactive: false })).toHaveLength(1);
  });
});

describe("canServe", () => {
  it("needs enough of every line", () => {
    const lines = [
      { key: "p1:", quantity: 2, needsStock: true },
      { key: "p2:v1", quantity: 1, needsStock: true },
    ];
    expect(canServe(loc("a", { "p1:": 2, "p2:v1": 1 }), lines)).toBe(true);
    expect(canServe(loc("a", { "p1:": 2 }), lines)).toBe(false);
  });

  // Untracked and backorderable SKUs are infinite as far as routing goes.
  it("ignores lines that don't need stock", () => {
    const lines = [{ key: "svc:", quantity: 99, needsStock: false }];
    expect(canServe(loc("a", {}), lines)).toBe(true);
  });

  it("treats a missing SKU as zero", () => {
    expect(
      canServe(loc("a", {}), [{ key: "p1:", quantity: 1, needsStock: true }]),
    ).toBe(false);
  });
});

describe("priority strategy", () => {
  it("follows the merchant's order", () => {
    const c = ctx({
      candidates: [loc("delhi", { "p1:": 5 }), loc("warehouse", { "p1:": 5 })],
      priority: ["warehouse", "delhi"],
    });
    expect(pickFulfilmentLocation(c)).toBe("warehouse");
  });

  // THE case the phase exists for: the first choice is empty, so the order goes
  // to the next one instead of failing while stock sits in another shop.
  it("falls through to the next location when the first is short", () => {
    const c = ctx({
      candidates: [loc("delhi", { "p1:": 0 }), loc("warehouse", { "p1:": 10 })],
      priority: ["delhi", "warehouse"],
    });
    expect(pickFulfilmentLocation(c)).toBe("warehouse");
  });

  it("never picks a location that doesn't fulfil online, however much it holds", () => {
    const c = ctx({
      candidates: [
        loc("delhi", { "p1:": 0 }),
        loc("mumbai", { "p1:": 99 }, { fulfilsOnline: false }),
      ],
      priority: ["delhi", "mumbai"],
    });
    expect(pickFulfilmentLocation(c)).toBeNull();
  });

  // A location added after the ordering was saved must still be usable.
  it("appends eligible locations missing from the priority list", () => {
    const c = ctx({
      candidates: [loc("delhi", { "p1:": 0 }), loc("new-shop", { "p1:": 5 })],
      priority: ["delhi"],
    });
    expect(pickFulfilmentLocation(c)).toBe("new-shop");
  });

  it("ignores priority entries for locations that no longer exist", () => {
    const c = ctx({
      candidates: [loc("delhi", { "p1:": 5 })],
      priority: ["deleted-shop", "delhi"],
    });
    expect(pickFulfilmentLocation(c)).toBe("delhi");
  });

  // Null is an answer, not a crash: the caller decides what to do.
  it("returns null when nothing can serve the whole order", () => {
    const c = ctx({ candidates: [loc("delhi", { "p1:": 1 })] });
    expect(pickFulfilmentLocation(c)).toBeNull();
  });

  it("returns null with no candidates at all", () => {
    expect(pickFulfilmentLocation(ctx())).toBeNull();
  });
});

describe("getStrategy", () => {
  it("resolves the registered one", () => {
    expect(getStrategy("priority").id).toBe("priority");
  });

  // A strategy removed from the registry, or a typo in the DB, must not stop a
  // store selling.
  it("falls back to the default for an unknown id", () => {
    expect(getStrategy("nearest").id).toBe(DEFAULT_STRATEGY_ID);
    expect(getStrategy(null).id).toBe(DEFAULT_STRATEGY_ID);
    expect(getStrategy(undefined).id).toBe(DEFAULT_STRATEGY_ID);
  });
});
