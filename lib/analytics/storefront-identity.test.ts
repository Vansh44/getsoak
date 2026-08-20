import { afterEach, describe, expect, it, vi } from "vitest";
import {
  storefrontBusinessDate,
  storefrontVisitorIdentity,
} from "./storefront-identity";

const store = {
  id: "156c8c4f-4aae-4bff-8f29-4ac24d4805f5",
  settings: { business: { timeZone: "Asia/Kolkata" } },
};

function requestHeaders(userAgent = "Mozilla/5.0 Safari/605.1") {
  return new Headers({
    "user-agent": userAgent,
    "x-forwarded-for": "203.0.113.8, 10.0.0.1",
  });
}

afterEach(() => vi.unstubAllEnvs());

describe("storefront visitor identity", () => {
  it("uses the business-local date and rotates the key at local midnight", () => {
    vi.stubEnv("STOREFRONT_ANALYTICS_SECRET", "test-secret");
    const before = new Date("2026-08-20T18:29:59.000Z");
    const after = new Date("2026-08-20T18:30:01.000Z");
    expect(storefrontBusinessDate(store.settings, before)).toBe("2026-08-20");
    expect(storefrontBusinessDate(store.settings, after)).toBe("2026-08-21");
    expect(
      storefrontVisitorIdentity(store, requestHeaders(), before)?.visitorKey,
    ).not.toBe(
      storefrontVisitorIdentity(store, requestHeaders(), after)?.visitorKey,
    );
  });

  it("is deterministic inside one day without setting a browser id", () => {
    vi.stubEnv("STOREFRONT_ANALYTICS_SECRET", "test-secret");
    const now = new Date("2026-08-20T12:00:00.000Z");
    expect(storefrontVisitorIdentity(store, requestHeaders(), now)).toEqual(
      storefrontVisitorIdentity(store, requestHeaders(), now),
    );
  });

  it("fails closed for bots, unknown IPs, and missing secrets", () => {
    vi.stubEnv("STOREFRONT_ANALYTICS_SECRET", "test-secret");
    expect(
      storefrontVisitorIdentity(store, requestHeaders("Googlebot/2.1")),
    ).toBeNull();
    expect(
      storefrontVisitorIdentity(store, new Headers({ "user-agent": "Safari" })),
    ).toBeNull();
    vi.stubEnv("STOREFRONT_ANALYTICS_SECRET", "");
    vi.stubEnv("CRON_SECRET", "");
    expect(storefrontVisitorIdentity(store, requestHeaders())).toBeNull();
  });
});
