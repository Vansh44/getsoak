import { describe, expect, it } from "vitest";
import {
  correctionDates,
  mondayForSearchDate,
  normalizeSearchOrigin,
  normalizeSearchRows,
  pageFilterForOrigin,
} from "./search-performance";

describe("pageFilterForOrigin", () => {
  it("anchors and escapes a platform-subdomain origin", () => {
    const filter = pageFilterForOrigin("https://mink.storemink.com");
    expect(filter).toEqual({
      dimension: "page",
      operator: "includingRegex",
      expression: "^https://mink\\.storemink\\.com/",
    });
    const matcher = new RegExp(filter.expression);
    expect(matcher.test("https://mink.storemink.com/products/a")).toBe(true);
    expect(matcher.test("https://supermink.storemink.com/products/a")).toBe(
      false,
    );
  });

  it("normalizes an HTTPS origin and rejects paths or ports", () => {
    expect(normalizeSearchOrigin("https://SHOP.Example.com/")).toBe(
      "https://shop.example.com",
    );
    expect(() => normalizeSearchOrigin("http://shop.example.com")).toThrow();
    expect(() =>
      normalizeSearchOrigin("https://shop.example.com/catalog"),
    ).toThrow();
    expect(() =>
      normalizeSearchOrigin("https://shop.example.com:8443"),
    ).toThrow();
  });
});

describe("Search Console date and row rules", () => {
  it("uses five completed Pacific dates across a UTC/PT boundary", () => {
    expect(correctionDates(new Date("2026-08-19T05:30:00.000Z"))).toEqual([
      "2026-08-12",
      "2026-08-13",
      "2026-08-14",
      "2026-08-15",
      "2026-08-16",
    ]);
  });

  it("finds the PT-week Monday", () => {
    expect(mondayForSearchDate("2026-08-16")).toBe("2026-08-10");
    expect(mondayForSearchDate("2026-08-17")).toBe("2026-08-17");
  });

  it("stores the impression-weighted position numerator and never CTR", () => {
    expect(
      normalizeSearchRows(
        [{ keys: ["shoes"], clicks: 2.2, impressions: 10, position: 3.25 }],
        "query",
      ),
    ).toEqual([
      {
        key: "shoes",
        clicks: 2,
        impressions: 10,
        positionSum: "32.5000",
      },
    ]);
  });
});
