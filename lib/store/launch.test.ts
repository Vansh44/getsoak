import { describe, it, expect, vi } from "vitest";

// launch.ts reaches the DB in markStoreLaunched; isStoreLaunched is pure.
vi.mock("@/lib/db/client", () => ({ withService: vi.fn() }));
vi.mock("@/lib/observability/logger", () => ({ logError: vi.fn() }));

import { isStoreLaunched } from "./launch";

describe("isStoreLaunched", () => {
  it("is false only when the flag is explicitly false", () => {
    expect(isStoreLaunched({ settings: { launched: false } })).toBe(false);
  });

  it("is true once the flag is set", () => {
    expect(isStoreLaunched({ settings: { launched: true } })).toBe(true);
  });

  /**
   * THE case that decides whether this feature is safe to ship.
   *
   * Every store created before this flag existed has no `launched` key. If
   * absence meant "not launched", deploying would have emitted
   * `Disallow: /` and an empty sitemap for every live shop on the platform —
   * deindexing real businesses to fix a problem with new ones. Absence must
   * mean launched; `createStore` writes `launched: false` explicitly, and that
   * is what makes NEW stores start closed.
   */
  it("treats a store with no flag as launched (pre-existing stores)", () => {
    expect(isStoreLaunched({ settings: {} })).toBe(true);
    expect(isStoreLaunched({ settings: { template: "basket" } })).toBe(true);
  });

  it("does not treat a truthy-but-not-false value as unlaunched", () => {
    // Only `false` closes a store. A stray string/0 must not silently hide a
    // merchant's shop from search.
    for (const v of ["false", 0, null, undefined]) {
      expect(isStoreLaunched({ settings: { launched: v } })).toBe(true);
    }
  });

  it("is false for a missing store", () => {
    expect(isStoreLaunched(null)).toBe(false);
    expect(isStoreLaunched(undefined)).toBe(false);
  });
});
