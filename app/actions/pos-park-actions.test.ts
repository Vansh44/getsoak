/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock } from "./_test-helpers";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));
vi.mock("@/lib/pos/operator", () => ({ resolvePosOperator: vi.fn() }));

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import { resolvePosOperator } from "@/lib/pos/operator";
import { MAX_PARKED_SALES } from "@/lib/pos/park";
import {
  discardParkedSale,
  listParkedSales,
  parkSale,
  resumeParkedSale,
} from "./pos-park-actions";

const CASHIER = {
  role: "cashier" as const,
  storeId: "store-1",
  locationId: "loc-1",
  staffId: "st1",
  name: "Priya",
  source: "operator" as const,
  deviceAuthorized: true,
};

const lines = [{ productId: "p1", variantId: null, quantity: 2 }];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolvePosOperator).mockResolvedValue(CASHIER as any);
  dbHolder.current = makeDbMock({
    selectQueue: [[]],
    returning: [{ id: "k1" }],
  });
});

describe("permissions", () => {
  it.each([
    ["parkSale", () => parkSale({ lines })],
    ["listParkedSales", () => listParkedSales()],
    ["resumeParkedSale", () => resumeParkedSale("k1")],
    ["discardParkedSale", () => discardParkedSale("k1")],
  ])("%s refuses when signed out", async (_n, call) => {
    vi.mocked(resolvePosOperator).mockResolvedValue(null);
    expect((await call()).error).toMatch(/signed in/i);
  });

  // ★ `sell`, the same grant as ringing one up — parking is part of serving a
  // customer, not a supervisory act.
  it("is open to a cashier", async () => {
    const r = await parkSale({ lines });
    expect(r.success).toBe(true);
  });
});

describe("parkSale", () => {
  it("stores the choices against the operator's store and location", async () => {
    await parkSale({ lines, label: "Blue jacket", orderDiscount: 20 });
    const row = dbHolder.current.calls.values[0];
    expect(row.storeId).toBe("store-1");
    expect(row.locationId).toBe("loc-1");
    expect(row.label).toBe("Blue jacket");
    expect(row.orderDiscount).toBe(20);
    // Who held it, so a busy counter can tell three carts apart.
    expect(row.parkedBy).toBe("st1");
    expect(row.parkedByName).toBe("Priya");
  });

  it("never lets the caller choose the store or location", async () => {
    await parkSale({
      lines,
      storeId: "other",
      locationId: "other-loc",
    } as never);
    const row = dbHolder.current.calls.values[0];
    expect(row.storeId).toBe("store-1");
    expect(row.locationId).toBe("loc-1");
  });

  it("refuses an empty cart without writing", async () => {
    const r = await parkSale({ lines: [] });
    expect(r.error).toMatch(/add something/i);
    expect(dbHolder.current.calls.values).toHaveLength(0);
  });

  // ★ A stuck button — or a cashier parking instead of voiding — would fill the
  // list until it is useless for finding the one cart that matters.
  it("refuses past the cap, and says how to clear it", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        Array.from({ length: MAX_PARKED_SALES }, (_, i) => ({ id: `k${i}` })),
      ],
    });
    const r = await parkSale({ lines });
    expect(r.error).toMatch(new RegExp(`${MAX_PARKED_SALES} held sales`, "i"));
    expect(r.error).toMatch(/finish or discard/i);
    expect(dbHolder.current.calls.values).toHaveLength(0);
  });

  it("allows one more while under the cap", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[{ id: "k1" }]],
      returning: [{ id: "k2" }],
    });
    expect((await parkSale({ lines })).success).toBe(true);
  });
});

describe("listParkedSales", () => {
  it("returns what is held, with an item count for the list", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          {
            id: "k1",
            label: "Blue jacket",
            lines: [
              { productId: "p1", variantId: null, quantity: 2 },
              { productId: "p2", variantId: null, quantity: 3 },
            ],
            orderDiscount: "20",
            customerId: null,
            customerGstin: null,
            note: null,
            parkedByName: "Priya",
            createdAt: "2026-08-16T10:00:00Z",
          },
        ],
      ],
    });
    const r = await listParkedSales();
    expect(r.sales[0].items).toBe(5);
    expect(r.sales[0].orderDiscount).toBe(20);
  });

  it("survives a malformed lines column", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          {
            id: "k1",
            label: null,
            lines: "not-an-array",
            orderDiscount: "0",
            createdAt: "2026-08-16T10:00:00Z",
          },
        ],
      ],
    });
    const r = await listParkedSales();
    expect(r.sales[0].lines).toEqual([]);
    expect(r.sales[0].items).toBe(0);
  });
});

describe("resumeParkedSale", () => {
  it("returns the sale and removes it", async () => {
    dbHolder.current = makeDbMock({
      returning: [
        {
          id: "k1",
          label: "Blue jacket",
          lines: [{ productId: "p1", variantId: null, quantity: 2 }],
          orderDiscount: "0",
          customerId: "cust-1",
          customerGstin: null,
          note: null,
          parkedByName: "Priya",
          createdAt: "2026-08-16T10:00:00Z",
        },
      ],
    });
    const r = await resumeParkedSale("k1");
    expect(r.sale?.customerId).toBe("cust-1");
    expect(r.sale?.items).toBe(2);
  });

  // ★★ THE DELETE IS THE CLAIM. Two tills resuming the same cart must not both
  // get it — that is how one basket gets charged twice.
  it("tells the loser of a race rather than loading a cart twice", async () => {
    dbHolder.current = makeDbMock({ returning: [] });
    const r = await resumeParkedSale("k1");
    expect(r.sale).toBeUndefined();
    expect(r.error).toMatch(/someone else may have resumed it/i);
  });
});

describe("discardParkedSale", () => {
  it("removes it", async () => {
    expect((await discardParkedSale("k1")).success).toBe(true);
  });
});
