/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock, sqlParamValues } from "./_test-helpers";

vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
  // STORE_TAG comes from lib/store/resolve, which builds a cached lookup at
  // module load.
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock("@/app/dashboard/lib/access", () => ({
  getManagerUserId: vi.fn(),
  getActingStoreId: vi.fn(async () => "store-1"),
}));

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withUser: vi.fn((_i: any, fn: any) =>
    Promise.resolve(fn(dbHolder.current.db)),
  ),
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
  withAnon: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import {
  getStoreBrandingForEditor,
  saveStoreBranding,
  saveBrandAppearance,
} from "./store-branding";
import { getManagerUserId } from "@/app/dashboard/lib/access";
import { revalidateTag } from "next/cache";
import { STORE_TAG } from "@/lib/store/resolve";
import { stores } from "@/drizzle/schema";

/** A select chain that rejects when awaited — a real pool failure's shape. */
function rejectingSelect() {
  return vi.fn(() => {
    const s: any = {
      from: () => s,
      where: () => s,
      limit: () => Promise.reject(new Error("read failed")),
    };
    return s;
  });
}

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

// store-branding.ts owns per-store brand identity (name, logo, colours, contact,
// social). saveStoreBranding rebuilds the whole brand object from a full
// FormData; saveBrandAppearance is a deliberate PATCH for the builder's
// two-field Brand panel (§11).
describe("store-branding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbHolder.current = makeDbMock();
    vi.mocked(getManagerUserId).mockResolvedValue("admin-1");
  });

  describe("getStoreBrandingForEditor", () => {
    it("builds the brand from the store's settings", async () => {
      dbHolder.current = makeDbMock({
        selectQueue: [
          [
            {
              name: "Acme",
              settings: { brand: { tagline: "We sell things" } },
              slug: "acme",
              custom_domain: null,
            },
          ],
        ],
      });

      const brand = await getStoreBrandingForEditor();

      expect(brand.name).toBe("Acme");
      expect(brand.tagline).toBe("We sell things");
    });

    it("prefers a custom domain over the subdomain", async () => {
      dbHolder.current = makeDbMock({
        selectQueue: [
          [
            {
              name: "Acme",
              settings: {},
              slug: "acme",
              custom_domain: "acme.com",
            },
          ],
        ],
      });

      const brand = await getStoreBrandingForEditor();

      expect(brand.domain).toBe("acme.com");
    });

    it("falls back to the {slug}.{root} subdomain when no custom domain is set", async () => {
      dbHolder.current = makeDbMock({
        selectQueue: [
          [{ name: "Acme", settings: {}, slug: "acme", custom_domain: null }],
        ],
      });

      const brand = await getStoreBrandingForEditor();

      expect(brand.domain).toMatch(/^acme\./);
    });

    it("treats an empty-string custom domain as unset", async () => {
      dbHolder.current = makeDbMock({
        selectQueue: [
          [{ name: "Acme", settings: {}, slug: "acme", custom_domain: "" }],
        ],
      });

      const brand = await getStoreBrandingForEditor();

      expect(brand.domain).toMatch(/^acme\./);
    });

    it("returns usable placeholder branding when the store row is missing", async () => {
      // The editor must still render — an exception here would break the page.
      dbHolder.current = makeDbMock({ selectQueue: [[]] });

      const brand = await getStoreBrandingForEditor();

      expect(brand.name).toBe("Store");
      expect(brand.domain).toMatch(/^store\./);
    });

    it("returns placeholder branding instead of throwing when the read fails", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      dbHolder.current = makeDbMock();
      dbHolder.current.db.select = rejectingSelect();

      const brand = await getStoreBrandingForEditor();

      expect(brand.name).toBe("Store");
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });

    it("scopes the lookup to the acting store", async () => {
      dbHolder.current = makeDbMock({ selectQueue: [[]] });

      await getStoreBrandingForEditor();

      expect(sqlParamValues(dbHolder.current.calls.where[0])).toContain(
        "store-1",
      );
    });
  });

  describe("saveStoreBranding", () => {
    it("requires a store name", async () => {
      const result = await saveStoreBranding(form({ name: "   " }));

      expect(result.error).toMatch(/store name is required/i);
      expect(dbHolder.current.calls.update).toHaveLength(0);
    });

    it("requires a name to be present at all", async () => {
      const result = await saveStoreBranding(new FormData());

      expect(result.error).toMatch(/store name is required/i);
    });

    it("saves the brand and the store name together", async () => {
      dbHolder.current = makeDbMock({ selectQueue: [[{ settings: {} }]] });

      const result = await saveStoreBranding(
        form({ name: "  Acme  ", tagline: "Fresh", primaryColor: "#123456" }),
      );

      expect(result.success).toBe(true);
      expect(dbHolder.current.calls.update[0]).toBe(stores);
      const set = dbHolder.current.calls.set[0];
      expect(set.name).toBe("Acme");
      expect((set.settings as any).brand).toMatchObject({
        name: "Acme",
        tagline: "Fresh",
        primaryColor: "#123456",
      });
    });

    it("preserves unrelated settings keys", async () => {
      // settings holds features, business location, domain flags — a branding
      // save that dropped them would silently reset the store.
      dbHolder.current = makeDbMock({
        selectQueue: [
          [{ settings: { features: { x: true }, launched: true } }],
        ],
      });

      await saveStoreBranding(form({ name: "Acme" }));

      const settings = dbHolder.current.calls.set[0].settings as any;
      expect(settings.features).toEqual({ x: true });
      expect(settings.launched).toBe(true);
    });

    it("preserves brand fields the editor does not expose", async () => {
      dbHolder.current = makeDbMock({
        selectQueue: [[{ settings: { brand: { badges: ["organic"] } } }]],
      });

      await saveStoreBranding(form({ name: "Acme" }));

      expect(
        (dbHolder.current.calls.set[0].settings as any).brand.badges,
      ).toEqual(["organic"]);
    });

    it("defaults the primary colour when none is supplied", async () => {
      dbHolder.current = makeDbMock({ selectQueue: [[{ settings: {} }]] });

      await saveStoreBranding(form({ name: "Acme" }));

      expect(
        (dbHolder.current.calls.set[0].settings as any).brand.primaryColor,
      ).toBe("#1f7a5a");
    });

    it("stores blank optional fields as null rather than empty strings", async () => {
      dbHolder.current = makeDbMock({ selectQueue: [[{ settings: {} }]] });

      await saveStoreBranding(form({ name: "Acme", tagline: "  ", email: "" }));

      const brand = (dbHolder.current.calls.set[0].settings as any).brand;
      expect(brand.tagline).toBeNull();
      expect(brand.email).toBeNull();
    });

    it("nests the social handles under social", async () => {
      dbHolder.current = makeDbMock({ selectQueue: [[{ settings: {} }]] });

      await saveStoreBranding(
        form({
          name: "Acme",
          instagram: "@acme",
          youtube: "",
          whatsapp: "123",
        }),
      );

      expect(
        (dbHolder.current.calls.set[0].settings as any).brand.social,
      ).toEqual({ instagram: "@acme", youtube: null, whatsapp: "123" });
    });

    it("treats a store with no settings at all as an empty object", async () => {
      dbHolder.current = makeDbMock({ selectQueue: [[{ settings: null }]] });

      const result = await saveStoreBranding(form({ name: "Acme" }));

      expect(result.success).toBe(true);
    });

    it("treats a missing store row as empty settings", async () => {
      dbHolder.current = makeDbMock({ selectQueue: [[]] });

      const result = await saveStoreBranding(form({ name: "Acme" }));

      expect(result.success).toBe(true);
    });

    it("aborts without writing when the settings read fails", async () => {
      // Writing here would clobber every other settings key with an empty
      // object, because the merge base was never loaded.
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      dbHolder.current = makeDbMock();
      dbHolder.current.db.select = rejectingSelect();

      const result = await saveStoreBranding(form({ name: "Acme" }));

      expect(result.error).toMatch(/could not save branding/i);
      expect(dbHolder.current.calls.update).toHaveLength(0);
      spy.mockRestore();
    });

    it("busts the store cache so the storefront re-skins at once", async () => {
      dbHolder.current = makeDbMock({ selectQueue: [[{ settings: {} }]] });

      await saveStoreBranding(form({ name: "Acme" }));

      expect(revalidateTag).toHaveBeenCalledWith(STORE_TAG, "max");
    });

    it("returns an error and skips revalidation when the write fails", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      dbHolder.current = makeDbMock({
        selectQueue: [[{ settings: {} }]],
        failUpdateFor: [stores],
      });

      const result = await saveStoreBranding(form({ name: "Acme" }));

      expect(result.error).toMatch(/could not save branding/i);
      expect(revalidateTag).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it("logs a non-Error write rejection as-is", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      dbHolder.current = makeDbMock({ selectQueue: [[{ settings: {} }]] });
      dbHolder.current.db.update = vi.fn(() => {
        throw "deadlock";
      });

      const result = await saveStoreBranding(form({ name: "Acme" }));

      expect(result.error).toMatch(/could not save branding/i);
      expect(spy).toHaveBeenCalledWith("saveStoreBranding:", "deadlock");
      spy.mockRestore();
    });
  });

  describe("saveBrandAppearance", () => {
    it("rejects a caller without the builder permission", async () => {
      vi.mocked(getManagerUserId).mockResolvedValue(null);

      const result = await saveBrandAppearance({ primaryColor: "#123456" });

      expect(result.error).toMatch(/not authenticated/i);
      expect(dbHolder.current.calls.update).toHaveLength(0);
    });

    it("PATCHES rather than rebuilding — it must not blank contact details", async () => {
      // The whole reason this exists instead of calling saveStoreBranding from
      // a two-field panel.
      dbHolder.current = makeDbMock({
        selectQueue: [
          [
            {
              settings: {
                brand: {
                  email: "hi@acme.com",
                  legalName: "Acme Pvt Ltd",
                  social: { instagram: "@acme" },
                },
              },
            },
          ],
        ],
      });

      await saveBrandAppearance({ primaryColor: "#abcdef" });

      const brand = (dbHolder.current.calls.set[0].settings as any).brand;
      expect(brand.email).toBe("hi@acme.com");
      expect(brand.legalName).toBe("Acme Pvt Ltd");
      expect(brand.social).toEqual({ instagram: "@acme" });
      expect(brand.primaryColor).toBe("#abcdef");
    });

    it("does not touch the store name", async () => {
      dbHolder.current = makeDbMock({ selectQueue: [[{ settings: {} }]] });

      await saveBrandAppearance({ primaryColor: "#abcdef" });

      expect(dbHolder.current.calls.set[0]).not.toHaveProperty("name");
    });

    it("drops a colour that is not a 6-digit hex", async () => {
      // It renders into an inline style attribute, so validate rather than
      // trust.
      dbHolder.current = makeDbMock({
        selectQueue: [[{ settings: { brand: { primaryColor: "#111111" } } }]],
      });

      await saveBrandAppearance({ primaryColor: "red; background:url(x)" });

      expect(
        (dbHolder.current.calls.set[0].settings as any).brand.primaryColor,
      ).toBe("#111111");
    });

    it("drops a 3-digit shorthand hex", async () => {
      dbHolder.current = makeDbMock({
        selectQueue: [[{ settings: { brand: { primaryColor: "#111111" } } }]],
      });

      await saveBrandAppearance({ primaryColor: "#abc" });

      expect(
        (dbHolder.current.calls.set[0].settings as any).brand.primaryColor,
      ).toBe("#111111");
    });

    it("accepts uppercase hex", async () => {
      dbHolder.current = makeDbMock({ selectQueue: [[{ settings: {} }]] });

      await saveBrandAppearance({ primaryColor: "#ABCDEF" });

      expect(
        (dbHolder.current.calls.set[0].settings as any).brand.primaryColor,
      ).toBe("#ABCDEF");
    });

    it("leaves the colour alone when none is supplied", async () => {
      dbHolder.current = makeDbMock({
        selectQueue: [[{ settings: { brand: { primaryColor: "#111111" } } }]],
      });

      await saveBrandAppearance({ logoUrl: "https://cdn/x.webp" });

      expect(
        (dbHolder.current.calls.set[0].settings as any).brand.primaryColor,
      ).toBe("#111111");
    });

    it("sets the logo when given one", async () => {
      dbHolder.current = makeDbMock({ selectQueue: [[{ settings: {} }]] });

      await saveBrandAppearance({ logoUrl: "https://cdn/logo.webp" });

      expect(
        (dbHolder.current.calls.set[0].settings as any).brand.logoUrl,
      ).toBe("https://cdn/logo.webp");
    });

    it("clears the logo when given an explicit null", async () => {
      dbHolder.current = makeDbMock({
        selectQueue: [
          [{ settings: { brand: { logoUrl: "https://cdn/o.webp" } } }],
        ],
      });

      await saveBrandAppearance({ logoUrl: null });

      expect(
        (dbHolder.current.calls.set[0].settings as any).brand.logoUrl,
      ).toBeNull();
    });

    it("clears the logo when given an empty string", async () => {
      dbHolder.current = makeDbMock({
        selectQueue: [
          [{ settings: { brand: { logoUrl: "https://cdn/o.webp" } } }],
        ],
      });

      await saveBrandAppearance({ logoUrl: "" });

      expect(
        (dbHolder.current.calls.set[0].settings as any).brand.logoUrl,
      ).toBeNull();
    });

    it("distinguishes an omitted logo from an explicit null", async () => {
      dbHolder.current = makeDbMock({
        selectQueue: [
          [{ settings: { brand: { logoUrl: "https://cdn/keep.webp" } } }],
        ],
      });

      await saveBrandAppearance({ primaryColor: "#abcdef" });

      expect(
        (dbHolder.current.calls.set[0].settings as any).brand.logoUrl,
      ).toBe("https://cdn/keep.webp");
    });

    it("preserves unrelated settings keys", async () => {
      dbHolder.current = makeDbMock({
        selectQueue: [[{ settings: { features: { y: 1 } } }]],
      });

      await saveBrandAppearance({ primaryColor: "#abcdef" });

      expect((dbHolder.current.calls.set[0].settings as any).features).toEqual({
        y: 1,
      });
    });

    it("handles a store with no settings at all", async () => {
      dbHolder.current = makeDbMock({ selectQueue: [[{ settings: null }]] });

      const result = await saveBrandAppearance({ primaryColor: "#abcdef" });

      expect(result.success).toBe(true);
    });

    it("handles a missing store row", async () => {
      dbHolder.current = makeDbMock({ selectQueue: [[]] });

      const result = await saveBrandAppearance({ primaryColor: "#abcdef" });

      expect(result.success).toBe(true);
    });

    it("aborts without writing when the settings read fails", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      dbHolder.current = makeDbMock();
      dbHolder.current.db.select = rejectingSelect();

      const result = await saveBrandAppearance({ primaryColor: "#abcdef" });

      expect(result.error).toMatch(/could not save/i);
      expect(dbHolder.current.calls.update).toHaveLength(0);
      spy.mockRestore();
    });

    it("busts the store cache on success", async () => {
      dbHolder.current = makeDbMock({ selectQueue: [[{ settings: {} }]] });

      await saveBrandAppearance({ primaryColor: "#abcdef" });

      expect(revalidateTag).toHaveBeenCalledWith(STORE_TAG, "max");
    });

    it("returns an error and skips revalidation when the write fails", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      dbHolder.current = makeDbMock({
        selectQueue: [[{ settings: {} }]],
        failUpdateFor: [stores],
      });

      const result = await saveBrandAppearance({ primaryColor: "#abcdef" });

      expect(result.error).toMatch(/could not save/i);
      expect(revalidateTag).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });
});
