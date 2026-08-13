/* eslint-disable @typescript-eslint/no-explicit-any */
// StoreMink's own tax identity.
//
// Everything here writes a value that ends up printed on a GST tax invoice, and
// finalized invoices are IMMUTABLE — so a bad value cannot be corrected later,
// only stopped from being stored. That is what these tests are for.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock } from "@/app/actions/_test-helpers";

vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (fn: any) => fn(dbHolder.current.db)),
}));

import {
  DEFAULT_TAX_SETTINGS,
  getPlatformTaxSettings,
  savePlatformTaxSettings,
  type TaxSettingsInput,
} from "./platform-settings";

/** A real-shaped Delhi GSTIN (state 07). */
const GSTIN_07 = "07AABCS1429B1ZX";
/** Same shape, Karnataka (state 29). */
const GSTIN_29 = "29AABCS1429B1ZX";

function input(over: Partial<TaxSettingsInput> = {}): TaxSettingsInput {
  return {
    legalName: "StoreMink Technologies Pvt Ltd",
    gstin: GSTIN_07,
    addressLine1: "1 Example Road",
    addressLine2: "",
    city: "New Delhi",
    postalCode: "110001",
    stateCode: "07",
    taxEnabled: true,
    taxRatePercent: 18,
    taxInclusive: false,
    invoicePrefix: "SM",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbHolder.current = makeDbMock({ selectQueue: [] });
});

