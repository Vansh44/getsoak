import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ searchIndexable: false }));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers({ host: "seed.storemink.com" })),
  cookies: vi.fn(async () => new Map()),
}));
vi.mock("@/lib/store/host", () => ({
  SEARCH_INDEXABLE: true,
  isHelpHost: vi.fn(() => false),
  isPosHost: vi.fn(() => false),
  isPlatformHost: vi.fn(() => false),
  isThemesHost: vi.fn(() => false),
}));
vi.mock("@/lib/store/resolve", () => ({
  getCurrentStoreOrNull: vi.fn(async () => ({
    id: "store-1",
    settings: { launched: false },
  })),
}));
vi.mock("@/lib/store/launch", () => ({
  isStoreSearchIndexable: vi.fn(() => state.searchIndexable),
}));
vi.mock("@/lib/store/brand", () => ({
  getStoreBrand: vi.fn(async () => ({
    name: "Seed Store",
    tagline: "Theme seed",
    logoUrl: null,
  })),
}));
vi.mock("@/lib/site", () => ({
  HELP_URL: "https://help.storemink.com",
  PLATFORM_URL: "https://storemink.com",
  POS_URL: "https://pos.storemink.com",
  THEMES_URL: "https://themes.storemink.com",
  getStoreUrl: vi.fn(async () => "https://seed.storemink.com"),
  storeOrigin: vi.fn(() => "https://seed.storemink.com"),
}));
vi.mock("@/lib/seo/store-indexing", () => ({
  GOOGLE_VERIFICATION_TOKEN_KEY: "google_site_verification_token",
  normalizeGoogleVerificationToken: vi.fn(() => null),
}));

import { generateMetadata } from "@/app/(storefront)/layout";
import robots from "@/app/robots";

describe("unlaunched storefront search controls", () => {
  beforeEach(() => {
    state.searchIndexable = false;
  });

  it("emits noindex metadata for public seed pages", async () => {
    expect((await generateMetadata()).robots).toEqual({
      index: false,
      follow: false,
      nocache: true,
    });
  });

  it("lets crawlers fetch public pages to observe noindex", async () => {
    const result = await robots();

    expect(result.rules).toMatchObject({ userAgent: "*", allow: "/" });
    expect(result.rules).toHaveProperty("disallow");
    expect(result).not.toHaveProperty("sitemap");
  });

  it("does not add noindex metadata after the store launches", async () => {
    state.searchIndexable = true;

    expect((await generateMetadata()).robots).toBeUndefined();
  });
});
