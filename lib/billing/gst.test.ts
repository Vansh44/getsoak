import { describe, it, expect } from "vitest";
import { computeTax } from "./tax";
import {
  splitGst,
  isIntraState,
  normalizeStateCode,
  gstBreakdown,
  isValidGstinFormat,
  stateCodeFromGstin,
} from "./gst";

describe("normalizeStateCode", () => {
  it("zero-pads and accepts numbers", () => {
    expect(normalizeStateCode("7")).toBe("07");
    expect(normalizeStateCode("07")).toBe("07");
    expect(normalizeStateCode(7)).toBe("07");
    expect(normalizeStateCode(27)).toBe("27");
    expect(normalizeStateCode(" 09 ")).toBe("09");
  });
  it("rejects junk", () => {
    expect(normalizeStateCode("")).toBeNull();
    expect(normalizeStateCode("abc")).toBeNull();
    expect(normalizeStateCode("123")).toBeNull();
    expect(normalizeStateCode(null)).toBeNull();
  });
});

describe("isIntraState", () => {
  it("compares normalised codes", () => {
    expect(isIntraState("07", "07")).toBe(true);
    expect(isIntraState("7", "07")).toBe(true);
    expect(isIntraState("07", "27")).toBe(false);
  });
  // A walk-in at the counter is the overwhelming case; defaulting to IGST on
  // missing data would mis-tax ordinary local shops.
  it("defaults to intra-state when either side is unknown", () => {
    expect(isIntraState(null, "07")).toBe(true);
    expect(isIntraState("07", undefined)).toBe(true);
    expect(isIntraState(null, null)).toBe(true);
  });
});

describe("splitGst", () => {
  it("halves an intra-state supply into CGST + SGST", () => {
    expect(splitGst(18, true)).toEqual({
      cgst: 9,
      sgst: 9,
      igst: 0,
      intraState: true,
    });
  });

  it("puts the whole amount in IGST inter-state", () => {
    expect(splitGst(18, false)).toEqual({
      cgst: 0,
      sgst: 0,
      igst: 18,
      intraState: false,
    });
  });

  // The halves must re-sum EXACTLY or the invoice won't balance.
  it("splits odd paise without losing or inventing money", () => {
    for (const amount of [0.05, 0.01, 1.23, 7.77, 99.99, 12.345]) {
      const s = splitGst(amount, true);
      expect(s.cgst + s.sgst).toBeCloseTo(
        Math.round((amount + Number.EPSILON) * 100) / 100,
        2,
      );
    }
  });

  it("treats junk and negatives as zero", () => {
    expect(splitGst(-5, true)).toMatchObject({ cgst: 0, sgst: 0 });
    expect(splitGst(NaN, true)).toMatchObject({ cgst: 0, sgst: 0, igst: 0 });
  });
});

// The split must never disagree with the order total computeTax produced.
describe("splitGst reconciles with computeTax", () => {
  const lines = [
    { amount: 500, rate: 18, label: "GST 18%" },
    { amount: 249.5, rate: 5, label: "GST 5%" },
    { amount: 99.99, rate: 12, label: "GST 12%" },
  ];

  it("per-line halves re-sum to the computed total tax (exclusive)", () => {
    const t = computeTax({ lines, discount: 75, pricesIncludeTax: false });
    const summed = t.lines.reduce((s, l) => {
      const g = splitGst(l.tax, true);
      return s + g.cgst + g.sgst + g.igst;
    }, 0);
    expect(Math.round(summed * 100) / 100).toBeCloseTo(t.totalTax, 2);
  });

  it("holds for inclusive pricing and inter-state too", () => {
    const t = computeTax({ lines, discount: 0, pricesIncludeTax: true });
    const summed = t.lines.reduce((s, l) => {
      const g = splitGst(l.tax, false);
      return s + g.igst;
    }, 0);
    expect(Math.round(summed * 100) / 100).toBeCloseTo(t.totalTax, 2);
  });
});

describe("gstBreakdown", () => {
  it("groups by rate and sorts ascending", () => {
    const out = gstBreakdown([
      { rate: 18, taxableValue: 100, cgst: 9, sgst: 9, igst: 0 },
      { rate: 5, taxableValue: 200, cgst: 5, sgst: 5, igst: 0 },
      { rate: 18, taxableValue: 50, cgst: 4.5, sgst: 4.5, igst: 0 },
    ]);
    expect(out.map((b) => b.rate)).toEqual([5, 18]);
    expect(out[1]).toMatchObject({
      rate: 18,
      taxableValue: 150,
      cgst: 13.5,
      sgst: 13.5,
    });
  });

  it("skips zero-rated lines and labels sensibly", () => {
    const out = gstBreakdown([
      { rate: 0, taxableValue: 100, cgst: 0, sgst: 0, igst: 0 },
      { rate: 12, taxableValue: 100, cgst: 6, sgst: 6, igst: 0 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe("GST 12%");
  });
});

describe("GSTIN helpers", () => {
  it("accepts a well-formed GSTIN and extracts its state", () => {
    const gstin = "07AABCU9603R1ZM";
    expect(isValidGstinFormat(gstin)).toBe(true);
    expect(stateCodeFromGstin(gstin)).toBe("07");
  });

  it("rejects malformed values", () => {
    expect(isValidGstinFormat("07AABCU9603R1Z")).toBe(false); // 14 chars
    expect(isValidGstinFormat("notagstin")).toBe(false);
    expect(isValidGstinFormat("")).toBe(false);
    expect(isValidGstinFormat(null)).toBe(false);
  });
});
