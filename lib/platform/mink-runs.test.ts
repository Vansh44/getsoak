import { describe, expect, it } from "vitest";
import { normalizeMinkRunFilters } from "./mink-runs";

describe("normalizeMinkRunFilters", () => {
  it("uses safe defaults and ignores invalid filters", () => {
    expect(
      normalizeMinkRunFilters({
        days: ["30", "1"],
        status: "not-a-status",
        q: "  echo store  ",
      }),
    ).toEqual({ days: 30, status: "all", q: "echo store", actor: "" });
  });

  it("accepts a bounded status, window, and actor", () => {
    expect(
      normalizeMinkRunFilters({
        days: "1",
        status: "failed",
        actor: "admin-1",
      }),
    ).toEqual({ days: 1, status: "failed", q: "", actor: "admin-1" });
  });
});
