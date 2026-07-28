/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock } from "./_test-helpers";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock("@/lib/pos/operator", () => ({ resolvePosOperator: vi.fn() }));

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
  withUser: vi.fn((_i: any, fn: any) =>
    Promise.resolve(fn(dbHolder.current.db)),
  ),
  withAnon: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import { withService } from "@/lib/db/client";
import { resolvePosOperator } from "@/lib/pos/operator";
import {
  getPosLayout,
  resetPosLayout,
  savePosLayout,
} from "./pos-layout-actions";

const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";
const V1 = "33333333-3333-4333-8333-333333333333";

const actor = (role: "cashier" | "manager" | "owner") => ({
  role,
  storeId: "store-1",
  locationId: "loc-1",
  staffId: "st1",
  name: "Priya",
  source: "operator" as const,
  deviceAuthorized: true,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolvePosOperator).mockResolvedValue(actor("manager") as any);
  dbHolder.current = makeDbMock();
});

describe("getPosLayout", () => {
  it("refuses when signed out", async () => {
    vi.mocked(resolvePosOperator).mockResolvedValue(null);
    const r = await getPosLayout();
    expect(r.error).toMatch(/signed in/i);
    expect(r.canEdit).toBe(false);
  });

  it("returns the saved layout", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[{ items: [{ productId: P1, variantId: null }] }]],
    });
    const r = await getPosLayout();
    expect(r.items).toEqual([{ productId: P1, variantId: null }]);
    expect(r.configured).toBe(true);
  });

  // The safety property: no row means "never arranged", and the register shows
  // the whole catalogue. It must never read as "an empty till".
  it("reports not-configured when there is no row", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[]] });
    const r = await getPosLayout();
    expect(r).toMatchObject({ items: [], configured: false });
  });

  // A cashier's grid depends on this read, so it is open to anyone who sells —
  // but canEdit is what gates the button, and it must be false for them.
  it("lets a cashier read but not edit", async () => {
    vi.mocked(resolvePosOperator).mockResolvedValue(actor("cashier") as any);
    dbHolder.current = makeDbMock({ selectQueue: [[]] });
    const r = await getPosLayout();
    expect(r.error).toBeUndefined();
    expect(r.canEdit).toBe(false);
  });

  it("lets a manager and an owner edit", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[]] });
    expect((await getPosLayout()).canEdit).toBe(true);
    vi.mocked(resolvePosOperator).mockResolvedValue(actor("owner") as any);
    dbHolder.current = makeDbMock({ selectQueue: [[]] });
    expect((await getPosLayout()).canEdit).toBe(true);
  });

  // A layout read must never take the till down; showing everything is always
  // more useful than an empty grid.
  it("degrades to showing everything when the read fails", async () => {
    vi.mocked(withService).mockRejectedValueOnce(new Error("connection reset"));
    const r = await getPosLayout();
    expect(r.error).toBeTruthy();
    expect(r).toMatchObject({ items: [], configured: false });
  });

  it("discards a stored blob that isn't a valid layout", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[{ items: "garbage" }]] });
    expect((await getPosLayout()).items).toEqual([]);
  });
});

describe("savePosLayout", () => {
  it("refuses a cashier", async () => {
    vi.mocked(resolvePosOperator).mockResolvedValue(actor("cashier") as any);
    const r = await savePosLayout([{ productId: P1, variantId: null }]);
    expect(r.error).toMatch(/manager or the owner/i);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("refuses when signed out", async () => {
    vi.mocked(resolvePosOperator).mockResolvedValue(null);
    expect((await savePosLayout([])).error).toMatch(/signed in/i);
  });

  it("saves for the operator's OWN store and location", async () => {
    const r = await savePosLayout([{ productId: P1, variantId: V1 }]);
    expect(r.success).toBe(true);
    // Never a client-supplied location — a manager at one shop must not be
    // able to rearrange another's till.
    expect(dbHolder.current.calls.values[0]).toMatchObject({
      storeId: "store-1",
      locationId: "loc-1",
      items: [{ productId: P1, variantId: V1 }],
    });
  });

  it("rejects malformed ids rather than storing them", async () => {
    expect((await savePosLayout("nope" as any)).error).toMatch(/isn't valid/i);
    expect(
      (await savePosLayout([{ productId: "not-a-uuid", variantId: null }]))
        .error,
    ).toMatch(/isn't valid/i);
    expect(
      (await savePosLayout([{ productId: P1, variantId: "bad" } as any])).error,
    ).toMatch(/isn't valid/i);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("drops duplicate tiles, keeping the first position", async () => {
    await savePosLayout([
      { productId: P1, variantId: null },
      { productId: P2, variantId: null },
      { productId: P1, variantId: null },
    ]);
    expect(dbHolder.current.calls.values[0].items).toEqual([
      { productId: P1, variantId: null },
      { productId: P2, variantId: null },
    ]);
  });

  it("refuses an absurdly large layout", async () => {
    const many = Array.from({ length: 501 }, () => ({
      productId: P1,
      variantId: null,
    }));
    expect((await savePosLayout(many)).error).toMatch(/isn't valid/i);
  });

  // Saving an empty layout is how a manager says "show everything again".
  it("accepts an empty layout", async () => {
    const r = await savePosLayout([]);
    expect(r.success).toBe(true);
    expect(dbHolder.current.calls.values[0].items).toEqual([]);
  });
});

describe("resetPosLayout", () => {
  it("refuses a cashier", async () => {
    vi.mocked(resolvePosOperator).mockResolvedValue(actor("cashier") as any);
    const r = await resetPosLayout();
    expect(r.error).toMatch(/manager or the owner/i);
    expect(dbHolder.current.calls.delete ?? []).toHaveLength(0);
  });

  it("clears the layout for a manager", async () => {
    const r = await resetPosLayout();
    expect(r.success).toBe(true);
  });
});
