/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { makeDbMock } from "./_test-helpers";

beforeAll(() => {
  process.env.POS_SESSION_SECRET = "unit-test-pos-secret-please-change";
});

// A cookie jar the next/headers mock reads/writes.
const H = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    store,
    jar: {
      get: (n: string) => (store.has(n) ? { value: store.get(n) } : undefined),
      set: vi.fn((n: string, v: string) => {
        store.set(n, v);
      }),
      delete: vi.fn((n: string) => {
        store.delete(n);
      }),
    },
  };
});

vi.mock("next/headers", () => ({
  cookies: async () => H.jar,
  headers: async () =>
    new Headers({ "x-forwarded-host": "echos.storemink.com" }),
}));
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock("@/app/dashboard/lib/access", () => ({
  getManagerIdentity: vi.fn(async () => ({ uid: "u1", email: "a@b.c" })),
  getActingStoreId: vi.fn(async () => "store-1"),
}));
vi.mock("@/lib/store/resolve", () => ({
  getCurrentStoreId: vi.fn(async () => "store-1"),
  STORE_TAG: "stores",
}));
vi.mock("@/lib/pos/locations", () => ({
  getStoreLocations: vi.fn(async () => [{ id: "loc-1", name: "Main" }]),
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(async () => ({ allowed: true })),
  clientIp: vi.fn(() => "1.2.3.4"),
}));
// The device gate is exercised directly in its own right; stub it here so each
// login test can declare "this browser is / isn't an authorized device".
vi.mock("@/lib/pos/devices", () => ({
  getAuthorizedDevice: vi.fn(),
  // Rotation is exercised in lib/pos/devices.test.ts; here it just needs to
  // resolve so the login path can re-issue the device cookie.
  rotateDeviceNonce: vi.fn(async () => "rotated-nonce"),
  getDeviceNonce: vi.fn(async () => "old-nonce"),
  newDeviceNonce: vi.fn(() => "fresh-nonce"),
}));
vi.mock("@/lib/pos/audit", () => ({ posAudit: vi.fn(async () => {}) }));
vi.mock("@/lib/pos/staff-email", () => ({
  sendPosStaffEmail: vi.fn(async () => {}),
  posAbsoluteUrl: vi.fn(async (p: string) => `http://echos.localhost:3000${p}`),
  emailButton: () => "",
  escapeHtml: (v: string) => v,
}));
vi.mock("@/lib/auth/firebase-users", () => ({
  updateAuthUser: vi.fn(async () => {}),
}));

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withUser: vi.fn((_i: any, fn: any) =>
    Promise.resolve(fn(dbHolder.current.db)),
  ),
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
  withAnon: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import { rateLimit } from "@/lib/rate-limit";
import { getManagerIdentity } from "@/app/dashboard/lib/access";
import { getAuthorizedDevice, rotateDeviceNonce } from "@/lib/pos/devices";
import { hashPin } from "@/lib/pos/pin";
import {
  POS_DEVICE_COOKIE,
  POS_OPERATOR_COOKIE,
  verifyDeviceToken,
  verifyOperatorToken,
} from "@/lib/pos/session";
import { sendPosStaffEmail } from "@/lib/pos/staff-email";
import { updateAuthUser } from "@/lib/auth/firebase-users";
import {
  authorizeThisDevice,
  createPairingCode,
  pairDevice,
  posLoginWithPin,
  posLock,
  requestPosCredentialReset,
  getPosResetInfo,
  completePosReset,
} from "./pos-auth-actions";

const AUTHORIZED = { deviceId: "d1", locationId: "loc-1" };

// registerDevice/createPairingCode first run the per-location device cap check:
// select #1 = the store's plan, select #2 = active devices at that location.
const PRO_STORE = { plan: "pro", plan_expires_at: null };
const capSelects = (activeDevices = 0) => [[PRO_STORE], [{ n: activeDevices }]];

beforeEach(() => {
  vi.clearAllMocks();
  H.store.clear();
  vi.mocked(rateLimit).mockResolvedValue({ allowed: true });
  vi.mocked(getManagerIdentity).mockResolvedValue({
    uid: "u1",
    email: "a@b.c",
  } as any);
  vi.mocked(getAuthorizedDevice).mockResolvedValue(null);
  dbHolder.current = makeDbMock();
});

