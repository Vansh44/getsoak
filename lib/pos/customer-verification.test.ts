import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ cookies: vi.fn() }));

beforeAll(() => {
  process.env.POS_SESSION_SECRET = "unit-test-pos-secret-please-change";
});

import {
  signCustomerVerification,
  verificationMatches,
} from "./customer-verification";

const OP = {
  role: "cashier" as const,
  storeId: "store-1",
  locationId: "loc-1",
  staffId: "staff-1",
  name: "Priya",
  source: "operator" as const,
  deviceAuthorized: true,
};

describe("POS customer phone verification proof", () => {
  it("is bound to the exact order, purpose, store, location, and operator", () => {
    const token = signCustomerVerification({
      purpose: "pickup",
      orderId: "order-1",
      phone: "9876543210",
      op: OP,
    });
    expect(
      verificationMatches(token, {
        purpose: "pickup",
        orderId: "order-1",
        op: OP,
      }),
    ).toBe(true);
    expect(
      verificationMatches(token, {
        purpose: "return",
        orderId: "order-1",
        op: OP,
      }),
    ).toBe(false);
    expect(
      verificationMatches(token, {
        purpose: "pickup",
        orderId: "order-2",
        op: OP,
      }),
    ).toBe(false);
    expect(
      verificationMatches(token, {
        purpose: "pickup",
        orderId: "order-1",
        op: { ...OP, staffId: "staff-2" },
      }),
    ).toBe(false);
  });

  it("expires after the short counter window", () => {
    const now = Math.floor(Date.now() / 1000);
    const token = signCustomerVerification({
      purpose: "return",
      orderId: "order-1",
      phone: "9876543210",
      op: OP,
      now: now - 31 * 60,
    });
    expect(
      verificationMatches(token, {
        purpose: "return",
        orderId: "order-1",
        op: OP,
      }),
    ).toBe(false);
  });
});
