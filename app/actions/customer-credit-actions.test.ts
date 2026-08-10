/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth/server-user", () => ({ getServerUser: vi.fn() }));
vi.mock("@/lib/store/resolve", () => ({
  requireStorefrontStoreId: vi.fn(async () => STORE),
}));
vi.mock("@/lib/credit/store-credit", () => ({
  getCreditBalance: vi.fn(),
  getCreditLedger: vi.fn(),
}));

import { getMyCredit } from "./customer-credit-actions";
import { getServerUser } from "@/lib/auth/server-user";
import { requireStorefrontStoreId } from "@/lib/store/resolve";
import { getCreditBalance, getCreditLedger } from "@/lib/credit/store-credit";

const STORE = "a0000000-0000-4000-8000-000000000001";

const serverUser = {
  id: "user-1",
  email: "ada@example.com",
  phone: null,
  phoneConfirmed: true,
  metadata: {},
};

/** A ledger row as lib/credit returns it — note the internal fields. */
const ledgerRow = {
  id: "led-1",
  delta: 2000,
  kind: "refund",
  ref: "rf-internal-99",
  note: "Refund on ORD100110097",
  createdAt: "2026-08-09T10:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  (getServerUser as any).mockResolvedValue(serverUser);
  (requireStorefrontStoreId as any).mockResolvedValue(STORE);
  (getCreditBalance as any).mockResolvedValue(2000);
  (getCreditLedger as any).mockResolvedValue([ledgerRow]);
});

describe("getMyCredit", () => {
  it("returns the balance and recent movements for a signed-in shopper", async () => {
    const res = await getMyCredit();
    expect(res.balance).toBe(2000);
    expect(res.entries).toHaveLength(1);
    expect(res.entries[0]).toMatchObject({
      id: "led-1",
      delta: 2000,
      kind: "refund",
    });
  });

  it("★ never exposes the ledger's internal ref or note", async () => {
    // `note` is merchant-authored ("Refund on ORD…" today, free text once the
    // grant UI exists) and `ref` carries internal ids — §16's AI ledger uses
    // an operator's EMAIL as a ref. Neither may reach a storefront page.
    const res = await getMyCredit();
    const entry = res.entries[0] as unknown as Record<string, unknown>;
    expect(entry).not.toHaveProperty("note");
    expect(entry).not.toHaveProperty("ref");
    expect(JSON.stringify(res)).not.toContain("rf-internal-99");
    expect(JSON.stringify(res)).not.toContain("Refund on ORD");
  });

  it("returns an empty summary when signed out, without touching the ledger", async () => {
    (getServerUser as any).mockResolvedValue(null);
    const res = await getMyCredit();
    expect(res).toEqual({ balance: 0, entries: [] });
    expect(getCreditBalance).not.toHaveBeenCalled();
    expect(getCreditLedger).not.toHaveBeenCalled();
  });

  it("scopes to the HOST store and the session uid, never to caller input", async () => {
    // A Firebase uid is global, so the store scope is not redundant: without
    // it a shopper would see credit from another store while browsing this one.
    await getMyCredit();
    expect(getCreditBalance).toHaveBeenCalledWith(STORE, "user-1");
    expect(getCreditLedger).toHaveBeenCalledWith(STORE, "user-1", 10);
  });

  it("passes a spent-to-zero balance through rather than hiding it", async () => {
    // The card still renders at zero when there is history — the component
    // decides that, so the action must not flatten it to the empty summary.
    (getCreditBalance as any).mockResolvedValue(0);
    (getCreditLedger as any).mockResolvedValue([
      { ...ledgerRow, id: "led-2", delta: -2000, kind: "spend" },
    ]);
    const res = await getMyCredit();
    expect(res.balance).toBe(0);
    expect(res.entries).toHaveLength(1);
    expect(res.entries[0].delta).toBe(-2000);
  });
});