describe("authorizeThisDevice", () => {
  it("refuses a non-owner (only a store admin may authorize a device)", async () => {
    vi.mocked(getManagerIdentity).mockResolvedValue(null);
    const r = await authorizeThisDevice("loc-1");
    expect(r.error).toMatch(/owner/i);
    expect(H.jar.set).not.toHaveBeenCalled();
  });

  it("refuses a location outside the store", async () => {
    expect((await authorizeThisDevice("nope")).error).toMatch(/location/i);
  });

  it("registers the device and sets the signed device cookie", async () => {
    dbHolder.current = makeDbMock({ selectQueue: capSelects() });
    const r = await authorizeThisDevice("loc-1");
    expect(r.success).toBe(true);
    const claims = verifyDeviceToken(H.store.get(POS_DEVICE_COOKIE));
    expect(claims).toMatchObject({ storeId: "store-1", locationId: "loc-1" });
    // Every device is born with a rotation nonce.
    expect(claims!.nonce).toBeTruthy();
  });

  // Bounds the blast radius of a leaked pairing code (Pro allows 5/location).
  it("refuses once the location is at its device cap", async () => {
    dbHolder.current = makeDbMock({ selectQueue: capSelects(5) });
    const r = await authorizeThisDevice("loc-1");
    expect(r.error).toMatch(/already has 5 authorized devices/i);
    expect(H.jar.set).not.toHaveBeenCalled();
  });

  // A deployment missing POS_SESSION_SECRET can't mint a device cookie. It must
  // say so — and must NOT bank a device row it can't hand a credential for.
  // Staging shipped without the secret and every click 500'd, each one leaving
  // an orphan row that counted toward the cap above, so the register eventually
  // blamed a device cap for a missing env var.
  it("reports a missing signing secret and writes no device row", async () => {
    const saved = process.env.POS_SESSION_SECRET;
    delete process.env.POS_SESSION_SECRET;
    try {
      dbHolder.current = makeDbMock({ selectQueue: capSelects() });
      const r = await authorizeThisDevice("loc-1");
      expect(r.success).toBeUndefined();
      expect(r.error).toMatch(/isn't fully configured/i);
      expect(dbHolder.current.calls.insert).toHaveLength(0);
      expect(H.jar.set).not.toHaveBeenCalled();
    } finally {
      process.env.POS_SESSION_SECRET = saved;
    }
  });
});

describe("createPairingCode", () => {
  it("rejects unauthorized callers", async () => {
    vi.mocked(getManagerIdentity).mockResolvedValue(null);
    expect((await createPairingCode("loc-1")).error).toMatch(/permission/i);
  });

  it("issues an 8-char code for a valid location", async () => {
    dbHolder.current = makeDbMock({ selectQueue: capSelects() });
    const r = await createPairingCode("loc-1");
    expect(r.code).toMatch(/^[A-Z0-9]{8}$/);
    expect(dbHolder.current.calls.values[0].locationId).toBe("loc-1");
  });

  // Fail before handing out a code that couldn't be redeemed anyway.
  it("refuses to issue a code once the location is at its device cap", async () => {
    dbHolder.current = makeDbMock({ selectQueue: capSelects(5) });
    const r = await createPairingCode("loc-1");
    expect(r.error).toMatch(/already has 5 authorized devices/i);
    expect(r.code).toBeUndefined();
  });
});

describe("pairDevice (code fallback)", () => {
  it("rejects a malformed code", async () => {
    expect((await pairDevice("short")).error).toMatch(/invalid/i);
  });

  it("rejects an already-used / expired code (nothing claimed)", async () => {
    dbHolder.current = makeDbMock({ returning: [] });
    const r = await pairDevice("ABCD2345");
    expect(r.error).toMatch(/invalid or has expired/i);
    expect(H.jar.set).not.toHaveBeenCalled();
  });

  it("authorizes the device on a valid code", async () => {
    dbHolder.current = makeDbMock({
      returning: [{ location_id: "loc-1" }],
      selectQueue: capSelects(),
    });
    const r = await pairDevice("abcd2345"); // lowercase → normalised
    expect(r.success).toBe(true);
    expect(verifyDeviceToken(H.store.get(POS_DEVICE_COOKIE))).toMatchObject({
      locationId: "loc-1",
    });
  });
});

describe("posLoginWithPin", () => {
  const staffRow = {
    id: "st1",
    name: "Priya",
    role: "cashier",
    pin_hash: hashPin("12345678"),
  };
  // Reads in order: 1 staff-by-email, then (device permitting) 2 the
  // location-assignment check.
  const seed = (rows: any[][]) =>
    (dbHolder.current = makeDbMock({ selectQueue: rows }));

  // THE device-restriction guarantee: correct credentials on an unauthorized
  // device (e.g. the cashier's personal phone) must NOT sign them in. They are
  // now TOLD what to do rather than blocked before typing — but no operator
  // session is minted, so nothing can be sold.
  it("refuses on an unauthorized device even with the right credentials", async () => {
    vi.mocked(getAuthorizedDevice).mockResolvedValue(null);
    seed([[staffRow]]);
    const r = await posLoginWithPin("p@x.com", "12345678");
    expect(r.needsPairing).toBe(true);
    expect(r.success).toBeUndefined();
    expect(H.store.has(POS_OPERATOR_COOKIE)).toBe(false);
  });

  // Bail BEFORE the nonce rotation. Failing at the signing step would rotate
  // the device's nonce without re-issuing the cookie, and the next request
  // would present a retired nonce — which reads as a CLONE and revokes the
  // device. A missing env var must not cost a shop its authorized register.
  it("refuses up front when the signing secret is missing", async () => {
    const saved = process.env.POS_SESSION_SECRET;
    delete process.env.POS_SESSION_SECRET;
    try {
      vi.mocked(getAuthorizedDevice).mockResolvedValue(AUTHORIZED);
      seed([[staffRow], [{ staff_id: "st1" }]]);
      const r = await posLoginWithPin("p@x.com", "12345678");
      expect(r.success).toBeUndefined();
      expect(r.error).toMatch(/isn't fully configured/i);
      expect(rotateDeviceNonce).not.toHaveBeenCalled();
      expect(H.store.has(POS_OPERATOR_COOKIE)).toBe(false);
    } finally {
      process.env.POS_SESSION_SECRET = saved;
    }
  });

  // Credentials are checked BEFORE the device, so a bad PIN on an unpaired
  // device is still reported as a bad PIN — never as "pair this device".
  it("reports a wrong PIN even when the device is unauthorized", async () => {
    vi.mocked(getAuthorizedDevice).mockResolvedValue(null);
    seed([[{ ...staffRow, pin_hash: hashPin("99999999") }]]);
    const r = await posLoginWithPin("p@x.com", "12345678");
    expect(r.error).toMatch(/incorrect email or pin/i);
    expect(r.needsPairing).toBeUndefined();
  });

  it("validates the email and PIN format", async () => {
    vi.mocked(getAuthorizedDevice).mockResolvedValue(AUTHORIZED);
    expect((await posLoginWithPin("nope", "12345678")).error).toMatch(/email/i);
    expect((await posLoginWithPin("p@x.com", "1234")).error).toMatch(
      /8-digit pin/i,
    );
  });

  it("signs in on an authorized device and binds the session to it", async () => {
    vi.mocked(getAuthorizedDevice).mockResolvedValue(AUTHORIZED);
    seed([[staffRow], [{ staff_id: "st1" }]]);

    const r = await posLoginWithPin(" P@X.com ", "12345678");
    expect(r.success).toBe(true);
    expect(r.operator).toMatchObject({ name: "Priya", role: "cashier" });

    expect(verifyOperatorToken(H.store.get(POS_OPERATOR_COOKIE))).toMatchObject(
      {
        staffId: "st1",
        storeId: "store-1",
        locationId: "loc-1",
        deviceId: "d1",
        role: "cashier",
      },
    );
  });

  // A manager for Delhi must not be able to ring sales on the Mumbai till.
  it("refuses staff who aren't assigned to this device's location", async () => {
    vi.mocked(getAuthorizedDevice).mockResolvedValue(AUTHORIZED);
    seed([[staffRow], []]);
    const r = await posLoginWithPin("p@x.com", "12345678");
    expect(r.error).toMatch(/not assigned to this location/i);
    expect(H.store.has(POS_OPERATOR_COOKIE)).toBe(false);
  });

  it("rejects a wrong PIN", async () => {
    vi.mocked(getAuthorizedDevice).mockResolvedValue(AUTHORIZED);
    seed([[{ ...staffRow, pin_hash: hashPin("99999999") }]]);
    const r = await posLoginWithPin("p@x.com", "12345678");
    expect(r.error).toMatch(/incorrect email or pin/i);
    expect(H.store.has(POS_OPERATOR_COOKIE)).toBe(false);
  });

  it("rejects an unknown email", async () => {
    vi.mocked(getAuthorizedDevice).mockResolvedValue(AUTHORIZED);
    seed([[]]);
    const r = await posLoginWithPin("ghost@x.com", "12345678");
    expect(r.error).toMatch(/incorrect email or pin/i);
  });

  it("throttles repeated attempts", async () => {
    vi.mocked(getAuthorizedDevice).mockResolvedValue(AUTHORIZED);
    vi.mocked(rateLimit).mockResolvedValue({ allowed: false });
    expect((await posLoginWithPin("p@x.com", "12345678")).error).toMatch(
      /too many/i,
    );
  });
});

describe("posLock", () => {
  it("clears the operator cookie", async () => {
    H.store.set(POS_OPERATOR_COOKIE, "something");
    const r = await posLock();
    expect(r.success).toBe(true);
    expect(H.jar.delete).toHaveBeenCalledWith(POS_OPERATOR_COOKIE);
  });
});

describe("requestPosCredentialReset", () => {
  // Never leak whether an address is registered — the response is identical
  // either way; only the inbox differs.
  it("reports success for an unknown email without sending anything", async () => {
    dbHolder.current = makeDbMock({ returning: [] }); // no row matched
    const r = await requestPosCredentialReset("ghost@x.com");
    expect(r.success).toBe(true);
    expect(sendPosStaffEmail).not.toHaveBeenCalled();
  });

  it("stores a token and emails an active staff member", async () => {
    dbHolder.current = makeDbMock({ returning: [{ name: "Priya" }] });
    const r = await requestPosCredentialReset(" P@X.com ");
    expect(r.success).toBe(true);

    const set = dbHolder.current.calls.set[0];
    expect(set.resetToken).toBeTruthy();
    expect(new Date(set.resetExpiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(sendPosStaffEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "p@x.com" }), // normalised
    );
  });

  it("stays silent (still success) when throttled", async () => {
    vi.mocked(rateLimit).mockResolvedValue({ allowed: false });
    const r = await requestPosCredentialReset("p@x.com");
    expect(r.success).toBe(true);
    expect(sendPosStaffEmail).not.toHaveBeenCalled();
  });
});

describe("getPosResetInfo", () => {
  it("rejects an unknown token", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[]] });
    expect(await getPosResetInfo("nope")).toMatchObject({
      error: expect.stringMatching(/no longer valid/i),
    });
  });

  it("rejects an expired token", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          {
            name: "P",
            email: "p@x.com",
            reset_expires_at: new Date(Date.now() - 1000).toISOString(),
          },
        ],
      ],
    });
    expect(await getPosResetInfo("t")).toMatchObject({
      error: expect.stringMatching(/expired/i),
    });
  });

  it("returns the staff details for a live token", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          {
            name: "Priya",
            email: "p@x.com",
            reset_expires_at: new Date(Date.now() + 60_000).toISOString(),
          },
        ],
      ],
    });
    expect(await getPosResetInfo("t")).toMatchObject({
      name: "Priya",
      email: "p@x.com",
    });
  });
});

