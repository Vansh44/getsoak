/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock, sqlParamValues, sqlText } from "./_test-helpers";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
// Activity/notification bookkeeping is deferred with after(), so in a real
// request it runs AFTER the action returns and never touches the action's own
// DB scope. No-op it here so these assertions see only the action's queries.
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/app/dashboard/lib/access", () => ({
  getManagerUserId: vi.fn(),
  getManagerIdentity: vi.fn(),
  getActingStoreId: vi.fn(async () => STORE),
}));
// Location scope is mocked at its own seam: these tests care about "restricted
// or not", not how the binding is resolved (that is scope.test.ts).
vi.mock("@/lib/locations/scope", () => ({
  getViewerLocations: vi.fn(async () => null),
}));

// The ported data layer: with* runners invoke the callback with the mock db.
const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  // Promise.resolve() assimilates the thenable query steps into real
  // promises, so the action's .catch() calls work like production.
  withUser: vi.fn((_identity: any, fn: any) =>
    Promise.resolve(fn(dbHolder.current.db)),
  ),
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
  withAnon: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import { getOrders, getOrderDetail, updateOrderStatus } from "./order-actions";
import {
  getManagerIdentity,
  getManagerUserId,
} from "@/app/dashboard/lib/access";
import { getViewerLocations } from "@/lib/locations/scope";

const STORE = "a0000000-0000-4000-8000-000000000001";

