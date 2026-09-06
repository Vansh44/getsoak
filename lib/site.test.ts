import { describe, it, expect, vi } from "vitest";

// lib/site.ts imports the DB-backed store resolver for getStoreUrl(); stub it so
// this stays a pure unit test of storeOrigin().
vi.mock("@/lib/store/resolve", () => ({
  getCurrentStore: vi.fn(),
  lookupStoreById: vi.fn(),
}));

import { lookupStoreById } from "@/lib/store/resolve";
import { getStoreOriginById, storeOrigin } from "./site";

const base = {
  slug: "acme",
  custom_domain: null,
  settings: {},
  plan: "pro",
  plan_expires_at: null,
  comp_plan: null,
  comp_expires_at: null,
};

describe("storeOrigin", () => {
  it("uses the store subdomain when there is no custom domain", () => {
    expect(storeOrigin(base)).toBe("https://acme.storemink.com");
  });

  // THE regression this function exists for. saveCustomDomain writes
  // custom_domain while clearing custom_domain_verified, so every merchant sits
  // in this state between typing a domain and finishing DNS. Emitting canonicals
  // on that host points Google at a domain we do not serve — which deindexed
  // wholesip.storemink.com entirely.
  it("ignores an UNVERIFIED custom domain and stays on the subdomain", () => {
    expect(
      storeOrigin({ ...base, custom_domain: "wholesip.com", settings: {} }),
    ).toBe("https://acme.storemink.com");
  });

  it("ignores a custom domain whose verified flag is not literally true", () => {
    for (const v of ["true", 1, false, null, undefined]) {
      expect(
        storeOrigin({
          ...base,
          custom_domain: "wholesip.com",
          settings: { custom_domain_verified: v },
        }),
      ).toBe("https://acme.storemink.com");
    }
  });

  it("uses the custom domain once verified", () => {
    expect(
      storeOrigin({
        ...base,
        custom_domain: "wholesip.com",
        settings: { custom_domain_verified: true },
      }),
    ).toBe("https://wholesip.com");
  });

  it("falls back to the subdomain when the custom-domain plan has expired", () => {
    expect(
      storeOrigin({
        ...base,
        custom_domain: "wholesip.com",
        settings: { custom_domain_verified: true },
        plan_expires_at: "2020-01-01T00:00:00.000Z",
      }),
    ).toBe("https://acme.storemink.com");
  });

  // A verified flag with no domain to go with it must not produce
  // "https://null" — fall back to the subdomain, which always exists.
  it("falls back to the subdomain when verified but no domain is set", () => {
    expect(
      storeOrigin({
        ...base,
        custom_domain: null,
        settings: { custom_domain_verified: true },
      }),
    ).toBe("https://acme.storemink.com");
  });
});

describe("getStoreOriginById", () => {
  it("resolves the canonical origin without depending on the request host", async () => {
    vi.mocked(lookupStoreById).mockResolvedValue({
      id: "store-1",
      name: "Acme",
      status: "active",
      ...base,
      custom_domain: "shop.acme.com",
      settings: { custom_domain_verified: true },
    });

    await expect(getStoreOriginById("store-1")).resolves.toBe(
      "https://shop.acme.com",
    );
  });
});