describe("completePosReset", () => {
  const live = {
    id: "st1",
    user_id: "fb1",
    reset_expires_at: new Date(Date.now() + 60_000).toISOString(),
  };

  it("validates the new credential's format", async () => {
    expect((await completePosReset("t", "pin", "1234")).error).toMatch(
      /8 digits/i,
    );
    expect((await completePosReset("t", "password", "short")).error).toMatch(
      /at least 8/i,
    );
  });

  it("rejects an expired token", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          {
            ...live,
            reset_expires_at: new Date(Date.now() - 1000).toISOString(),
          },
        ],
      ],
    });
    expect((await completePosReset("t", "pin", "12345678")).error).toMatch(
      /expired/i,
    );
  });

  it("hashes a new PIN and consumes the token", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[live]] });
    const r = await completePosReset("t", "pin", "87654321");
    expect(r.success).toBe(true);

    const set = dbHolder.current.calls.set[0];
    expect(set.pinHash).toMatch(/^scrypt\$/);
    expect(set.resetToken).toBeNull();
    // A PIN reset must not touch the Firebase password.
    expect(updateAuthUser).not.toHaveBeenCalled();
  });

  it("writes a new password to the auth account and consumes the token", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[live]] });
    const r = await completePosReset("t", "password", "a-new-password");
    expect(r.success).toBe(true);
    expect(updateAuthUser).toHaveBeenCalledWith("fb1", {
      password: "a-new-password",
    });

    const set = dbHolder.current.calls.set[0];
    expect(set.resetToken).toBeNull();
    // A password reset must not change the PIN.
    expect(set.pinHash).toBeUndefined();
  });
});
