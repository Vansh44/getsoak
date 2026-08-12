import { describe, expect, it } from "vitest";
import { formatIndianMobile, normalizeIndianMobile } from "./phone";

describe("normalizeIndianMobile", () => {
  it.each([
    ["9876543210", "9876543210"],
    ["+91 98765 43210", "9876543210"],
    ["09876543210", "9876543210"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeIndianMobile(input)).toBe(expected);
  });

  it.each([
    "",
    "1234567890",
    "8888888888",
    "+918888888888",
    "98765",
    "+1 415 555 2671",
  ])("rejects invalid or placeholder number %s", (input) => {
    expect(normalizeIndianMobile(input)).toBeNull();
  });

  it("formats the stored customer number consistently", () => {
    expect(formatIndianMobile("09876 543210")).toBe("+919876543210");
  });
});
