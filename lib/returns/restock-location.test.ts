import { describe, it, expect } from "vitest";
import {
  defaultRestockLocation,
  type RestockLocation,
} from "./restock-location";

const loc = (
  id: string,
  name: string,
  acceptsReturns = false,
): RestockLocation => ({ id, name, acceptsReturns });

describe("defaultRestockLocation", () => {
  it("has nothing to offer when there are no shelves", () => {
    // Not an error state — it is a single-location store, and the caller falls
    // back to the default-location wrapper exactly as it did before Step 13.
    expect(defaultRestockLocation([])).toBeNull();
  });

  it("uses the only shelf there is", () => {
    expect(defaultRestockLocation([loc("l1", "Main")])).toBe("l1");
  });

  it("★ prefers the single returns desk over a warehouse", () => {
    // The owner's scenario: Delhi is a warehouse that fulfils online, Mumbai is
    // the shop that takes returns. Both can receive stock, so both are offered
    // — but the one customers hand goods back at is the right default.
    const at = defaultRestockLocation([
      loc("delhi", "Delhi warehouse"),
      loc("mumbai", "Mumbai shop", true),
    ]);
    expect(at).toBe("mumbai");
  });

  it("★★ asks when two shelves both take returns", () => {
    // Two returns desks is genuine ambiguity. Picking the first would be the
    // original defect — crediting a location nobody chose — reimplemented.
    expect(
      defaultRestockLocation([
        loc("mumbai", "Mumbai shop", true),
        loc("pune", "Pune shop", true),
      ]),
    ).toBeNull();
  });

  it("★ asks when several shelves and NO returns desk", () => {
    // Nothing here is more obviously right than anything else, so the merchant
    // is the only one who knows where the parcel actually turned up.
    expect(
      defaultRestockLocation([
        loc("delhi", "Delhi warehouse"),
        loc("nagpur", "Nagpur warehouse"),
      ]),
    ).toBeNull();
  });

  it("does not care what order they arrive in", () => {
    const desk = loc("mumbai", "Mumbai shop", true);
    const wh = loc("delhi", "Delhi warehouse");
    expect(defaultRestockLocation([desk, wh])).toBe(
      defaultRestockLocation([wh, desk]),
    );
  });
});
