import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const headerState = vi.hoisted(() => ({ host: "pos.storemink.com" }));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers({ host: headerState.host })),
}));

import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
import { metadata } from "./page";
import {
  buildPosStructuredData,
  POS_FEATURES,
  POS_PRODUCT_DESCRIPTION,
} from "./structured-data";

describe("POS product host discovery metadata", () => {
  beforeEach(() => {
    headerState.host = "pos.storemink.com";
  });

  it("publishes only the canonical POS product page in its own sitemap", async () => {
    expect(await sitemap()).toEqual([
      {
        url: "https://pos.storemink.com",
        changeFrequency: "monthly",
        priority: 1,
      },
    ]);
  });

  it("publishes POS-host robots metadata", async () => {
    expect(await robots()).toEqual({
      rules: { userAgent: "*", allow: "/" },
      sitemap: "https://pos.storemink.com/sitemap.xml",
      host: "https://pos.storemink.com",
    });
  });

  it("canonicalises the product page onto the dedicated host", () => {
    expect(metadata.alternates).toEqual({
      canonical: "https://pos.storemink.com",
    });
    expect(metadata.openGraph).toMatchObject({
      url: "https://pos.storemink.com",
      siteName: "StoreMink",
      type: "website",
    });
    expect(metadata.openGraph?.images).toHaveLength(1);
    expect(metadata.twitter).toMatchObject({ card: "summary_large_image" });
  });

  it("connects the POS product and its visible features to StoreMink", () => {
    const schema = buildPosStructuredData({
      proMonthlyEquivalentInr: 2000,
    });
    const graph = schema["@graph"] as Record<string, unknown>[];
    const organisation = graph.find(
      (node) => node["@id"] === "https://storemink.com/#organization",
    );
    const website = graph.find(
      (node) => node["@id"] === "https://pos.storemink.com/#website",
    );
    const software = graph.find(
      (node) => node["@id"] === "https://pos.storemink.com/#software",
    );

    expect(organisation).toMatchObject({
      "@type": "Organization",
      name: "StoreMink",
      url: "https://storemink.com",
    });
    expect(website).toMatchObject({
      "@type": "WebSite",
      name: "StoreMink Point of Sale",
      publisher: { "@id": "https://storemink.com/#organization" },
    });
    expect(software).toMatchObject({
      "@type": "SoftwareApplication",
      name: "StoreMink Point of Sale",
      description: POS_PRODUCT_DESCRIPTION,
      applicationCategory: "BusinessApplication",
      publisher: { "@id": "https://storemink.com/#organization" },
      isPartOf: { "@id": "https://storemink.com/#software" },
      featureList: [...POS_FEATURES],
      offers: {
        "@type": "Offer",
        price: 2000,
        priceCurrency: "INR",
      },
    });
  });

  it("keeps the closing CTA legible and the light footer compact", () => {
    const page = readFileSync(
      join(process.cwd(), "app/platform/pos/page.tsx"),
      "utf8",
    );
    const css = readFileSync(
      join(process.cwd(), "app/platform/platform.css"),
      "utf8",
    );

    expect(page).toMatch(
      /href=\{PLATFORM_URL\}\s+className="stq-btn stq-btn-outline"[\s\S]*?Back to StoreMink/,
    );
    expect(page).toContain('className="stq-footer stq-footer-compact"');
    expect(page).toContain('type="application/ld+json"');
    expect(css).toMatch(
      /\.stq-footer-simple \.stq-logo\s*\{[\s\S]*?color: var\(--stq-ink\)/,
    );
    expect(css).toMatch(
      /\.stq-footer-simple p\s*\{[\s\S]*?color: var\(--stq-muted\)/,
    );
  });
});
