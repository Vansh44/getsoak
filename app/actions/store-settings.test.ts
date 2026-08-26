/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock } from "./_test-helpers";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  // lib/store/resolve (imported for STORE_TAG) wraps its lookups at module
  // load — pass the function through untouched.
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock("@/app/dashboard/lib/access", () => ({
  getManagerUserId: vi.fn(),
  getActingStoreId: vi.fn(async () => "store-1"),
  getViewerContext: vi.fn(),
}));

// The ported data layer: with* runners invoke the callback with the mock db.
const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withUser: vi.fn((_identity: any, fn: any) =>
    Promise.resolve(fn(dbHolder.current.db)),
  ),
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
  withAnon: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import { revalidateTag } from "next/cache";
import { getViewerContext } from "@/app/dashboard/lib/access";
import { getStoreSettingsForEditor, saveStoreSettings } from "./store-settings";

// The stores row read (select #1) in the snake_case shape effectivePlan expects.
function useStoreRow(storeRow: any) {
  dbHolder.current = makeDbMock({ selectQueue: [[storeRow]] });
}

describe("store-settings actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useStoreRow({ settings: {}, plan: "basic", plan_expires_at: null });
    vi.mocked(getViewerContext).mockResolvedValue({
      userId: "user-1",
      userEmail: "a@b.c",
      profile: { email: "a@b.c", role: "superadmin" },
      isSuperadmin: true,
      permissions: {},
      storeId: "store-1",
      isPlatformAdmin: false,
    } as any);
  });

  describe("getStoreSettingsForEditor", () => {
    it("returns the catalog with resolved values", async () => {
      useStoreRow({
        settings: { features: { "blogs.customerSubmissions": false } },
        plan: "basic",
        plan_expires_at: null,
      });

      const { settings } = await getStoreSettingsForEditor();
      const byKey = Object.fromEntries(settings.map((s) => [s.key, s]));
      expect(byKey["blogs.customerSubmissions"].value).toBe(false);
      expect(byKey["blogs.requireApproval"].value).toBe(true); // default
      expect(byKey["blogs.requireApproval"].dependsOn).toBe(
        "blogs.customerSubmissions",
      );
    });

    it("returns an empty catalog without a viewer profile", async () => {
      vi.mocked(getViewerContext).mockResolvedValue(null as any);
      const { settings } = await getStoreSettingsForEditor();
      expect(settings).toEqual([]);
    });

    // Each setting is gated by ITS OWN section — no permissions, no catalog.
    it("returns an empty catalog without view permission on any section", async () => {
      vi.mocked(getViewerContext).mockResolvedValue({
        profile: { email: "a@b.c", role: "editor" },
        isSuperadmin: false,
        permissions: { products: ["view"] }, // no blogs access
        storeId: "store-1",
      } as any);
      const { settings } = await getStoreSettingsForEditor();
      expect(settings).toEqual([]);
    });

    // Blog settings live with the blogs feature: blogs.view is enough.
    it("shows a group's settings to viewers of its owning section", async () => {
      vi.mocked(getViewerContext).mockResolvedValue({
        profile: { email: "a@b.c", role: "editor" },
        isSuperadmin: false,
        permissions: { blogs: ["view"] },
        storeId: "store-1",
      } as any);
      const { settings } = await getStoreSettingsForEditor("Blogs");
      expect(settings.map((s) => s.key)).toContain("blogs.customerSubmissions");
    });

    it("filters to the requested group", async () => {
      const { settings } = await getStoreSettingsForEditor("Nope");
      expect(settings).toEqual([]);
    });
  });

  describe("saveStoreSettings", () => {
    it("rejects unauthenticated callers", async () => {
      vi.mocked(getViewerContext).mockResolvedValue(null as any);
      const r = await saveStoreSettings({ "blogs.customerSubmissions": false });
      expect(r.error).toMatch(/not authenticated/i);
    });

    // Saving a setting requires manage on ITS owning section (blogs here).
    it("rejects callers without manage on the owning section", async () => {
      vi.mocked(getViewerContext).mockResolvedValue({
        profile: { email: "a@b.c", role: "editor" },
        isSuperadmin: false,
        permissions: { blogs: ["view"] }, // view only
        storeId: "store-1",
      } as any);
      const r = await saveStoreSettings({ "blogs.customerSubmissions": false });
      expect(r.error).toMatch(/permission/i);
      expect(dbHolder.current.calls.update).toHaveLength(0);
    });

    it("allows blogs managers to save blog settings", async () => {
      vi.mocked(getViewerContext).mockResolvedValue({
        profile: { email: "a@b.c", role: "editor" },
        isSuperadmin: false,
        permissions: { blogs: ["view", "manage"] },
        storeId: "store-1",
      } as any);
      const r = await saveStoreSettings({ "blogs.customerSubmissions": false });
      expect(r.success).toBe(true);
    });

    it("writes registry keys into settings.features and busts the store cache", async () => {
      const r = await saveStoreSettings({
        "blogs.customerSubmissions": false,
        "blogs.requireApproval": true,
      });
      expect(r.success).toBe(true);

      const updateArg = dbHolder.current.calls.set[0];
      expect(updateArg.settings.features).toMatchObject({
        "blogs.customerSubmissions": false,
        "blogs.requireApproval": true,
      });
      expect(revalidateTag).toHaveBeenCalled();
    });

    it("ignores unknown keys and invalid typed values", async () => {
      await saveStoreSettings({
        "blogs.customerSubmissions": false,
        "made.up": true,
        "blogs.requireApproval": "yes" as any,
        "inventory.lowStockThreshold": "10" as any,
      });

      const updateArg = dbHolder.current.calls.set[0];
      expect(updateArg.settings.features).toEqual({
        "blogs.customerSubmissions": false,
      });
    });

    it("saves numeric values and clamps to min/max", async () => {
      const r = await saveStoreSettings({
        "inventory.lowStockThreshold": 1500, // max is 1000
      });
      expect(r.success).toBe(true);

      const updateArg = dbHolder.current.calls.set[0];
      expect(updateArg.settings.features).toMatchObject({
        "inventory.lowStockThreshold": 1000,
      });
    });

    it("preserves unrelated settings (e.g. brand) when saving", async () => {
      useStoreRow({
        settings: {
          brand: { name: "Acme" },
          features: { "blogs.requireApproval": false },
        },
        plan: "basic",
        plan_expires_at: null,
      });

      await saveStoreSettings({ "blogs.customerSubmissions": false });

      const updateArg = dbHolder.current.calls.set[0];
      expect(updateArg.settings.brand).toEqual({ name: "Acme" });
      // Existing feature overrides survive a partial save.
      expect(updateArg.settings.features["blogs.requireApproval"]).toBe(false);
      expect(updateArg.settings.features["blogs.customerSubmissions"]).toBe(
        false,
      );
    });

    it("surfaces a read failure", async () => {
      dbHolder.current = makeDbMock();
      dbHolder.current.db.select = vi.fn(() => {
        throw new Error("boom");
      });
      const r = await saveStoreSettings({ "blogs.customerSubmissions": true });
      expect(r.error).toMatch(/could not load/i);
    });

    it("does not overwrite a paid setting while the store is downgraded", async () => {
      useStoreRow({
        settings: {
          features: { "blogs.customerSubmissions": true },
        },
        plan: "free",
        plan_expires_at: null,
      });

      await saveStoreSettings({ "blogs.customerSubmissions": false });

      expect(
        dbHolder.current.calls.set[0].settings.features[
          "blogs.customerSubmissions"
        ],
      ).toBe(true);
    });
  });
});
