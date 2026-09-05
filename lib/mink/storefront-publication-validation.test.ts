import { describe, expect, it } from "vitest";
import {
  validateMinkStorefrontBrowserValidation,
  validateMinkStorefrontPublicationStatic,
} from "./storefront-publication-validation";
import {
  MINK_STOREFRONT_BROWSER_VALIDATION_VERSION,
  minkStorefrontBrowserIdentity,
  type MinkStorefrontBrowserValidation,
} from "./storefront-publication-types";

const PATCH_DIGEST = "a".repeat(64);

function config(overrides: Record<string, unknown> = {}) {
  return {
    html: '<section><h2>New arrivals</h2><button type="button">Shop now</button></section>',
    css: ".hero { max-width: 100%; }",
    js: "",
    height_mode: "auto" as const,
    fixed_height: 400,
    ...overrides,
  };
}

function evidence(
  overrides: Partial<MinkStorefrontBrowserValidation> = {},
): MinkStorefrontBrowserValidation {
  const viewport = (name: "desktop" | "mobile", width: number) => ({
    viewport: name,
    width,
    passed: true,
    issues: [],
    runtimeErrorCount: 0,
    cspViolationCount: 0,
    horizontalOverflow: false,
  });
  return {
    schemaVersion: MINK_STOREFRONT_BROWSER_VALIDATION_VERSION,
    patchDigest: PATCH_DIGEST,
    checkedAt: new Date().toISOString(),
    browser: { family: "chromium", major: 140, supported: true },
    viewports: {
      desktop: viewport("desktop", 1280),
      mobile: viewport("mobile", 390),
    },
    ...overrides,
  };
}

describe("Mink Phase 7D publication validation", () => {
  it("accepts an accessible responsive code fragment", () => {
    expect(validateMinkStorefrontPublicationStatic(config())).toMatchObject({
      passed: true,
      issues: [],
    });
  });

  it("blocks missing names, skipped headings, positive tabindex and unsafe motion", () => {
    const result = validateMinkStorefrontPublicationStatic(
      config({
        html: '<h2>Title</h2><h4>Skipped</h4><button tabindex="2"></button><img>',
        css: ".item { transition: all 200ms; outline: none; min-width: 800px; }",
      }),
    );
    expect(result.passed).toBe(false);
    expect(result.issues.join(" ")).toMatch(/alt attribute/i);
    expect(result.issues.join(" ")).toMatch(/accessible name/i);
    expect(result.issues.join(" ")).toMatch(/heading/i);
    expect(result.issues.join(" ")).toMatch(/tabindex/i);
    expect(result.issues.join(" ")).toMatch(/reduced-motion/i);
    expect(result.issues.join(" ")).toMatch(/mobile/i);
  });

  it("requires fresh evidence for the exact patch and exact viewport widths", () => {
    expect(
      validateMinkStorefrontBrowserValidation({
        value: evidence(),
        patchDigest: PATCH_DIGEST,
      }),
    ).toMatchObject({ browser: { family: "chromium", supported: true } });
    expect(() =>
      validateMinkStorefrontBrowserValidation({
        value: evidence({ patchDigest: "b".repeat(64) }),
        patchDigest: PATCH_DIGEST,
      }),
    ).toThrow(/exact code proposal/i);
    expect(() =>
      validateMinkStorefrontBrowserValidation({
        value: evidence({
          checkedAt: new Date(Date.now() - 180_000).toISOString(),
        }),
        patchDigest: PATCH_DIGEST,
      }),
    ).toThrow(/expired/i);
  });

  it("rejects failed runtime, CSP, layout or accessibility evidence", () => {
    const failed = evidence();
    failed.viewports.mobile = {
      ...failed.viewports.mobile,
      passed: false,
      issues: ["horizontal_overflow"],
      horizontalOverflow: true,
    };
    expect(() =>
      validateMinkStorefrontBrowserValidation({
        value: failed,
        patchDigest: PATCH_DIGEST,
      }),
    ).toThrow(/mobile/i);
  });

  it("enforces the supported browser floor without storing a raw user agent", () => {
    expect(
      minkStorefrontBrowserIdentity(
        "Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36",
      ),
    ).toEqual({ family: "chromium", major: 140, supported: true });
    expect(
      minkStorefrontBrowserIdentity("Mozilla/5.0 Version/16.6 Safari/605.1.15"),
    ).toEqual({ family: "webkit", major: 16, supported: false });
  });
});
