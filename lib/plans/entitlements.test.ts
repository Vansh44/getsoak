/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, expect, it } from "vitest";
import {
  makeDbMock,
  sqlParamValues,
  sqlText,
} from "@/app/actions/_test-helpers";
import {
  assertCanActivateCoupon,
  assertCanActivateOffer,
  assertCanCreateProduct,
  assertCanInviteStaff,
  getProductCreateCapacity,
  PlanEntitlementError,
} from "./entitlements";

const STORE = "a0000000-0000-4000-8000-000000000001";

function dbFor(plan: string, current: number) {
  return makeDbMock({
    selectQueue: [[{ plan, expiresAt: null }], [{ n: current }]],
  });
}

describe("transactional plan limits", () => {
  it("blocks the sixth Free product without touching existing rows", async () => {
    const mock = dbFor("free", 5);
    await expect(
      assertCanCreateProduct(mock.db as any, STORE),
    ).rejects.toBeInstanceOf(PlanEntitlementError);
    expect(mock.calls.execute).toHaveLength(1);
    expect(mock.calls.delete).toHaveLength(0);
    expect(mock.calls.update).toHaveLength(0);
  });

  it("allows the fiftieth Basic product and blocks the fifty-first", async () => {
    await expect(
      assertCanCreateProduct(dbFor("basic", 49).db as any, STORE),
    ).resolves.toBeUndefined();
    await expect(
      assertCanCreateProduct(dbFor("basic", 50).db as any, STORE),
    ).rejects.toThrow(/50 products/i);
  });

  it("keeps Pro product creation unlimited", async () => {
    const mock = makeDbMock({
      selectQueue: [[{ plan: "pro", expiresAt: null }]],
    });
    await expect(
      assertCanCreateProduct(mock.db as any, STORE),
    ).resolves.toBeUndefined();
  });

  it("reserves a CSV slice with one plan/count read", async () => {
    const mock = dbFor("free", 3);

    await expect(
      getProductCreateCapacity(mock.db as any, STORE, 8),
    ).resolves.toMatchObject({ allowed: 2, error: expect.stringMatching(/5/) });
    expect(mock.calls.execute).toHaveLength(1);
    expect(mock.calls.select).toHaveLength(2);
  });

  it("counts the owner in the staff cap", async () => {
    await expect(
      assertCanInviteStaff(dbFor("free", 1).db as any, STORE),
    ).rejects.toThrow(/including the owner/i);
    await expect(
      assertCanInviteStaff(dbFor("basic", 2).db as any, STORE),
    ).resolves.toBeUndefined();
  });

  it("caps only active Free coupons", async () => {
    await expect(
      assertCanActivateCoupon(dbFor("free", 3).db as any, STORE),
    ).rejects.toThrow(/3 active coupons/i);
    await expect(
      assertCanActivateCoupon(dbFor("free", 2).db as any, STORE),
    ).resolves.toBeUndefined();
  });
});

// ★★ COUPONS AND OFFERS ARE ONE POOL.
//
// A coupon IS an offer since 20260902_0059, but the two gates counted separate
// tables under separate advisory locks — so a Free store ran three of each, six
// concurrent discounts on a plan that allows three, and two simultaneous writes
// could not see one another. `assertCanActivateOffer`'s own docblock claimed it
// counted the merged pool; it counted `offers` alone.
describe("★★ the merged discount pool", () => {
  const STORE_ID = "a0000000-0000-4000-8000-000000000001";

  /**
   * The reads in order: the advisory lock, the plan row, the `to_regclass`
   * probe, then the merged count.
   */
  function mergedDb(plan: string, active: number) {
    return makeDbMock({
      selectQueue: [[{ plan, expiresAt: null }]],
      executeQueue: [[], [{ ready: true }], [{ n: active }]],
    });
  }

  it("★ blocks a third discount on Free whichever screen asks", async () => {
    await expect(
      assertCanActivateOffer(mergedDb("free", 3).db as any, STORE_ID),
    ).rejects.toThrow(/3 active offers/i);
    // The coupon screen hits the SAME cap against the SAME pool, and is told
    // about coupons because that is the screen the merchant is looking at.
    await expect(
      assertCanActivateCoupon(mergedDb("free", 3).db as any, STORE_ID),
    ).rejects.toThrow(/3 active coupons/i);
  });

  it("★ allows the third when only two are running", async () => {
    await expect(
      assertCanActivateOffer(mergedDb("free", 2).db as any, STORE_ID),
    ).resolves.toBeUndefined();
    await expect(
      assertCanActivateCoupon(mergedDb("free", 2).db as any, STORE_ID),
    ).resolves.toBeUndefined();
  });

  it("★★ counts DISTINCT ids, so a migrated coupon is not counted twice", async () => {
    // Migration 0059 inserts each offer with `SELECT c.id`, so a migrated
    // coupon and its offer share a primary key. The count is a UNION on `id`
    // rather than a sum of two counts, which would double every one of them
    // and refuse a Free store its second genuine discount.
    const mock = mergedDb("free", 2);
    await assertCanActivateOffer(mock.db as any, STORE_ID);
    const sql = mock.calls.execute.map((e: any) => sqlText(e)).join("\n");
    expect(sql).toContain("union");
    expect(sql).not.toContain("union all");
  });

  it("★ both gates take the SAME lock, or the race is still open", async () => {
    // Two keys meant a coupon write and an offer write could pass at the same
    // moment and both land — the race the advisory lock exists to close.
    const offerMock = mergedDb("free", 0);
    await assertCanActivateOffer(offerMock.db as any, STORE_ID);
    const couponMock = mergedDb("free", 0);
    await assertCanActivateCoupon(couponMock.db as any, STORE_ID);

    const lockOf = (m: any) => sqlParamValues(m.calls.execute[0]);
    expect(lockOf(offerMock)).toEqual(lockOf(couponMock));
    expect(String(lockOf(offerMock))).toContain("active-discounts");
  });

  it("★★ falls back to coupons alone before the offers table exists", async () => {
    // DDL is a separate release gate, so this code runs in production before
    // 20260902_0059 does. Naming a missing table would abort the transaction
    // and take coupon creation down with it, so the probe answers first and the
    // pool is simply what it always was.
    const mock = makeDbMock({
      selectQueue: [[{ plan: "free", expiresAt: null }], [{ n: 3 }]],
      executeQueue: [[], [{ ready: false }]],
    });
    await expect(
      assertCanActivateCoupon(mock.db as any, STORE_ID),
    ).rejects.toThrow(/3 active coupons/i);
    // Only the lock and the probe — the merged query was never attempted.
    expect(mock.calls.execute).toHaveLength(2);
  });

  it("★ an unlimited plan short-circuits before counting anything", async () => {
    const mock = makeDbMock({
      selectQueue: [[{ plan: "pro", expiresAt: null }]],
      executeQueue: [[]],
    });
    await expect(
      assertCanActivateOffer(mock.db as any, STORE_ID),
    ).resolves.toBeUndefined();
    expect(mock.calls.execute).toHaveLength(1);
  });
});
