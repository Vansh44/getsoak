import { describe, expect, it } from "vitest";
import {
  assertMinkSpecialPriceSupported,
  normalizeMinkPriceSet,
  parseMinkBulkPriceDraftLines,
} from "./bulk-price-policy";

describe("Phase 5F bulk price policy", () => {
  it("canonicalizes exact two-decimal prices and an empty special price", () => {
    expect(normalizeMinkPriceSet("500", 450.5, "")).toEqual({
      basePrice: "500.00",
      sellingPrice: "450.50",
      specialPrice: null,
      effectivePrice: "450.50",
    });
  });

  it("requires MRP >= selling >= special", () => {
    expect(() => normalizeMinkPriceSet(100, 120, null)).toThrow(/MRP/i);
    expect(() => normalizeMinkPriceSet(100, 90, 95)).toThrow(/special/i);
  });

  it("rejects precision, exponent, zero and range bypasses", () => {
    for (const value of ["1.001", "1e3", 0, -1, "100000000.00"]) {
      expect(() => normalizeMinkPriceSet(value, 1, null)).toThrow();
    }
  });

  it("rejects special prices for non-variant product SKUs", () => {
    expect(() =>
      assertMinkSpecialPriceSupported("80.00", false, "Line 1"),
    ).toThrow(/no variant/i);
    expect(() =>
      assertMinkSpecialPriceSupported(null, false, "Line 1"),
    ).not.toThrow();
    expect(() =>
      assertMinkSpecialPriceSupported("80.00", true, "Line 1"),
    ).not.toThrow();
  });

  it("parses 1-20 unique exact SKU lines with strict fields", () => {
    expect(
      parseMinkBulkPriceDraftLines(
        JSON.stringify([
          {
            sku: "SKU-1",
            base_price: "100",
            selling_price: "90",
            special_price: "80",
          },
        ]),
      ),
    ).toEqual([
      {
        sku: "SKU-1",
        base_price: "100.00",
        selling_price: "90.00",
        special_price: "80.00",
      },
    ]);
    expect(() =>
      parseMinkBulkPriceDraftLines(
        JSON.stringify([
          {
            sku: "SKU-1",
            base_price: "100",
            selling_price: "90",
            special_price: "",
          },
          {
            sku: "SKU-1",
            base_price: "110",
            selling_price: "95",
            special_price: "",
          },
        ]),
      ),
    ).toThrow(/duplicates/i);
  });
});
