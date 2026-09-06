/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock } from "./_test-helpers";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_cache: vi.fn((fn) => fn),
}));
vi.mock("@/lib/store/resolve", () => ({ getCurrentStore: vi.fn() }));
vi.mock("@/lib/auth/server-user", () => ({ getServerUser: vi.fn() }));
vi.mock("@/app/dashboard/lib/access", () => ({
  getManagerUserId: vi.fn(),
  getManagerIdentity: vi.fn(),
  getViewerContext: vi.fn(),
  getActingStoreId: vi.fn(async () => "a0000000-0000-4000-8000-000000000001"),
}));
vi.mock("@/lib/plans/entitlements", () => ({
  assertCanActivateCoupon: vi.fn(async () => undefined),
  storeAllowsPlanFeature: vi.fn(async () => true),
  PlanEntitlementError: class PlanEntitlementError extends Error {},
}));

// The ported data layer: with* runners invoke the callback with the mock db.
const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withUser: vi.fn((_identity: any, fn: any) => fn(dbHolder.current.db)),
  withService: vi.fn((fn: any) => fn(dbHolder.current.db)),
  withAnon: vi.fn((fn: any) => fn(dbHolder.current.db)),
}));

import {
  createCoupon,
  updateCoupon,
  deleteCoupon,
  validateCoupon,
  getAvailableStorefrontCoupons,
  toggleCouponVisibility,
} from "./coupon-actions";
import { getCurrentStore } from "@/lib/store/resolve";
import { getServerUser } from "@/lib/auth/server-user";
import {
  getManagerIdentity,
  getViewerContext,
} from "@/app/dashboard/lib/access";

const STORE = "a0000000-0000-4000-8000-000000000001";

const validForm = {
  code: "  save 10  ",
  description: "Ten percent off",
  discount_type: "percentage" as const,
  discount_value: 10,
  min_order_amount: 0,
  max_uses: 0,
  valid_from: "",
  valid_until: "",
  status: "active" as const,
  show_on_storefront: false,
};

// Scan a Drizzle SQL object's query chunks for a column reference by name —
// lets tests assert which filters a where-clause carries without rendering
// SQL. Only follows queryChunks (never a column's parent table, which would
// falsely match every column of the table).
function sqlMentionsColumn(sqlObj: any, colName: string): boolean {
  const walk = (o: any): boolean => {
    if (!o || typeof o !== "object") return false;
    if (Array.isArray(o)) return o.some(walk);
    if (o.table && o.name === colName) return true; // a Column chunk
    if (o.queryChunks) return walk(o.queryChunks);
    return false;
  };
  return walk(sqlObj);
}

// A currently-redeemable coupon row in the shape the aliased selects return.
const okRow = {
  id: "c-ok",
  code: "OK",
  description: "ten off",
  discount_type: "percentage",
  discount_value: 10,
  min_order_amount: 0,
  valid_from: null,
  valid_until: null,
  max_uses: 0,
  used_count: 0,
};

