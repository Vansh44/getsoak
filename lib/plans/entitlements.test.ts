/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, expect, it } from "vitest";
import { makeDbMock } from "@/app/actions/_test-helpers";
import {
  assertCanActivateCoupon,
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
