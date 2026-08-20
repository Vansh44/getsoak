import { describe, expect, it } from "vitest";
import {
  analyticsReportCsvHref,
  analyticsReportHref,
  analyticsReportQuery,
  isAnalyticsReportId,
} from "./reports";

describe("analytics report links", () => {
  const params = {
    range: "custom",
    from: "2026-08-01",
    to: "2026-08-20",
    compare: "none",
    location: ["loc-1", "loc-forged"],
    ignored: "secret",
  };

  it("preserves only the shared analytics filter contract", () => {
    const query = analyticsReportQuery(params);
    expect(query).toContain("range=custom");
    expect(query).toContain("location=loc-1");
    expect(query).not.toContain("loc-forged");
    expect(query).not.toContain("ignored");
  });

  it("omits irrelevant location input from Google Search reports", () => {
    expect(analyticsReportHref("search-queries", params)).not.toContain(
      "location",
    );
    expect(analyticsReportCsvHref("search-queries", params)).toMatch(
      /^\/api\/dashboard\/analytics\/reports\/search-queries\?/,
    );
  });

  it("rejects unknown report ids", () => {
    expect(isAnalyticsReportId("total-sales")).toBe(true);
    expect(isAnalyticsReportId("customers-private")).toBe(false);
  });
});