// coupon-actions.ts covers admin CRUD (withUser, RLS-gated) and the storefront
// validation/discovery paths (withAnon; withUser when signed in). Code
// normalisation and date / usage / minimum checks live here.
describe("coupon-actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbHolder.current = makeDbMock({ returning: [{ id: "x" }] });
    vi.mocked(getManagerIdentity).mockResolvedValue({
      uid: "user-1",
      email: "admin@example.com",
    });
    // Default caller is an anonymous shopper.
    vi.mocked(getServerUser).mockResolvedValue(null);
  });

  describe("createCoupon", () => {
    // Auth gate.
    it("rejects when caller lacks marketing.manage", async () => {
      vi.mocked(getManagerIdentity).mockResolvedValue(null);
      const result = await createCoupon(validForm);
      expect(result.error).toMatch(/not authenticated/i);
    });

    // Empty / whitespace-only code is rejected.
    it("rejects empty code", async () => {
      const result = await createCoupon({ ...validForm, code: "   " });
      expect(result.error).toMatch(/coupon code is required/i);
    });

    // discount_value must be > 0 — otherwise the coupon is useless.
    it("rejects non-positive discount value", async () => {
      const result = await createCoupon({ ...validForm, discount_value: 0 });
      expect(result.error).toMatch(/greater than 0/i);
    });

    // A percentage discount over 100 is nonsensical.
    it("rejects percentage discounts greater than 100", async () => {
      const result = await createCoupon({
        ...validForm,
        discount_type: "percentage",
        discount_value: 150,
      });
      expect(result.error).toMatch(/100%/);
    });

    // Date sanity check — valid_from after valid_until is invalid.
    it("rejects when valid_from is after valid_until", async () => {
      const result = await createCoupon({
        ...validForm,
        valid_from: "2026-12-01",
        valid_until: "2026-01-01",
      });
      expect(result.error).toMatch(/valid from/i);
    });

    // Normalisation: trimmed, uppercased, no internal whitespace.
    it("normalises the code (trim, uppercase, strip whitespace)", async () => {
      await createCoupon({ ...validForm, code: "  save 10  " });
      expect(dbHolder.current.calls.values[0].code).toBe("SAVE10");
      expect(dbHolder.current.calls.values[0].storeId).toBe(STORE);
    });

    // 23505 duplicate-key → friendly message instead of raw DB error.
    it("returns friendly error on unique-violation", async () => {
      dbHolder.current.db.insert = vi.fn(() => {
        throw Object.assign(new Error("Failed query"), {
          cause: Object.assign(new Error("dup"), { code: "23505" }),
        });
      });
      const result = await createCoupon(validForm);
      expect(result.error).toMatch(/already exists/i);
    });

    // Group restrictions are replaced (clear + insert) after the save.
    it("syncs group restrictions after creating", async () => {
      const result = await createCoupon({
        ...validForm,
        restricted_group_ids: ["g1", "g2"],
      });
      expect(result.success).toBe(true);
      // delete #1 = the clear; values #2 = the fresh links.
      expect(dbHolder.current.calls.delete).toHaveLength(1);
      expect(dbHolder.current.calls.values[1]).toEqual([
        { couponId: "x", groupId: "g1", storeId: STORE },
        { couponId: "x", groupId: "g2", storeId: STORE },
      ]);
    });
  });

  describe("updateCoupon", () => {
    // Auth gate.
    it("rejects unauthorised callers", async () => {
      vi.mocked(getManagerIdentity).mockResolvedValue(null);
      const result = await updateCoupon("id", validForm);
      expect(result.error).toMatch(/not authenticated/i);
    });

    // Update payload also goes through validateForm → percentage > 100 rejected.
    it("validates form fields on update too", async () => {
      const result = await updateCoupon("id", {
        ...validForm,
        discount_type: "percentage",
        discount_value: 200,
      });
      expect(result.error).toMatch(/100%/);
    });
  });

  describe("deleteCoupon", () => {
    // Auth gate.
    it("rejects unauthorised callers", async () => {
      vi.mocked(getManagerIdentity).mockResolvedValue(null);
      const result = await deleteCoupon("id");
      expect(result.error).toMatch(/not authenticated/i);
    });

    // Happy path — deletes the row by id.
    it("deletes the coupon by id", async () => {
      const result = await deleteCoupon("id");
      expect(result.success).toBe(true);
      expect(dbHolder.current.calls.delete).toHaveLength(1);
    });
  });

  // validateCoupon() — callable by anonymous shoppers. RLS hides DISABLED
  // coupons, so this layer adds date / usage / minimum-order checks and turns
  // them into specific user-facing messages.
  // Select order: #1 = the coupon row, #2 = the group-restriction links.
  describe("validateCoupon", () => {
    // Empty code never gets a DB call.
    it("rejects empty code", async () => {
      const result = await validateCoupon("   ", 500);
      expect(result.error).toMatch(/enter a coupon/i);
      expect(dbHolder.current.calls.select).toHaveLength(0);
    });

    // Code not found (or hidden by RLS because it's disabled).
    it("returns invalid when not found", async () => {
      dbHolder.current = makeDbMock({ selectQueue: [[]] });
      const result = await validateCoupon("NOPE", 500);
      expect(result.error).toMatch(/invalid or expired/i);
    });

    // ★★ A CODE MAY BE AN OFFER RATHER THAN A COUPON, and until this existed it
    // could not be applied AT ALL. Offers replaced coupons but this read never
    // left the legacy table, so a code created in the Offers UI was rejected as
    // invalid here — and since `placeOrder` only ever receives
    // `cart.appliedCoupon?.code`, the cart gate blocked it before the offer
    // engine (which honours it) was ever asked. Migrated coupons kept working
    // because they still have a `coupons` row; anything newer did not.
    describe("falling back to a code offer", () => {
      const offerRow = {
        id: "off-1",
        code: "SAVE10",
        reward_type: "percent_off",
        reward_config: { percent: 10 },
        trigger_type: "always",
        trigger_config: {},
        valid_from: null,
        valid_until: null,
        max_redemptions: null,
        redemption_count: 0,
      };

      it("resolves a percentage code offer", async () => {
        dbHolder.current = makeDbMock({
          selectByTable: { coupons: [[]], offers: [[offerRow]] },
        });
        const result = await validateCoupon("SAVE10", 500);
        expect(result.coupon).toMatchObject({
          code: "SAVE10",
          discountType: "percentage",
          discountValue: 10,
        });
      });

      it("resolves a fixed-amount code offer", async () => {
        dbHolder.current = makeDbMock({
          selectByTable: {
            coupons: [[]],
            offers: [
              [
                {
                  ...offerRow,
                  reward_type: "amount_off",
                  reward_config: { amount: 200 },
                },
              ],
            ],
          },
        });
        const result = await validateCoupon("SAVE10", 500);
        expect(result.coupon).toMatchObject({
          discountType: "fixed",
          discountValue: 200,
        });
      });

      // ★ THE COUPON WINS WHERE BOTH EXIST. A migrated pair shares an id and a
      // code across both tables, so an existing code must resolve exactly as it
      // did before — the offers read is a fallback, not a merge.
      it("never reaches the offers table when a coupon matches", async () => {
        dbHolder.current = makeDbMock({
          selectByTable: {
            coupons: [[{ ...okRow, code: "SAVE10", discount_value: 25 }]],
            offers: [[offerRow]],
          },
        });
        const result = await validateCoupon("SAVE10", 500);
        expect(result.coupon?.discountValue).toBe(25);
      });

      // ★ A REWARD THE CART CANNOT PREVIEW IS REAL, NOT INVALID. Saying
      // "invalid" would send a shopper to support over a code that is working
      // exactly as the merchant configured it.
      it("explains a reward it cannot preview instead of calling it invalid", async () => {
        dbHolder.current = makeDbMock({
          selectByTable: {
            coupons: [[]],
            offers: [
              [
                {
                  ...offerRow,
                  reward_type: "buy_x_get_y",
                  reward_config: { buyQuantity: 1, getQuantity: 1 },
                },
              ],
            ],
          },
        });
        const result = await validateCoupon("B1G1", 500);
        expect(result.error).toMatch(/applied automatically at checkout/i);
        expect(result.coupon).toBeUndefined();
      });

      it("applies the offer's own minimum-subtotal trigger", async () => {
        dbHolder.current = makeDbMock({
          selectByTable: {
            coupons: [[]],
            offers: [
              [
                {
                  ...offerRow,
                  trigger_type: "min_subtotal",
                  trigger_config: { minSubtotal: 1000 },
                },
              ],
            ],
          },
        });
        const result = await validateCoupon("SAVE10", 500);
        expect(result.error).toMatch(/Add ₹500 more/i);
      });

      it("refuses one that has reached its redemption cap", async () => {
        dbHolder.current = makeDbMock({
          selectByTable: {
            coupons: [[]],
            offers: [
              [{ ...offerRow, max_redemptions: 5, redemption_count: 5 }],
            ],
          },
        });
        const result = await validateCoupon("SAVE10", 500);
        expect(result.error).toMatch(/usage limit/i);
      });

      it("refuses an expired one", async () => {
        dbHolder.current = makeDbMock({
          selectByTable: {
            coupons: [[]],
            offers: [
              [
                {
                  ...offerRow,
                  valid_until: new Date(Date.now() - 86400_000).toISOString(),
                },
              ],
            ],
          },
        });
        const result = await validateCoupon("SAVE10", 500);
        expect(result.error).toMatch(/expired/i);
      });
    });

    // valid_from in the future → not yet active.
    it("rejects when not yet active (valid_from in the future)", async () => {
      dbHolder.current = makeDbMock({
        selectQueue: [
          [
            {
              ...okRow,
              code: "FUTURE",
              valid_from: new Date(Date.now() + 86400_000).toISOString(),
            },
          ],
          [],
        ],
      });
      const result = await validateCoupon("FUTURE", 500);
      expect(result.error).toMatch(/isn.?t active yet/i);
    });

    // valid_until already past → expired.
    it("rejects when expired", async () => {
      dbHolder.current = makeDbMock({
        selectQueue: [
          [
            {
              ...okRow,
              code: "OLD",
              valid_until: new Date(Date.now() - 86400_000).toISOString(),
            },
          ],
          [],
        ],
      });
      const result = await validateCoupon("OLD", 500);
      expect(result.error).toMatch(/expired/i);
    });

    // Usage cap hit — surfaces the "limit reached" message.
    it("rejects when usage cap is reached", async () => {
      dbHolder.current = makeDbMock({
        selectQueue: [
          [{ ...okRow, code: "FULL", max_uses: 5, used_count: 5 }],
          [],
        ],
      });
      const result = await validateCoupon("FULL", 500);
      expect(result.error).toMatch(/usage limit/i);
    });

    // Subtotal below minimum order → message includes the amount-to-add.
    it("rejects when subtotal is below the minimum order", async () => {
      dbHolder.current = makeDbMock({
        selectQueue: [
          [
            {
              ...okRow,
              code: "BIG",
              discount_type: "fixed",
              discount_value: 100,
              min_order_amount: 1000,
            },
          ],
          [],
        ],
      });
      const result = await validateCoupon("BIG", 500);
      expect(result.error).toMatch(/Add ₹500 more/i);
    });

    // A group-restricted coupon requires sign-in.
    it("requires sign-in for a group-restricted coupon", async () => {
      dbHolder.current = makeDbMock({
        selectQueue: [[{ ...okRow, code: "VIP" }], [{ group_id: "g1" }]],
      });
      const result = await validateCoupon("VIP", 500);
      expect(result.error).toMatch(/sign in/i);
    });

    // Signed in but not a member of any linked group → not available.
    it("rejects a signed-in non-member of the restricted groups", async () => {
      vi.mocked(getServerUser).mockResolvedValue({
        id: "user-9",
        email: null,
        emailConfirmed: false,
        phone: null,
        phoneConfirmed: false,
        metadata: {},
      });
      dbHolder.current = makeDbMock({
        // #1 coupon, #2 links, #3 memberships (none).
        selectQueue: [[{ ...okRow, code: "VIP" }], [{ group_id: "g1" }], []],
      });
      const result = await validateCoupon("VIP", 500);
      expect(result.error).toMatch(/isn.?t available for your account/i);
    });

    // Happy path — returns the rule fields so the cart can recompute the
    // discount locally as quantities change.
    it("returns the applied coupon rule on success", async () => {
      dbHolder.current = makeDbMock({
        selectQueue: [[{ ...okRow, code: "SAVE10" }], []],
      });
      const result = await validateCoupon("save10", 1000);
      expect(result.coupon).toEqual({
        code: "SAVE10",
        discountType: "percentage",
        discountValue: 10,
        minOrderAmount: 0,
      });
    });
  });

  // getAvailableStorefrontCoupons() — the cart's coupon-discovery list. Runs in
  // the anonymous scope; only ACTIVE, currently-redeemable coupons show.
  describe("getAvailableStorefrontCoupons", () => {
    beforeEach(() => {
      vi.mocked(getCurrentStore).mockResolvedValue({
        id: STORE,
        settings: {},
        plan: "free",
      } as any);
    });

    it("returns only currently-redeemable coupons and filters to visible ones by default", async () => {
      const now = Date.now();
      dbHolder.current = makeDbMock({
        selectQueue: [
          [
            okRow,
            {
              ...okRow,
              code: "EXPIRED",
              valid_until: new Date(now - 8.64e7).toISOString(),
            },
            { ...okRow, code: "USEDUP", max_uses: 5, used_count: 5 },
          ],
        ],
      });

      const result = await getAvailableStorefrontCoupons();
      expect(result.map((c) => c.code)).toEqual(["OK"]);
      expect(result[0]).toMatchObject({
        code: "OK",
        discount_value: 10,
        min_order_amount: 0,
      });
      // showAll off → the query filters on show_on_storefront.
      expect(
        sqlMentionsColumn(
          dbHolder.current.calls.where[0],
          "show_on_storefront",
        ),
      ).toBe(true);
    });

    it("skips the visibility filter when marketing.showAllCoupons is on", async () => {
      vi.mocked(getCurrentStore).mockResolvedValue({
        id: STORE,
        settings: { features: { "marketing.showAllCoupons": true } },
        plan: "free",
      } as any);
      dbHolder.current = makeDbMock({ selectQueue: [[]] });

      await getAvailableStorefrontCoupons();
      expect(
        sqlMentionsColumn(
          dbHolder.current.calls.where[0],
          "show_on_storefront",
        ),
      ).toBe(false);
    });
  });

  // toggleCouponVisibility() — the dashboard inline switch. Permission-gated and
  // store-scoped so no admin can flip another store's coupon.
  describe("toggleCouponVisibility", () => {
    it("rejects an unauthenticated caller", async () => {
      vi.mocked(getViewerContext).mockResolvedValue(null as any);
      const result = await toggleCouponVisibility("c1", true);
      expect(result.error).toMatch(/not authenticated/i);
    });

    it("rejects a caller without marketing.manage", async () => {
      vi.mocked(getViewerContext).mockResolvedValue({
        profile: { role: "viewer" },
        permissions: {},
        isSuperadmin: false,
        storeId: STORE,
      } as any);
      const result = await toggleCouponVisibility("c1", true);
      expect(result.error).toMatch(/permission/i);
    });

    it("updates visibility scoped to id + store for an authorised admin", async () => {
      vi.mocked(getViewerContext).mockResolvedValue({
        profile: { role: "superadmin" },
        permissions: {},
        isSuperadmin: true,
        storeId: STORE,
      } as any);
      vi.mocked(getServerUser).mockResolvedValue({
        id: "user-1",
        email: null,
        emailConfirmed: false,
        phone: null,
        phoneConfirmed: false,
        metadata: {},
      });
      const result = await toggleCouponVisibility("c1", true);
      expect(result.success).toBe(true);
      expect(dbHolder.current.calls.set[0]).toEqual({ showOnStorefront: true });
      expect(
        sqlMentionsColumn(dbHolder.current.calls.where[0], "store_id"),
      ).toBe(true);
    });
  });
});
