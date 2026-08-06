/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock, sqlParamValues } from "./_test-helpers";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));
vi.mock("@/app/dashboard/lib/access", () => ({
  getManagerUserId: vi.fn(),
  getActingStoreId: vi.fn(async () => "a0000000-0000-4000-8000-000000000001"),
}));

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withUser: vi.fn((_identity: any, fn: any) =>
    Promise.resolve(fn(dbHolder.current.db)),
  ),
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
  withAnon: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import { getStoreMenusForEditor, saveStoreMenus } from "./menu-actions";
import { getManagerUserId } from "@/app/dashboard/lib/access";
import { revalidatePath, revalidateTag } from "next/cache";
import { DEFAULT_MENUS } from "@/lib/menus";
import { TAGS } from "@/lib/storefront/tags";
import { storeMenus } from "@/drizzle/schema";

const STORE = "a0000000-0000-4000-8000-000000000001";

// menu-actions.ts is the admin read/write side of per-store navigation
// (store_menus). The storefront reads the same row through the cached
// getStoreMenus. Gated on the `navigation` permission section.
describe("menu-actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbHolder.current = makeDbMock();
    vi.mocked(getManagerUserId).mockResolvedValue("user-1");
  });

  describe("getStoreMenusForEditor", () => {
    it("returns the store's saved menus", async () => {
      dbHolder.current = makeDbMock({
        selectQueue: [
          [
            {
              header: [{ label: "Shop", href: "/shop" }],
              footer_groups: [
                { title: "Help", links: [{ label: "FAQ", href: "/faqs" }] },
              ],
              footer_legal: [{ label: "Terms", href: "/terms" }],
            },
          ],
        ],
      });

      const menus = await getStoreMenusForEditor();

      expect(menus.header).toEqual([{ label: "Shop", href: "/shop" }]);
      expect(menus.footerGroups).toEqual([
        { title: "Help", links: [{ label: "FAQ", href: "/faqs" }] },
      ]);
      expect(menus.footerLegal).toEqual([{ label: "Terms", href: "/terms" }]);
    });

    it("reads the snake_case columns the row actually stores", async () => {
      // The select aliases footer_groups/footer_legal, and normalizeMenus
      // accepts either casing — if it only read camelCase, every store's footer
      // would silently render the platform defaults.
      dbHolder.current = makeDbMock({
        selectQueue: [
          [
            {
              header: [],
              footer_groups: [
                { title: "Mine", links: [{ label: "A", href: "/a" }] },
              ],
              footer_legal: [],
            },
          ],
        ],
      });

      const menus = await getStoreMenusForEditor();

      expect(menus.footerGroups[0].title).toBe("Mine");
    });

    it("falls back to DEFAULT_MENUS when the store has no row yet", async () => {
      dbHolder.current = makeDbMock({ selectQueue: [[]] });

      const menus = await getStoreMenusForEditor();

      expect(menus).toEqual(DEFAULT_MENUS);
    });

    it("falls back to DEFAULT_MENUS for a row whose fields are empty", async () => {
      // An editor that opens with no nav at all is unusable, so a stored empty
      // reads as "unset" here even though saving an empty is allowed.
      dbHolder.current = makeDbMock({
        selectQueue: [[{ header: [], footer_groups: [], footer_legal: [] }]],
      });

      const menus = await getStoreMenusForEditor();

      expect(menus).toEqual(DEFAULT_MENUS);
    });

    it("returns defaults instead of throwing when the query fails", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      dbHolder.current = makeDbMock();
      dbHolder.current.db.select = vi.fn(() => {
        throw new Error("connection reset");
      });

      const menus = await getStoreMenusForEditor();

      expect(menus).toEqual(DEFAULT_MENUS);
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });

    it("logs a non-Error throw as-is rather than reading .message off it", async () => {
      // A rejection is not guaranteed to be an Error — a driver can reject with
      // a string or a plain object, and reading `.message` off one logs
      // undefined, erasing the only record of what went wrong.
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      dbHolder.current = makeDbMock();
      dbHolder.current.db.select = vi.fn(() => {
        throw "ECONNRESET";
      });

      const menus = await getStoreMenusForEditor();

      expect(menus).toEqual(DEFAULT_MENUS);
      expect(spy).toHaveBeenCalledWith("getStoreMenusForEditor:", "ECONNRESET");
      spy.mockRestore();
    });

    it("scopes the lookup to the acting store", async () => {
      dbHolder.current = makeDbMock({ selectQueue: [[]] });

      await getStoreMenusForEditor();

      expect(dbHolder.current.calls.where.length).toBeGreaterThan(0);
      expect(sqlParamValues(dbHolder.current.calls.where[0])).toContain(STORE);
    });
  });

  describe("saveStoreMenus", () => {
    const validMenus = {
      header: [{ label: "Shop", href: "/shop" }],
      footerGroups: [
        { title: "Company", links: [{ label: "About", href: "/about" }] },
      ],
      footerLegal: [{ label: "Terms", href: "/terms" }],
    };

    it("rejects a caller without navigation.manage", async () => {
      vi.mocked(getManagerUserId).mockResolvedValue(null);

      const result = await saveStoreMenus(validMenus);

      expect(result.error).toMatch(/not authorized/i);
      expect(dbHolder.current.calls.insert).toHaveLength(0);
    });

    it("does not revalidate anything when unauthorized", async () => {
      vi.mocked(getManagerUserId).mockResolvedValue(null);

      await saveStoreMenus(validMenus);

      expect(revalidateTag).not.toHaveBeenCalled();
      expect(revalidatePath).not.toHaveBeenCalled();
    });

    it("upserts keyed on store_id (one menu row per store)", async () => {
      const result = await saveStoreMenus(validMenus);

      expect(result.success).toBe(true);
      expect(dbHolder.current.calls.insert[0]).toBe(storeMenus);
      expect(dbHolder.current.calls.values[0]).toMatchObject({
        storeId: STORE,
        header: validMenus.header,
      });
      expect(dbHolder.current.calls.onConflict[0]).toMatchObject({
        target: storeMenus.storeId,
      });
    });

    it("stamps the editing admin on the row", async () => {
      vi.mocked(getManagerUserId).mockResolvedValue("admin-42");

      await saveStoreMenus(validMenus);

      expect(dbHolder.current.calls.values[0].updatedBy).toBe("admin-42");
    });

    it("writes the same fields on insert and on conflict", async () => {
      // A divergence here means the FIRST save of a store's nav sticks and
      // every subsequent one silently drops a field.
      await saveStoreMenus(validMenus);

      const inserted = { ...dbHolder.current.calls.values[0] };
      delete (inserted as any).storeId;
      expect(dbHolder.current.calls.onConflict[0].set).toEqual(inserted);
    });

    it("drops links missing a label or href before saving", async () => {
      await saveStoreMenus({
        header: [
          { label: "Shop", href: "/shop" },
          { label: "", href: "/nowhere" },
          { label: "No target", href: "" },
          "not an object",
        ],
        footerGroups: [],
        footerLegal: [],
      });

      expect(dbHolder.current.calls.values[0].header).toEqual([
        { label: "Shop", href: "/shop" },
      ]);
    });

    it("preserves an explicit empty rather than restoring defaults", async () => {
      // sanitizeMenusForSave, not normalizeMenus: deleting your last footer
      // column has to be an edit that actually sticks.
      await saveStoreMenus({
        header: [],
        footerGroups: [],
        footerLegal: [],
      });

      expect(dbHolder.current.calls.values[0].header).toEqual([]);
      expect(dbHolder.current.calls.values[0].footerGroups).toEqual([]);
      expect(dbHolder.current.calls.values[0].footerLegal).toEqual([]);
    });

    it("coerces junk input to empty menus instead of throwing", async () => {
      const result = await saveStoreMenus(null);

      expect(result.success).toBe(true);
      expect(dbHolder.current.calls.values[0].header).toEqual([]);
    });

    it("revalidates the menus tag and the whole layout on success", async () => {
      await saveStoreMenus(validMenus);

      expect(revalidateTag).toHaveBeenCalledWith(TAGS.menus, "max");
      // Header/footer render on every storefront route, so the path bust is
      // layout-wide rather than per-page.
      expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
    });

    it("returns an error and skips revalidation when the write fails", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      dbHolder.current = makeDbMock({ failInsertFor: [storeMenus] });

      const result = await saveStoreMenus(validMenus);

      expect(result.error).toMatch(/could not save/i);
      expect(result.success).toBeUndefined();
      expect(revalidateTag).not.toHaveBeenCalled();
      expect(revalidatePath).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it("logs a non-Error write rejection as-is", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      dbHolder.current = makeDbMock();
      dbHolder.current.db.insert = vi.fn(() => {
        throw "deadlock detected";
      });

      const result = await saveStoreMenus(validMenus);

      expect(result.error).toMatch(/could not save/i);
      expect(spy).toHaveBeenCalledWith(
        "saveStoreMenus error:",
        "deadlock detected",
      );
      spy.mockRestore();
    });
  });
});
