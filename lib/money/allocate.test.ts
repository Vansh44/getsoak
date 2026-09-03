import { describe, it, expect } from "vitest";
import { allocateProportional, toPaise, toRupees, round2 } from "./allocate";

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

describe("allocateProportional", () => {
  it("splits exactly in proportion when it divides evenly", () => {
    expect(allocateProportional([10000, 10000], 5000)).toEqual([2500, 2500]);
  });

  it("★ always sums to the total — the whole point", () => {
    // 100/3 does not divide; the parts must still add up.
    const share = allocateProportional([10000, 10000, 10000], 10000);
    expect(sum(share)).toBe(10000);
    expect(share).toEqual([3334, 3333, 3333]);
  });

  it("★ gives the remainder to the largest fractional parts, not the last line", () => {
    // Weights 1:1:2 over 7 paise → exact 1.75, 1.75, 3.5.
    const share = allocateProportional([100, 100, 200], 7);
    expect(sum(share)).toBe(7);
    // 3.5 has the largest fraction after flooring is equal; index breaks ties.
    expect(share).toEqual([2, 2, 3]);
  });

  it("caps at the weight total — cannot give away more than there is", () => {
    const share = allocateProportional([500, 500], 99999);
    expect(sum(share)).toBe(1000);
    expect(share).toEqual([500, 500]);
  });

  it("★ never allocates to a zero-weight line (a free-gift ₹0 line)", () => {
    const share = allocateProportional([0, 10000], 5000);
    expect(share[0]).toBe(0);
    expect(share[1]).toBe(5000);
  });

  it("★ never allocates more to a line than that line holds", () => {
    // A tiny line beside a huge one: the remainder passes must not overfill it.
    const share = allocateProportional([1, 100000], 100001);
    expect(share[0]).toBeLessThanOrEqual(1);
    expect(sum(share)).toBe(100001);
  });

  it("treats negative weights as zero rather than throwing", () => {
    const share = allocateProportional([-500, 1000], 400);
    expect(share[0]).toBe(0);
    expect(share[1]).toBe(400);
  });

  it("returns zeroes for an empty or worthless cart", () => {
    expect(allocateProportional([], 500)).toEqual([]);
    expect(allocateProportional([0, 0], 500)).toEqual([0, 0]);
  });

  it("returns zeroes for a zero or negative total", () => {
    expect(allocateProportional([100, 100], 0)).toEqual([0, 0]);
    expect(allocateProportional([100, 100], -50)).toEqual([0, 0]);
  });

  it("is deterministic across repeated calls on equal weights", () => {
    const a = allocateProportional([333, 333, 333], 100);
    const b = allocateProportional([333, 333, 333], 100);
    expect(a).toEqual(b);
  });

  it("survives non-finite input without producing NaN", () => {
    const share = allocateProportional([Number.NaN, 1000], 500);
    expect(share.every(Number.isFinite)).toBe(true);
    expect(sum(share)).toBe(500);
  });
});

describe("paise helpers", () => {
  it("round-trips rupees through paise", () => {
    expect(toRupees(toPaise(238.4))).toBe(238.4);
    expect(toPaise(0.005)).toBe(1); // rounds, never truncates
  });

  it("coerces junk to zero instead of NaN", () => {
    expect(toPaise(Number.NaN)).toBe(0);
    expect(round2(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("round2 guards float error", () => {
    expect(round2(0.1 + 0.2)).toBe(0.3);
    expect(round2(1.005)).toBe(1.01);
  });
});
