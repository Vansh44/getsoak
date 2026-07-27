/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { makeDbMock } from "@/app/actions/_test-helpers";

beforeAll(() => {
  process.env.POS_SESSION_SECRET = "unit-test-pos-secret-please-change";
});

const H = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    store,
    jar: {
      get: (n: string) => (store.has(n) ? { value: store.get(n) } : undefined),
    },
  };
});
vi.mock("next/headers", () => ({
  cookies: async () => H.jar,
  headers: async () => new Headers(),
}));
vi.mock("@/lib/store/resolve", () => ({
  getCurrentStoreId: vi.fn(async () => "store-1"),
  STORE_TAG: "stores",
}));
vi.mock("@/app/dashboard/lib/access", () => ({
  getManagerIdentity: vi.fn(async () => null),
}));
vi.mock("@/lib/auth/server-user", () => ({
  getServerUser: vi.fn(async () => null),
}));
vi.mock("@/lib/pos/locations", () => ({
  getDefaultLocationId: vi.fn(async () => "loc-1"),
}));
vi.mock("@/lib/pos/devices", () => ({ getAuthorizedDevice: vi.fn() }));

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
  withUser: vi.fn((_i: any, fn: any) =>
    Promise.resolve(fn(dbHolder.current.db)),
  ),
  withAnon: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import { getManagerIdentity } from "@/app/dashboard/lib/access";
import { getAuthorizedDevice } from "@/lib/pos/devices";
import { POS_OPERATOR_COOKIE, signOperatorToken } from "./session";
import { resolvePosOperator } from "./operator";

const AUTHORIZED = { deviceId: "d1", locationId: "loc-1" };

function operatorCookie(over: Record<string, unknown> = {}) {
  H.store.set(
    POS_OPERATOR_COOKIE,
    signOperatorToken({
      staffId: "st1",
      storeId: "store-1",
      locationId: "loc-1",
      deviceId: "d1",
      role: "cashier",
      name: "Priya",
      ...over,
    } as any),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  H.store.clear();
  vi.mocked(getManagerIdentity).mockResolvedValue(null);
  vi.mocked(getAuthorizedDevice).mockResolvedValue(AUTHORIZED);
  dbHolder.current = makeDbMock();
});

describe("resolvePosOperator", () => {
  it("is signed out with no device, even holding a valid operator cookie", async () => {
    vi.mocked(getAuthorizedDevice).mockResolvedValue(null);
    operatorCookie();
    expect(await resolvePosOperator()).toBeNull();
  });

  it("rejects an operator cookie minted for a DIFFERENT device", async () => {
    operatorCookie({ deviceId: "other-device" });
    dbHolder.current = makeDbMock({
      selectQueue: [[{ id: "st1", name: "Priya", role: "cashier" }]],
    });
    expect(await resolvePosOperator()).toBeNull();
  });

  it("resolves an active cashier from the DB, not from the cookie", async () => {
    // The cookie says "cashier"; the DB says they've been promoted. The DB wins.
    operatorCookie({ role: "cashier", name: "Stale Name" });
    dbHolder.current = makeDbMock({
      selectQueue: [[{ id: "st1", name: "Priya K", role: "manager" }]],
    });

    const op = await resolvePosOperator();
    expect(op).toMatchObject({
      role: "manager",
      name: "Priya K",
      staffId: "st1",
      source: "operator",
    });
  });

  // THE offboarding guarantee: deactivating/deleting staff must end their
  // session at once, not whenever the 12h token happens to lapse.
  it("voids the session when the staff row is gone or deactivated", async () => {
    operatorCookie();
    dbHolder.current = makeDbMock({ selectQueue: [[]] }); // no active row matches
    expect(await resolvePosOperator()).toBeNull();
  });

  it("voids the session when the role is no longer a POS role", async () => {
    operatorCookie();
    dbHolder.current = makeDbMock({
      selectQueue: [[{ id: "st1", name: "Priya", role: "superadmin" }]],
    });
    expect(await resolvePosOperator()).toBeNull();
  });

  it("gives a dashboard admin the owner role without a device", async () => {
    vi.mocked(getAuthorizedDevice).mockResolvedValue(null);
    vi.mocked(getManagerIdentity).mockResolvedValue({
      uid: "u1",
      email: "owner@x.com",
    } as any);
    const op = await resolvePosOperator();
    expect(op).toMatchObject({
      role: "owner",
      source: "owner",
      deviceAuthorized: false,
    });
  });
});