describe("savePlatformTaxSettings", () => {
  it("stores a valid configuration", async () => {
    const res = await savePlatformTaxSettings(input(), "op@storemink.com");
    expect(res.ok).toBe(true);
    const values = dbHolder.current.calls.values[0];
    expect(values).toMatchObject({
      gstin: GSTIN_07,
      stateCode: "07",
      taxEnabled: true,
      invoicePrefix: "SM",
    });
  });

  it("★ stores the rate in BASIS POINTS, so no float touches a tax rate", async () => {
    await savePlatformTaxSettings(input({ taxRatePercent: 18 }), null);
    expect(dbHolder.current.calls.values[0].taxRateBps).toBe(1800);
  });

  it("★ handles a fractional rate without drift", async () => {
    await savePlatformTaxSettings(input({ taxRatePercent: 2.5 }), null);
    expect(dbHolder.current.calls.values[0].taxRateBps).toBe(250);
  });

  describe("★★ enabling tax", () => {
    it("REFUSES without a GSTIN — mirrors the DB CHECK", async () => {
      // An invoice charging GST while naming no GSTIN is not a valid tax
      // invoice, and the merchant cannot claim input credit against it.
      const res = await savePlatformTaxSettings(
        input({ gstin: "", taxEnabled: true }),
        null,
      );
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error).toMatch(/GSTIN/i);
      expect(dbHolder.current.calls.insert.length).toBe(0);
    });

    it("★ REFUSES without a state — it decides CGST+SGST vs IGST", async () => {
      const res = await savePlatformTaxSettings(
        input({ stateCode: "", taxEnabled: true }),
        null,
      );
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error).toMatch(/state/i);
      expect(dbHolder.current.calls.insert.length).toBe(0);
    });

    it("★ REFUSES without a legal name — it is who the invoice is issued by", async () => {
      const res = await savePlatformTaxSettings(
        input({ legalName: "  ", taxEnabled: true }),
        null,
      );
      expect(res.ok).toBe(false);
      expect(dbHolder.current.calls.insert.length).toBe(0);
    });

    it("★ but ALLOWS saving those fields with tax still OFF", async () => {
      // Filling in the identity before the GSTIN arrives is the ordinary path.
      const res = await savePlatformTaxSettings(
        input({ gstin: "", stateCode: "", taxEnabled: false }),
        null,
      );
      expect(res.ok).toBe(true);
    });
  });

  describe("★★ the GSTIN carries the state", () => {
    it("REFUSES a GSTIN whose state contradicts the one selected", async () => {
      // One of the two is a typo, and every invoice from then on would pick
      // CGST+SGST vs IGST on the wrong basis — invisible on the invoice and
      // expensive at filing time.
      const res = await savePlatformTaxSettings(
        input({ gstin: GSTIN_29, stateCode: "07" }),
        null,
      );
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error).toMatch(/29.*07|different state/i);
      expect(dbHolder.current.calls.insert.length).toBe(0);
    });

    it("accepts a matching pair", async () => {
      expect(
        (
          await savePlatformTaxSettings(
            input({ gstin: GSTIN_29, stateCode: "29" }),
            null,
          )
        ).ok,
      ).toBe(true);
    });

    it("★ the check is skipped when tax is off and no state is set", async () => {
      expect(
        (
          await savePlatformTaxSettings(
            input({ gstin: GSTIN_29, stateCode: "", taxEnabled: false }),
            null,
          )
        ).ok,
      ).toBe(true);
    });
  });

  it("★★ REFUSES a malformed GSTIN, even with tax off", async () => {
    // Storing a typo means every later invoice carries an unverifiable
    // identifier — and because finalized invoices are immutable, they cannot be
    // corrected.
    const res = await savePlatformTaxSettings(
      input({ gstin: "NOTAGSTIN", taxEnabled: false }),
      null,
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/GSTIN/i);
  });

  it("normalises a lower-case GSTIN rather than rejecting it", async () => {
    const res = await savePlatformTaxSettings(
      input({ gstin: GSTIN_07.toLowerCase() }),
      null,
    );
    expect(res.ok).toBe(true);
    expect(dbHolder.current.calls.values[0].gstin).toBe(GSTIN_07);
  });

  it.each([-1, 101, Number.NaN])("refuses a rate of %s", async (rate) => {
    const res = await savePlatformTaxSettings(
      input({ taxRatePercent: rate as number }),
      null,
    );
    expect(res.ok).toBe(false);
    expect(dbHolder.current.calls.insert.length).toBe(0);
  });

  it("refuses an empty invoice prefix", async () => {
    const res = await savePlatformTaxSettings(
      input({ invoicePrefix: "   " }),
      null,
    );
    expect(res.ok).toBe(false);
  });

  it("★ records WHO changed it — this is an audit question", async () => {
    await savePlatformTaxSettings(input(), "op@storemink.com");
    expect(dbHolder.current.calls.values[0].updatedBy).toBe("op@storemink.com");
  });

  it("★ reports a write failure rather than claiming success", async () => {
    dbHolder.current.db.insert = () => {
      throw new Error("db down");
    };
    expect((await savePlatformTaxSettings(input(), null)).ok).toBe(false);
  });
});

describe("getPlatformTaxSettings", () => {
  it("★★ falls back to tax-OFF when there is no row", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[]] });
    expect(await getPlatformTaxSettings()).toEqual(DEFAULT_TAX_SETTINGS);
  });

  it("★★ falls back to tax-OFF on a READ FAILURE, never inventing a charge", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [] });
    dbHolder.current.db.select = () => {
      throw new Error("db down");
    };
    const s = await getPlatformTaxSettings();
    expect(s.taxEnabled).toBe(false);
    expect(s.gstin).toBeNull();
  });

  it("returns the stored row", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          {
            legalName: "StoreMink",
            gstin: GSTIN_07,
            address: { city: "New Delhi" },
            stateCode: "07",
            taxEnabled: true,
            taxRateBps: 1800,
            taxInclusive: true,
            invoicePrefix: "SM",
            updatedAt: "2026-08-13T00:00:00.000Z",
            updatedBy: "op@storemink.com",
          },
        ],
      ],
    });
    const s = await getPlatformTaxSettings();
    expect(s).toMatchObject({
      taxEnabled: true,
      taxInclusive: true,
      taxRateBps: 1800,
      stateCode: "07",
    });
  });
});
