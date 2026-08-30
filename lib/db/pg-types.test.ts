import { types } from "pg";
import { describe, expect, it } from "vitest";
import { postgresStringTimestampTypes } from "./pg-types";

describe("PostgreSQL timestamp parsing", () => {
  it.each([types.builtins.TIMESTAMP, types.builtins.TIMESTAMPTZ])(
    "preserves microsecond text for timestamp OID %s",
    (oid) => {
      const value = "2026-08-30 09:10:11.123456+00";
      expect(postgresStringTimestampTypes.getTypeParser(oid)(value)).toBe(
        value,
      );
    },
  );

  it("delegates non-timestamp values to the standard parser", () => {
    expect(
      postgresStringTimestampTypes.getTypeParser(types.builtins.INT4)("42"),
    ).toBe(42);
  });
});
