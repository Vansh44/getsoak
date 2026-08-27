/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDbMock } from "./_test-helpers";

const dbHolder = vi.hoisted(() => ({ current: null as any }));
const auth = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  getUser: vi.fn(),
  deleteUser: vi.fn(),
}));
const proof = vi.hoisted(() => ({
  has: vi.fn(),
  save: vi.fn(),
  sign: vi.fn(() => "signed-proof"),
}));

vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));
vi.mock("@/lib/pos/operator", () => ({ resolvePosOperator: vi.fn() }));
vi.mock("@/lib/auth/firebase-admin", () => ({
  getFirebaseAdminAuth: vi.fn(() => auth),
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("@/lib/observability/logger", () => ({ logError: vi.fn() }));
vi.mock("@/lib/pos/customer-verification", () => ({
  hasCustomerVerification: (...args: unknown[]) => proof.has(...args),
  saveCustomerVerification: (...args: unknown[]) => proof.save(...args),
  signCustomerVerification: proof.sign,
}));

import { resolvePosOperator } from "@/lib/pos/operator";
import {
  beginCustomerPhoneVerification,
  confirmCustomerPhoneVerification,
} from "./pos-customer-verification-actions";

const OP = {
  role: "manager" as const,
  storeId: "store-1",
  locationId: "loc-1",
  staffId: "staff-1",
  name: "Priya",
  source: "operator" as const,
  deviceAuthorized: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.POS_SESSION_SECRET = "unit-test-pos-secret-please-change";
  vi.mocked(resolvePosOperator).mockResolvedValue(OP);
  proof.has.mockResolvedValue(false);
  proof.save.mockResolvedValue(undefined);
  dbHolder.current = makeDbMock({
    selectQueue: [
      [
        {
          shippingAddress: { phone: "+91 98765 43210" },
          customerPhone: null,
        },
      ],
    ],
  });
});

describe("beginCustomerPhoneVerification", () => {
  it("returns the server-owned order phone and never accepts one from the client", async () => {
    const result = await beginCustomerPhoneVerification("order-1", "pickup");
    expect(result).toEqual({
      phone: "+919876543210",
      maskedPhone: "••••••3210",
    });
    expect(dbHolder.current.calls.leftJoin).toHaveLength(1);
  });

  it("reuses a matching proof without another order read or SMS", async () => {
    proof.has.mockResolvedValue(true);
    const result = await beginCustomerPhoneVerification("order-1", "return");
    expect(result).toEqual({ alreadyVerified: true });
    expect(dbHolder.current.calls.select).toHaveLength(0);
  });

  it("refuses legacy orders that have no valid mobile", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[{ shippingAddress: {}, customerPhone: "123" }]],
    });
    const result = await beginCustomerPhoneVerification("order-1", "return");
    expect(result.error).toMatch(/no valid customer mobile/i);
  });
});

describe("confirmCustomerPhoneVerification", () => {
  it("verifies a recent phone-auth token against the exact order number", async () => {
    auth.verifyIdToken.mockResolvedValue({
      phone_number: "+91 98765 43210",
      auth_time: Math.floor(Date.now() / 1000),
      firebase: { sign_in_provider: "phone" },
    });
    const result = await confirmCustomerPhoneVerification({
      orderId: "order-1",
      purpose: "return",
      idToken: "firebase-token",
    });
    expect(result).toEqual({ verified: true });
    expect(auth.verifyIdToken).toHaveBeenCalledWith("firebase-token", true);
    expect(proof.sign).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: "order-1",
        purpose: "return",
        phone: "9876543210",
        op: OP,
      }),
    );
    expect(proof.save).toHaveBeenCalledWith("signed-proof");
  });

  it("rejects a valid OTP token for a different mobile", async () => {
    auth.verifyIdToken.mockResolvedValue({
      phone_number: "+919999999999",
      auth_time: Math.floor(Date.now() / 1000),
      firebase: { sign_in_provider: "phone" },
    });
    const result = await confirmCustomerPhoneVerification({
      orderId: "order-1",
      purpose: "pickup",
      idToken: "firebase-token",
    });
    expect(result.error).toMatch(/didn't verify this order/i);
    expect(proof.save).not.toHaveBeenCalled();
  });

  it("removes a new phone-only Firebase identity after saving the counter proof", async () => {
    const now = Date.now();
    auth.verifyIdToken.mockResolvedValue({
      uid: "temporary-phone-user",
      phone_number: "+919876543210",
      auth_time: Math.floor(now / 1000),
      firebase: { sign_in_provider: "phone" },
    });
    auth.getUser.mockResolvedValue({
      email: undefined,
      phoneNumber: "+919876543210",
      metadata: { creationTime: new Date(now).toISOString() },
      providerData: [{ providerId: "phone" }],
    });
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          {
            shippingAddress: { phone: "+91 98765 43210" },
            customerPhone: null,
          },
        ],
        [],
      ],
    });

    const result = await confirmCustomerPhoneVerification({
      orderId: "order-1",
      purpose: "pickup",
      idToken: "firebase-token",
      cleanupCreatedAuthUser: true,
    });

    expect(result).toEqual({ verified: true });
    expect(proof.save).toHaveBeenCalledBefore(auth.deleteUser);
    expect(auth.deleteUser).toHaveBeenCalledWith("temporary-phone-user");
  });
});
