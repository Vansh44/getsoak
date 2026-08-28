import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ cookies: vi.fn() }));

const dbHolder = vi.hoisted(() => ({ current: null as never }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: (db: unknown) => unknown) =>
    Promise.resolve(fn(dbHolder.current)),
  ),
}));

beforeAll(() => {
  process.env.POS_SESSION_SECRET = "unit-test-pos-secret-please-change";
});

import {
  gateCustomerVerification,
  signCustomerVerification,
  verificationMatches,
} from "./customer-verification";
import { cookies } from "next/headers";

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

// ---------------------------------------------------------------------------
// The gate — who may proceed WITHOUT a code
// ---------------------------------------------------------------------------

/** One `select … leftJoin … where … limit` chain returning `rows`. */
function seedOrder(rows: unknown[] | Error) {
  const chain: Record<string, unknown> = {};
  for (const k of ["from", "leftJoin", "where"]) {
    chain[k] = vi.fn(() => chain);
  }
  chain.limit = vi.fn(() =>
    rows instanceof Error ? Promise.reject(rows) : Promise.resolve(rows),
  );
  dbHolder.current = { select: vi.fn(() => chain) } as never;
}

/** No proof on the request. */
function noProof() {
  vi.mocked(cookies).mockResolvedValue({
    get: () => undefined,
  } as never);
}

const MANAGER = { ...OP, role: "manager" as const };

const gate = (over: Partial<Parameters<typeof gateCustomerVerification>[0]>) =>
  gateCustomerVerification({
    op: MANAGER,
    orderId: "order-1",
    purpose: "pickup",
    acknowledged: false,
    mayOverride: true,
    requiredCopy: "Verify the customer's mobile number before handover.",
    ...over,
  });

describe("★ gateCustomerVerification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    noProof();
  });

  it("passes straight through on a valid proof, without reading the order", async () => {
    const token = signCustomerVerification({
      purpose: "pickup",
      orderId: "order-1",
      phone: "9876543210",
      op: MANAGER,
    });
    vi.mocked(cookies).mockResolvedValue({
      get: () => ({ value: token }),
    } as never);
    seedOrder([]);
    expect(await gate({})).toEqual({ ok: true, overridden: false });
  });

  // ★★ THE ACKNOWLEDGEMENT IS NEVER TAKEN ON THE CLIENT'S WORD. Without the
  // server re-deriving that no mobile exists, this flag would be a universal
  // OTP bypass any caller could set — the `managerApproved` boolean mistake.
  it("★★ IGNORES the acknowledgement when the order HAS a textable mobile", async () => {
    seedOrder([{ shippingAddress: { phone: "+919876543210" } }]);
    expect(await gate({ acknowledged: true })).toMatchObject({
      ok: false,
      verificationRequired: true,
    });
  });

  it("allows it only once the order genuinely has no mobile", async () => {
    seedOrder([{ shippingAddress: {}, customerPhone: null }]);
    expect(await gate({ acknowledged: true })).toEqual({
      ok: true,
      overridden: true,
    });
  });

  it("★ refuses an operator who may not override, however they ask", async () => {
    seedOrder([{ shippingAddress: {}, customerPhone: null }]);
    const res = await gate({ acknowledged: true, mayOverride: false });
    expect(res).toMatchObject({
      ok: false,
      verificationUnavailable: true,
      canOverride: false,
    });
    expect("error" in res && res.error).toMatch(/manager has to complete/i);
  });

  it("offers the override rather than demanding a code it cannot send", async () => {
    seedOrder([{ shippingAddress: {}, customerPhone: null }]);
    expect(await gate({})).toMatchObject({
      ok: false,
      verificationUnavailable: true,
      canOverride: true,
    });
  });

  // ★ FAILS CLOSED: a blip must not hand out override buttons for orders that
  // have a perfectly good number.
  it("★ reports a read failure as verification REQUIRED, not unavailable", async () => {
    seedOrder(new Error("connection reset"));
    expect(await gate({ acknowledged: true })).toMatchObject({
      ok: false,
      verificationRequired: true,
    });
  });

  it("★ and an order that isn't here is required, never overridable", async () => {
    seedOrder([]);
    expect(await gate({ acknowledged: true })).toMatchObject({
      ok: false,
      verificationRequired: true,
    });
  });
});
