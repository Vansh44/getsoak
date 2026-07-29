import { describe, it, expect } from "vitest";
import {
  MAX_PINCODE_RULES,
  formatPincodeRules,
  matchesPincode,
  normalizePincode,
  parsePincodeRules,
} from "./pincodes";

describe("normalizePincode", () => {
  it("strips the punctuation people actually type", () => {
    expect(normalizePincode(" 400 001 ")).toBe("400001");
    expect(normalizePincode("sw1a 1aa")).toBe("SW1A1AA");
    expect(normalizePincode("400-001")).toBe("400001");
  });

  it("survives a non-string instead of throwing on the checkout path", () => {
    expect(normalizePincode(undefined)).toBe("");
    expect(normalizePincode(400001)).toBe("");
  });
});

describe("parsePincodeRules", () => {
  it("accepts the three forms", () => {
    const { rules, invalid } = parsePincodeRules("400001, 411*, 400001-400104");
    expect(rules).toEqual(["400001", "411*", "400001-400104"]);
    expect(invalid).toEqual([]);
  });

  it("takes a spreadsheet column, a comma list, or a sentence of spaces", () => {
    expect(parsePincodeRules("400001\n400002\n400003").rules).toHaveLength(3);
    expect(parsePincodeRules("400001,400002;400003").rules).toHaveLength(3);
    expect(parsePincodeRules("400001 400002  400003").rules).toHaveLength(3);
  });

  it("tolerates spaces inside a range — the same thing typed two ways", () => {
    expect(parsePincodeRules("400001 - 400104").rules).toEqual([
      "400001-400104",
    ]);
  });

  it("dedupes and uppercases", () => {
    expect(parsePincodeRules("400001, 400001, sw1a1aa").rules).toEqual([
      "400001",
      "SW1A1AA",
    ]);
  });

  it("REPORTS what it threw away — a silently dropped rule is one the merchant thinks is protecting them", () => {
    const { rules, invalid } = parsePincodeRules("400001, oops!!, 12");
    expect(rules).toEqual(["400001"]);
    expect(invalid).toEqual(["oops!!", "12"]);
  });

  it("validates what was TYPED, not what survives stripping — else 'oops!!' becomes the valid code 'OOPS'", () => {
    expect(parsePincodeRules("40#0001").invalid).toEqual(["40#0001"]);
    expect(parsePincodeRules("40#0001").rules).toEqual([]);
  });

  it("rejects a backwards or mismatched range rather than guessing", () => {
    expect(parsePincodeRules("400104-400001").invalid).toEqual([
      "400104-400001",
    ]);
    expect(parsePincodeRules("4001-400104").invalid).toEqual(["4001-400104"]);
  });

  it("caps a paste of the whole postcode directory", () => {
    const huge = Array.from({ length: 700 }, (_, i) => String(400000 + i)).join(
      ",",
    );
    expect(parsePincodeRules(huge).rules).toHaveLength(MAX_PINCODE_RULES);
  });

  it("round-trips through the merchant-facing format", () => {
    const { rules } = parsePincodeRules("400*, 411001");
    expect(parsePincodeRules(formatPincodeRules(rules)).rules).toEqual(rules);
  });
});

describe("matchesPincode", () => {
  it("★ NO RULES MEANS EVERYWHERE — an unconfigured location behaves exactly as it did before this feature existed", () => {
    expect(matchesPincode([], "400001")).toBe(true);
    expect(matchesPincode(null, "400001")).toBe(true);
    expect(matchesPincode(undefined, "400001")).toBe(true);
  });

  it("★ AN UNKNOWN POSTCODE MATCHES — a first-time shopper hasn't typed their address yet", () => {
    expect(matchesPincode(["400*"], "")).toBe(true);
    expect(matchesPincode(["400*"], null)).toBe(true);
  });

  it("matches an exact code", () => {
    expect(matchesPincode(["400001"], "400001")).toBe(true);
    expect(matchesPincode(["400001"], "400002")).toBe(false);
  });

  it("matches a prefix — the rule that makes Mumbai typable", () => {
    expect(matchesPincode(["400*"], "400104")).toBe(true);
    expect(matchesPincode(["400*"], "411001")).toBe(false);
  });

  it("matches inside a range, inclusive at both ends", () => {
    expect(matchesPincode(["400001-400104"], "400001")).toBe(true);
    expect(matchesPincode(["400001-400104"], "400050")).toBe(true);
    expect(matchesPincode(["400001-400104"], "400104")).toBe(true);
    expect(matchesPincode(["400001-400104"], "400105")).toBe(false);
  });

  it("won't let a shorter code fall inside a range numerically", () => {
    // 4001 < 400104 as a number, but it is not a six-digit code in that band.
    expect(matchesPincode(["400001-400104"], "4001")).toBe(false);
  });

  it("normalises the candidate the same way it normalised the rules", () => {
    expect(matchesPincode(["SW1A1AA"], "sw1a 1aa")).toBe(true);
    expect(matchesPincode(["400001"], " 400 001 ")).toBe(true);
  });

  it("takes any one of several rules", () => {
    const rules = ["400*", "411001", "560001-560010"];
    expect(matchesPincode(rules, "400072")).toBe(true);
    expect(matchesPincode(rules, "411001")).toBe(true);
    expect(matchesPincode(rules, "560005")).toBe(true);
    expect(matchesPincode(rules, "600001")).toBe(false);
  });
});
