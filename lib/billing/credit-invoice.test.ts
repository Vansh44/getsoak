/* eslint-disable @typescript-eslint/no-explicit-any */
// Invoicing an AI credit purchase.
//
// Two rules carry it, both inherited from enrolment:
//   • a DRAFT at purchase time, FINALIZED when the money lands — so an abandoned
//     checkout never burns a number in the gapless GST series;
//   • everything is best-effort, because credits are granted by add_ai_credits
//     and must not fail over a document.

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

const store = vi.hoisted(() => ({
  loadTaxContext: vi.fn(),
  loadInvoiceParties: vi.fn(),
  createAiCreditsInvoice: vi.fn(),
  finalizeInvoice: vi.fn(),
}));
vi.mock("./invoice-store", () => store);

import { draftCreditInvoice, issueCreditInvoice } from "./credit-invoice";

const STORE = "store-1";
const NOW = new Date("2026-09-01T00:00:00.000Z");

const args = {
  storeId: STORE,
  purchaseId: "pur-1",
  packLabel: "Starter",
  credits: 25,
  amountPaise: 5_900,
};

beforeEach(() => {
  vi.clearAllMocks();
  dbHolder.current = makeDbMock({ selectQueue: [] });
  store.loadTaxContext.mockResolvedValue({
    enabled: false,
    rateBps: 0,
    inclusive: false,
    supplierStateCode: null,
    placeOfSupply: null,
  });
  store.loadInvoiceParties.mockResolvedValue({
    supplierGstin: null,
    customerGstin: null,
    placeOfSupply: null,
  });
  store.createAiCreditsInvoice.mockResolvedValue({
    id: "inv-1",
    status: "draft",
    finalizedAt: null,
    invoiceRef: null,
  });
  store.finalizeInvoice.mockResolvedValue({ id: "inv-1", status: "open" });
});

describe("draftCreditInvoice", () => {
  it("raises an ai_credits invoice for the pack", async () => {
    const id = await draftCreditInvoice(args);
    expect(id).toBe("inv-1");
    const built = store.createAiCreditsInvoice.mock.calls[0][0].built;
    expect(built.totalPaise).toBe(5_900);
    expect(built.lines[0].kind).toBe("ai_credits");
  });

  it("★★ does NOT finalize — an unpaid purchase must not burn a GST number", async () => {
    await draftCreditInvoice(args);
    expect(store.finalizeInvoice).not.toHaveBeenCalled();
  });

  it("★ links it to the purchase, so settling can find it", async () => {
    await draftCreditInvoice(args);
    expect(dbHolder.current.calls.set[0]).toMatchObject({
      invoiceId: "inv-1",
    });
  });

  it("★ stamps the tax identifiers, like every other invoice", async () => {
    store.loadInvoiceParties.mockResolvedValue({
      supplierGstin: "07AABCS1429B1ZX",
      customerGstin: null,
      placeOfSupply: "29",
    });
    await draftCreditInvoice(args);
    expect(store.createAiCreditsInvoice.mock.calls[0][0]).toMatchObject({
      supplierGstin: "07AABCS1429B1ZX",
      placeOfSupply: "29",
    });
  });

  it("★★ NEVER THROWS — a merchant must be able to buy credits regardless", async () => {
    store.createAiCreditsInvoice.mockRejectedValue(new Error("db down"));
    await expect(draftCreditInvoice(args)).resolves.toBeNull();
  });

  it("★ returns null when the invoice could not be created", async () => {
    store.createAiCreditsInvoice.mockResolvedValue(null);
    expect(await draftCreditInvoice(args)).toBeNull();
  });
});

describe("issueCreditInvoice", () => {
  it("finalizes the linked draft", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[{ invoiceId: "inv-1" }]] });
    await issueCreditInvoice("pur-1", NOW);
    expect(store.finalizeInvoice).toHaveBeenCalledWith("inv-1", NOW);
  });

  it("★★ does NOTHING for a purchase with no invoice", async () => {
    // Purchases made before this existed have no draft. Issuing one today would
    // put a number from the CURRENT financial year's series on a months-old
    // sale, which is worse than no number.
    dbHolder.current = makeDbMock({ selectQueue: [[{ invoiceId: null }]] });
    await issueCreditInvoice("pur-old", NOW);
    expect(store.finalizeInvoice).not.toHaveBeenCalled();
  });

  it("★ does nothing when the purchase is gone", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[]] });
    await issueCreditInvoice("pur-x", NOW);
    expect(store.finalizeInvoice).not.toHaveBeenCalled();
  });

  it("★★ NEVER THROWS — the credits are already granted by this point", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [] });
    dbHolder.current.db.select = () => {
      throw new Error("db down");
    };
    await expect(issueCreditInvoice("pur-1", NOW)).resolves.toBeUndefined();
  });
});
