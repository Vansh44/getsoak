import { describe, expect, it } from "vitest";
import {
  canonicalMinkTimestamp,
  canonicalOptionalMinkTimestamp,
} from "./timestamps";

describe("Mink business timestamp canonicalization", () => {
  it("treats PostgreSQL and ISO representations of a coupon date equally", () => {
    expect(canonicalMinkTimestamp("2026-08-30 09:10:11+00")).toBe(
      canonicalMinkTimestamp("2026-08-30T09:10:11.000Z"),
    );
  });

  it("keeps null optional coupon dates and rejects malformed values", () => {
    expect(canonicalOptionalMinkTimestamp(null)).toBeNull();
    expect(() => canonicalMinkTimestamp("not-a-date")).toThrow(RangeError);
  });
});
