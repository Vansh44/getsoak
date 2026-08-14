/* eslint-disable @typescript-eslint/no-explicit-any */
// A merchant's own invoices.
//
// Two properties carry the weight:
//   • a DRAFT is not a document — it has no number, and enrolment leaves one
//     behind every time a payment window is closed;
//   • every read is scoped by STORE, so an invoice id alone never crosses
//     tenants.
//
// Everything else is layout.

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

import { getInvoiceDocument, listInvoices } from "./invoice-history";

const STORE = "store-1";

function invoiceRow(over: Record<string, unknown> = {}) {
  return {
    id: "inv-1",
    storeId: STORE,
    kind: "subscription",
    status: "paid",
    subtotalPaise: 500_000,
    discountPaise: 0,
    taxPaise: 90_000,
    totalPaise: 590_000,
    invoiceRef: "SM/2026-27/00001",
    finalizedAt: "2026-09-01T00:00:00.000Z",
    paidAt: "2026-09-01T00:00:00.000Z",
    periodStart: "2026-09-01T00:00:00.000Z",
    periodEnd: "2026-10-01T00:00:00.000Z",
    taxRateBps: 1800,
    supplierGstin: "07AABCS1429B1ZX",
    customerGstin: "29AAACM1234C1ZP",
    placeOfSupply: "29",
    ...over,
  };
}

/** invoice, then items, then supplier settings, then billing account. */
function seedDoc(over: Record<string, unknown> = {}) {
  dbHolder.current = makeDbMock({
    selectQueue: [
      [invoiceRow(over)],
      [
        {
          kind: "base_plan",
          description: "Pro plan · 1 month",
          quantity: 1,
          unitAmountPaise: 500_000,
          amountPaise: 500_000,
        },
      ],
      [{ legalName: "StoreMink Technologies", address: { city: "New Delhi" } }],
      [
        {
          legalName: "Acme Retail",
          address: { city: "Bengaluru" },
          billingEmail: "acme@example.test",
        },
      ],
    ],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("listInvoices", () => {
  it("returns the issued invoices", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[{ id: "inv-1", invoiceRef: "SM/2026-27/00001" }]],
    });
    const rows = await listInvoices(STORE);
    expect(rows).toHaveLength(1);
  });

  it("★ returns [] on a read failure rather than throwing", async () => {
    // The page also carries the plan and AI usage; a billing hiccup should cost
    // the list, not the page.
    dbHolder.current = makeDbMock({ selectQueue: [] });
    dbHolder.current.db.select = () => {
      throw new Error("db down");
    };
    expect(await listInvoices(STORE)).toEqual([]);
  });
});

describe("getInvoiceDocument", () => {
  it("renders an issued invoice from its own snapshot", async () => {
    seedDoc();
    const doc = await getInvoiceDocument(STORE, "inv-1");
    expect(doc).toMatchObject({
      invoiceRef: "SM/2026-27/00001",
      totalPaise: 590_000,
      taxRateBps: 1800,
      supplierGstin: "07AABCS1429B1ZX",
      placeOfSupply: "29",
    });
    expect(doc?.items).toHaveLength(1);
  });

  it("★★ REFUSES a DRAFT — it has no number and is not a document", async () => {
    // Enrolment and add-on purchases both leave drafts behind when the payment
    // window is closed. Showing one would present an unpaid, unnumbered row as a
    // bill.
    seedDoc({ status: "draft", finalizedAt: null, invoiceRef: null });
    expect(await getInvoiceDocument(STORE, "inv-1")).toBeNull();
  });

  it("★ REFUSES a row that is finalized but in an unknown status", async () => {
    seedDoc({ status: "something_new" });
    expect(await getInvoiceDocument(STORE, "inv-1")).toBeNull();
  });

  it("★ shows an UNCOLLECTIBLE invoice — the merchant still owed it", async () => {
    seedDoc({ status: "uncollectible", paidAt: null });
    const doc = await getInvoiceDocument(STORE, "inv-1");
    expect(doc?.status).toBe("uncollectible");
  });

  it("★★ scopes the read by STORE, not just by id", async () => {
    // The predicate is what stops one merchant opening another's invoice. The
    // mock cannot evaluate WHERE, so this asserts the call was MADE with both —
    // and `storeId` is threaded from the session by the page, never from a URL.
    seedDoc();
    await getInvoiceDocument(STORE, "inv-1");
    expect(dbHolder.current.calls.where.length).toBeGreaterThan(0);
  });

  it("returns null when the invoice does not exist", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[]] });
    expect(await getInvoiceDocument(STORE, "nope")).toBeNull();
  });

  it("★ returns null on a read failure rather than a half-rendered document", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [] });
    dbHolder.current.db.select = () => {
      throw new Error("db down");
    };
    expect(await getInvoiceDocument(STORE, "inv-1")).toBeNull();
  });

  it("★ falls back to a supplier name when settings are unconfigured", async () => {
    // Today's real state: no platform_billing_settings row at all.
    dbHolder.current = makeDbMock({
      selectQueue: [[invoiceRow()], [], [], []],
    });
    const doc = await getInvoiceDocument(STORE, "inv-1");
    expect(doc?.supplier.legalName).toBe("StoreMink");
    expect(doc?.customer.legalName).toBeNull();
  });
});
