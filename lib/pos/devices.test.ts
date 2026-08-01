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
vi.mock("@/lib/pos/audit", () => ({ posAudit: vi.fn(async () => {}) }));

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
  withUser: vi.fn((_i: any, fn: any) =>
    Promise.resolve(fn(dbHolder.current.db)),
  ),
  withAnon: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import { posAudit } from "@/lib/pos/audit";
import { POS_DEVICE_COOKIE, signDeviceToken } from "./session";
import { getAuthorizedDevice } from "./devices";

const STORE = "store-1";
function cookieFor(nonce: string, storeId = STORE) {
  H.store.set(
    POS_DEVICE_COOKIE,
    signDeviceToken({
      deviceId: "d1",
      storeId,
      locationId: "loc-1",
      nonce,
    }),
  );
}
const row = (over: Record<string, unknown> = {}) => ({
  id: "d1",
  location_id: "loc-1",
  revoked_at: null,
  token_nonce: "current",
  prev_nonce: null,
  prev_nonce_until: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  H.store.clear();
  dbHolder.current = makeDbMock();
});

describe("getAuthorizedDevice", () => {
  it("returns null with no cookie", async () => {
    expect(await getAuthorizedDevice(STORE)).toBeNull();
  });

  it("rejects a cookie minted for a DIFFERENT store", async () => {
    cookieFor("current", "another-store");
    expect(await getAuthorizedDevice(STORE)).toBeNull();
  });

  it("rejects a revoked device", async () => {
    cookieFor("current");
    dbHolder.current = makeDbMock({
      selectQueue: [[row({ revoked_at: "2024-01-01T00:00:00Z" })]],
    });
    expect(await getAuthorizedDevice(STORE)).toBeNull();
  });

  it("authorizes a device whose nonce is current", async () => {
    cookieFor("current");
    dbHolder.current = makeDbMock({ selectQueue: [[row()]] });
    expect(await getAuthorizedDevice(STORE)).toEqual({
      deviceId: "d1",
      locationId: "loc-1",
    });
  });

  // In-flight requests carrying the just-rotated nonce must NOT be mistaken for
  // a clone — that would lock a real shop out mid-shift.
  it("accepts the previous nonce inside the grace window", async () => {
    cookieFor("older");
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          row({
            prev_nonce: "older",
            prev_nonce_until: new Date(Date.now() + 60_000).toISOString(),
          }),
        ],
      ],
    });
    expect(await getAuthorizedDevice(STORE)).toEqual({
      deviceId: "d1",
      locationId: "loc-1",
    });
    expect(posAudit).not.toHaveBeenCalled();
  });

  // THE clone guarantee: a copied cookie holding a retired nonce revokes the
  // device outright rather than quietly working.
  it("revokes the device and audits when a retired nonce is presented", async () => {
    cookieFor("stolen-old");
    dbHolder.current = makeDbMock({ selectQueue: [[row()]] });

    expect(await getAuthorizedDevice(STORE)).toBeNull();

    const set = dbHolder.current.calls.set[0];
    expect(set.revokedAt).toBeTruthy();
    expect(set.revokedReason).toBe("clone_detected");
    expect(posAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "device_clone_detected",
        deviceId: "d1",
      }),
    );
  });

  it("revokes when the grace window has expired", async () => {
    cookieFor("older");
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          row({
            prev_nonce: "older",
            prev_nonce_until: new Date(Date.now() - 1000).toISOString(),
          }),
        ],
      ],
    });
    expect(await getAuthorizedDevice(STORE)).toBeNull();
    expect(posAudit).toHaveBeenCalledWith(
      expect.objectContaining({ event: "device_clone_detected" }),
    );
  });

  // Devices enrolled before rotation shipped carry no stored nonce.
  it("adopts the presented nonce for a legacy device instead of locking it out", async () => {
    cookieFor("whatever");
    dbHolder.current = makeDbMock({
      selectQueue: [[row({ token_nonce: null })]],
    });

    expect(await getAuthorizedDevice(STORE)).toEqual({
      deviceId: "d1",
      locationId: "loc-1",
    });
    expect(dbHolder.current.calls.set[0].tokenNonce).toBe("whatever");
    expect(posAudit).not.toHaveBeenCalled();
  });
});
