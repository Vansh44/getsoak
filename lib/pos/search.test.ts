import { describe, it, expect } from "vitest";
import { likePattern } from "./search";

describe("likePattern", () => {
  it("wraps an ordinary term", () => {
    expect(likePattern("ravi")).toBe("%ravi%");
  });

  it("★ escapes the wildcards, so '%' matches a literal % and not everything", () => {
    expect(likePattern("%")).toBe("%\\%%");
    expect(likePattern("a_b")).toBe("%a\\_b%");
  });

  it("★ escapes the backslash FIRST, or it would cancel the next escape", () => {
    // Naively replacing % and _ before \ turns "\%" into "\\%" — a literal
    // backslash followed by a live wildcard.
    expect(likePattern("\\%")).toBe("%\\\\\\%%");
  });

  it("leaves an empty term as a match-all pattern for the caller to skip", () => {
    expect(likePattern("")).toBe("%%");
  });
});
