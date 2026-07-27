import { describe, it, expect } from "vitest";
import { stockAlertFor } from "./alerts";

// The whole value of the low-stock alert is that it fires ONCE per crossing.
// A merchant who gets "Only 3 left" on every subsequent sale stops reading
// them, which makes the out-of-stock alert worthless too.
describe("stockAlertFor", () => {
  const THRESHOLD = 5;

  it("alerts when stock crosses into the low band", () => {
    expect(stockAlertFor(6, 5, THRESHOLD)).toBe("low");
    expect(stockAlertFor(10, 2, THRESHOLD)).toBe("low");
  });

  it("stays quiet on every further sale inside the low band", () => {
    expect(stockAlertFor(5, 4, THRESHOLD)).toBeNull();
    expect(stockAlertFor(4, 3, THRESHOLD)).toBeNull();
    expect(stockAlertFor(2, 1, THRESHOLD)).toBeNull();
  });

  it("alerts when stock reaches zero", () => {
    expect(stockAlertFor(1, 0, THRESHOLD)).toBe("out");
    // Straight from healthy to empty (a bulk correction) is still one alert.
    expect(stockAlertFor(40, 0, THRESHOLD)).toBe("out");
  });

  it("stays quiet on an already-empty SKU", () => {
    expect(stockAlertFor(0, 0, THRESHOLD)).toBeNull();
    // Backorderable SKUs are filtered out before this point, but a negative
    // move on an empty one must not re-alert either.
    expect(stockAlertFor(0, -2, THRESHOLD)).toBeNull();
  });

  it("re-arms after a restock", () => {
    expect(stockAlertFor(0, 20, THRESHOLD)).toBeNull(); // restocking is not news
    expect(stockAlertFor(20, 5, THRESHOLD)).toBe("low"); // but the next dip is
  });

  it("treats a zero threshold as 'only tell me when it's gone'", () => {
    expect(stockAlertFor(3, 1, 0)).toBeNull();
    expect(stockAlertFor(1, 0, 0)).toBe("out");
  });
});