// order-actions.ts — the dashboard orders list (user scope with the FULL
// identity + explicit store scope, gated on getManagerIdentity) and the
// allowlisted status update with the exactly-once cancel restock (atomic
// reserved→released claim + release_stock RPC).
describe("order-actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbHolder.current = makeDbMock({ returning: [{ id: "o1" }] });
    vi.mocked(getManagerUserId).mockResolvedValue("user-1");
    vi.mocked(getManagerIdentity).mockResolvedValue({
      uid: "user-1",
      email: "admin@example.com",
    });
  });

  describe("getOrders", () => {
    // Auth gate — no orders permission → nothing leaks.
    it("rejects when the caller lacks the orders permission", async () => {
      vi.mocked(getManagerUserId).mockResolvedValue(null);
      vi.mocked(getManagerIdentity).mockResolvedValue(null);
      const result = await getOrders();
      expect(result.error).toMatch(/not authenticated/i);
      expect(result.orders).toEqual([]);
      expect(dbHolder.current.calls.select).toHaveLength(0);
    });

    // Happy path — store-scoped, returns rows + total count.
    it("returns store-scoped, paginated orders with a total", async () => {
      dbHolder.current = makeDbMock({
        selectQueue: [
          [{ id: "o1", total: 100 }],
          [{ n: 3 }],
          [
            { status: "pending", n: 2 },
            { status: "delivered", n: 1 },
          ],
        ],
      });
      const result = await getOrders({ page: 1, pageSize: 50 });
      expect(result.error).toBeUndefined();
      expect(result.orders).toEqual([{ id: "o1", total: 100 }]);
      expect(result.total).toBe(3);
      // Per-status tab counts come from the grouped-count query.
      expect(result.counts.all).toBe(3);
      expect(result.counts.pending).toBe(2);
      expect(result.counts.delivered).toBe(1);
      // List + count + grouped-count queries, all store-scoped.
      expect(dbHolder.current.calls.where).toHaveLength(3);
      // Never selects the order_items join for the list.
      expect(Object.keys(dbHolder.current.calls.select[0] ?? {})).not.toContain(
        "order_items",
      );
    });

    // Page size is clamped so a client can't request an unbounded range.
    it("clamps an oversized page size", async () => {
      await getOrders({ page: 1, pageSize: 100000 });
      expect(dbHolder.current.calls.limit[0]).toBe(100);
      expect(dbHolder.current.calls.offset[0]).toBe(0);
    });

    // REGRESSION (the "No orders yet" bug): the user scope must be opened with
    // the FULL identity — uid AND email — because the platform-operator branch
    // of the orders RLS policy (is_platform_admin) matches by auth.email().
    // A uid-only identity silently empties the list for platform operators.
    // Phase B2: staff see only their location(s); owners see everything.
    describe("location scope", () => {
      it("adds no location filter for an unrestricted viewer", async () => {
        vi.mocked(getViewerLocations).mockResolvedValue(null);
        await getOrders();
        // Only the store filter (+ no location predicate) reaches the query.
        expect(sqlText(dbHolder.current.calls.where[0])).not.toMatch(
          /in |null/,
        );
      });

      it("filters to the viewer's locations when restricted", async () => {
        vi.mocked(getViewerLocations).mockResolvedValue(["loc-1", "loc-2"]);
        await getOrders();
        expect(sqlText(dbHolder.current.calls.where[0])).toMatch(/is null|in /);
      });

      // An order belonging to no shop (every online order until Phase D) stays
      // visible, or location-bound staff lose the whole online order book.
      it("keeps location-less orders visible to restricted staff", async () => {
        vi.mocked(getViewerLocations).mockResolvedValue(["loc-1"]);
        await getOrders();
        expect(sqlText(dbHolder.current.calls.where[0])).toMatch(/is null/);
      });

      // Assigned only to locations that have since been deleted: show NOTHING,
      // never silently promote them to seeing the whole store.
      it("shows nothing when the scope resolves to an empty list", async () => {
        vi.mocked(getViewerLocations).mockResolvedValue([]);
        await getOrders();
        expect(sqlText(dbHolder.current.calls.where[0])).toMatch(/false/);
      });
    });

    it("opens the user scope with the full identity (uid + email)", async () => {
      const { withUser } = await import("@/lib/db/client");
      await getOrders();
      expect(vi.mocked(withUser).mock.calls[0][0]).toEqual({
        uid: "user-1",
        email: "admin@example.com",
      });
    });
  });

  describe("getOrderDetail", () => {
    it("rejects an unauthenticated caller", async () => {
      vi.mocked(getManagerUserId).mockResolvedValue(null);
      vi.mocked(getManagerIdentity).mockResolvedValue(null);
      const res = await getOrderDetail("o1");
      expect(res.error).toMatch(/not authenticated/i);
    });

    it("returns the order with its line items", async () => {
      dbHolder.current = makeDbMock({
        selectQueue: [
          [{ id: "o1", order_ref: "ORD1", total: 100, status: "pending" }],
          [{ id: "i1", name: "Tea", quantity: 2, price: 50, total: 100 }],
        ],
      });
      const res = await getOrderDetail("o1");
      expect(res.error).toBeUndefined();
      expect(res.order?.id).toBe("o1");
      expect(res.order?.items).toHaveLength(1);
      // The order lookup is scoped by id AND store (its where carries both).
      expect(dbHolder.current.calls.where.length).toBeGreaterThanOrEqual(1);
    });

    it("errors when the order isn't in this store", async () => {
      dbHolder.current = makeDbMock({ selectQueue: [[]] });
      const res = await getOrderDetail("nope");
      expect(res.error).toMatch(/no longer exists/i);
    });
  });

  describe("updateOrderStatus", () => {
    // Auth gate.
    it("rejects unauthorised callers", async () => {
      vi.mocked(getManagerUserId).mockResolvedValue(null);
      vi.mocked(getManagerIdentity).mockResolvedValue(null);
      const result = await updateOrderStatus("o1", "shipped");
      expect(result.error).toMatch(/not authenticated/i);
    });

    // Only known statuses are accepted — no arbitrary string reaches the DB.
    it("rejects an unknown order status", async () => {
      const result = await updateOrderStatus("o1", "hacked");
      expect(result.error).toMatch(/invalid order status/i);
      expect(dbHolder.current.calls.update).toHaveLength(0);
    });

    // Payment status is allowlisted too.
    it("rejects an unknown payment status", async () => {
      const result = await updateOrderStatus("o1", "shipped", "laundered");
      expect(result.error).toMatch(/invalid payment status/i);
    });

    // Empty / non-string order id is rejected.
    it("rejects an empty order id", async () => {
      const result = await updateOrderStatus("   ", "shipped");
      expect(result.error).toMatch(/invalid order/i);
    });

    // Happy path — update is scoped to id AND store (where carries both).
    it("updates a valid status scoped to the store", async () => {
      const result = await updateOrderStatus("o1", "shipped", "paid");
      expect(result.success).toBe(true);
      expect(dbHolder.current.calls.set[0]).toEqual({
        status: "shipped",
        paymentStatus: "paid",
      });
      expect(dbHolder.current.calls.where).toHaveLength(1);
    });

    it("restocks a reserved order exactly once when cancelled", async () => {
      // Order is 'reserved', so the conditional claim UPDATE matches one row
      // (returning [{id}]); the line items then feed release_stock.
      dbHolder.current = makeDbMock({
        returning: [{ id: "o1" }],
        selectQueue: [[{ product_id: "p1", variant_id: "v1", quantity: 2 }]],
      });

      const result = await updateOrderStatus("o1", "cancelled");
      expect(result.success).toBe(true);

      // The release is claimed atomically: stock_status flips reserved→released
      // in a single conditional UPDATE, so it can never fire twice.
      expect(dbHolder.current.calls.set[0]).toEqual({
        stockStatus: "released",
      });

      // One release_stock RPC per line item, with the line's exact values.
      expect(dbHolder.current.calls.execute).toHaveLength(1);
      const params = sqlParamValues(dbHolder.current.calls.execute[0]);
      expect(params).toEqual([STORE, "p1", "v1", 2, "o1", "order_cancelled"]);

      // The status update itself still lands.
      expect(dbHolder.current.calls.set[1]).toEqual({ status: "cancelled" });
    });

    // REGRESSION (POS merge). A register reserves stock at its OWN location via
    // reserve_stock_at. The plain release_stock wrapper delegates to the store's
    // DEFAULT location, so cancelling an in-store sale used to hand the units
    // back to the wrong shop — the selling location never recovered its stock
    // and the default gained a unit it never had. Silent, and it compounds.
    it("returns a POS sale's stock to the location it was sold at", async () => {
      dbHolder.current = makeDbMock({
        returning: [{ id: "o1", location_id: "loc-2" }],
        selectQueue: [[{ product_id: "p1", variant_id: null, quantity: 3 }]],
      });

      const result = await updateOrderStatus("o1", "cancelled");
      expect(result.success).toBe(true);

      const text = sqlText(dbHolder.current.calls.execute[0]);
      expect(text).toContain("release_stock_at");
      const params = sqlParamValues(dbHolder.current.calls.execute[0]);
      // p_location sits second, right after the store.
      expect(params).toEqual([
        STORE,
        "loc-2",
        "p1",
        null,
        3,
        "o1",
        "order_cancelled",
      ]);
    });

    // An online order has no location and reserved against the default, so the
    // wrapper stays correct for it — the branch must not flip everything over.
    it("still uses the default-location wrapper for an online order", async () => {
      dbHolder.current = makeDbMock({
        returning: [{ id: "o1", location_id: null }],
        selectQueue: [[{ product_id: "p1", variant_id: "v1", quantity: 1 }]],
      });

      await updateOrderStatus("o1", "cancelled");

      const text = sqlText(dbHolder.current.calls.execute[0]);
      expect(text).toContain("release_stock");
      expect(text).not.toContain("release_stock_at");
    });

    it("does not restock an order whose stock was never reserved or already released", async () => {
      // stock_status is not 'reserved' (a legacy 'none' order, or one already
      // 'released' by a prior cancel/reinstate), so the claim UPDATE matches no
      // row — guards both the phantom restock and the double restock.
      dbHolder.current = makeDbMock({ returning: [] });

      const result = await updateOrderStatus("o1", "cancelled");
      expect(result.success).toBe(true);
      expect(dbHolder.current.calls.execute).toHaveLength(0);
    });
  });
});
