import { describe, expect, it } from "vitest";
import { deriveGoogleIndexingHealth } from "./indexing-health";

const ORIGIN = "https://acme.com";

describe("Google indexing health", () => {
  it("keeps unavailable and unlaunched stores distinct", () => {
    expect(deriveGoogleIndexingHealth({}, ORIGIN, false).state).toBe(
      "unavailable",
    );
    expect(
      deriveGoogleIndexingHealth({ launched: false }, ORIGIN, true).state,
    ).toBe("not_launched");
  });

  it("recognizes platform ownership without a per-store verification token", () => {
    expect(
      deriveGoogleIndexingHealth(
        {
          google_sitemap_submitted_origin: "https://shop.storemink.com",
          google_sitemap_submitted_at: "2026-08-20T02:00:00.000Z",
        },
        "https://shop.storemink.com",
        true,
      ),
    ).toMatchObject({
      state: "ready",
      verification: "platform",
      sitemap: "submitted",
    });
  });

  it("requires verification and sitemap status to match the current origin", () => {
    expect(
      deriveGoogleIndexingHealth(
        {
          google_site_verification_domain: "https://old.example",
          google_site_verified_at: "2026-08-20T01:00:00.000Z",
          google_sitemap_submitted_origin: "https://old.example",
          google_sitemap_submitted_at: "2026-08-20T02:00:00.000Z",
        },
        ORIGIN,
        true,
      ),
    ).toMatchObject({
      state: "waiting",
      verification: "pending",
      verifiedAt: null,
      sitemap: "pending",
      sitemapSubmittedAt: null,
    });
  });

  it("surfaces a recorded error even when an older sitemap succeeded", () => {
    expect(
      deriveGoogleIndexingHealth(
        {
          google_site_verification_domain: ORIGIN,
          google_site_verified_at: "2026-08-20T01:00:00.000Z",
          google_sitemap_submitted_origin: ORIGIN,
          google_sitemap_submitted_at: "2026-08-20T02:00:00.000Z",
          google_indexing_attempted_at: "2026-08-20T03:00:00.000Z",
          google_indexing_error: "Search Console permission denied",
        },
        ORIGIN,
        true,
      ),
    ).toMatchObject({
      state: "error",
      verification: "verified",
      sitemap: "submitted",
      lastAttemptAt: "2026-08-20T03:00:00.000Z",
      error: "Search Console permission denied",
    });
  });
});
