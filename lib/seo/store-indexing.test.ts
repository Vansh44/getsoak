/* eslint-disable @typescript-eslint/no-explicit-any */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDbMock } from "@/app/actions/_test-helpers";

vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock("@/lib/store/launch", () => ({
  isStoreLaunched: vi.fn(() => true),
  markStoreLaunched: vi.fn(),
}));
vi.mock("@/lib/seo/search-engines", () => ({
  pingIndexNow: vi.fn(),
  submitSitemapToGoogle: vi.fn(async () => ({ ok: true, status: 204 })),
  requestGoogleSiteVerificationToken: vi.fn(async () => ({
    result: { ok: true, status: 200 },
    token: "verification-token",
  })),
  verifyGoogleSite: vi.fn(async () => ({ ok: true, status: 200 })),
  addGoogleSearchConsoleSite: vi.fn(async () => ({ ok: true, status: 204 })),
}));

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import {
  addGoogleSearchConsoleSite,
  requestGoogleSiteVerificationToken,
  submitSitemapToGoogle,
  verifyGoogleSite,
} from "@/lib/seo/search-engines";
import { ensureGoogleCoverageForStore } from "./store-indexing";

const baseStore = {
  id: "store-1",
  slug: "acme",
  name: "Acme",
  status: "active",
  plan: "pro",
  plan_expires_at: null,
  custom_domain: null,
  settings: { launched: true },
};

describe("ensureGoogleCoverageForStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(submitSitemapToGoogle).mockResolvedValue({
      ok: true,
      status: 204,
    });
  });

  it("registers a StoreMink subdomain under the configured Domain property", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[baseStore]] });

    const result = await ensureGoogleCoverageForStore("store-1");

    expect(result).toMatchObject({
      ok: true,
      origin: "https://acme.storemink.com",
    });
    expect(submitSitemapToGoogle).toHaveBeenCalledWith(
      "https://acme.storemink.com/sitemap.xml",
    );
    expect(requestGoogleSiteVerificationToken).not.toHaveBeenCalled();
  });

  it("verifies and registers a custom-domain URL-prefix property", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          {
            ...baseStore,
            custom_domain: "shop.example.com",
            settings: {
              launched: true,
              custom_domain_verified: true,
            },
          },
        ],
      ],
    });

    const result = await ensureGoogleCoverageForStore("store-1");

    expect(result).toMatchObject({
      ok: true,
      origin: "https://shop.example.com",
    });
    expect(requestGoogleSiteVerificationToken).toHaveBeenCalledWith(
      "https://shop.example.com/",
    );
    expect(verifyGoogleSite).toHaveBeenCalledWith("https://shop.example.com/");
    expect(addGoogleSearchConsoleSite).toHaveBeenCalledWith(
      "https://shop.example.com/",
    );
    expect(submitSitemapToGoogle).toHaveBeenCalledWith(
      "https://shop.example.com/sitemap.xml",
      "https://shop.example.com/",
    );
    expect(dbHolder.current.calls.set).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          settings: expect.anything(),
        }),
      ]),
    );
  });
});
