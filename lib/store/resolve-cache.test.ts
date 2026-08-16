/* eslint-disable @typescript-eslint/no-explicit-any */

import { beforeEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => ({
  host: "new-shop.storemink.com",
  rows: [] as any[],
  selects: 0,
  cache: new Map<string, any>(),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers({ host: H.host })),
}));
vi.mock("next/navigation", () => ({ notFound: vi.fn() }));
vi.mock("next/cache", () => ({
  // Model the property resolve.ts depends on: successful values are cached,
  // rejected calls are not. This pins the negative-cache regression without
  // depending on Next's on-disk cache implementation in a unit test.
  unstable_cache:
    (fn: (...args: any[]) => Promise<any>, keyParts: string[]) =>
    async (...args: any[]) => {
      const key = JSON.stringify([keyParts, args]);
      if (H.cache.has(key)) return H.cache.get(key);
      const value = await fn(...args);
      H.cache.set(key, value);
      return value;
    },
}));
vi.mock("@/lib/db/client", () => ({
  withAnon: vi.fn(async (fn: (db: any) => Promise<any>) =>
    fn({
      select: () => {
        H.selects += 1;
        return {
          from: () => ({
            where: () => ({ limit: async () => H.rows }),
          }),
        };
      },
    }),
  ),
}));

import { getCurrentStoreOrNull } from "./resolve";

beforeEach(() => {
  H.host = "new-shop.storemink.com";
  H.rows = [];
  H.selects = 0;
  H.cache.clear();
});

describe("store host cache", () => {
  it("does not cache an unknown slug, so a newly-created store is visible immediately", async () => {
    expect(await getCurrentStoreOrNull()).toBeNull();
    expect(H.selects).toBe(1);

    H.rows = [
      {
        id: "store-1",
        slug: "new-shop",
        name: "New Shop",
        status: "active",
        plan: "basic",
        plan_expires_at: null,
        custom_domain: null,
        settings: {},
      },
    ];

    expect(await getCurrentStoreOrNull()).toMatchObject({
      id: "store-1",
      slug: "new-shop",
    });
    expect(H.selects).toBe(2);
  });

  it("still caches a positive store resolution", async () => {
    H.rows = [
      {
        id: "store-1",
        slug: "new-shop",
        name: "New Shop",
        status: "active",
        plan: "basic",
        plan_expires_at: null,
        custom_domain: null,
        settings: {},
      },
    ];

    expect((await getCurrentStoreOrNull())?.id).toBe("store-1");
    expect((await getCurrentStoreOrNull())?.id).toBe("store-1");
    expect(H.selects).toBe(1);
  });
});
