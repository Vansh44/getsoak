/* eslint-disable @typescript-eslint/no-explicit-any */
// Where payment credentials come from.
//
// Two entirely separate accounts, and keeping them apart is the point: a
// STORE's BYO gateway (order money settles with the merchant) versus the
// PLATFORM's own (AI credits only). Mixing them would route a merchant's sales
// into our account or bill our purchases to theirs.
//
// ── What is actually at stake here ─────────────────────────────────────────
// ★ Every failure must resolve to NULL, never to a throw and never to partial
// credentials. `getStoreGateway` is called on the checkout path and by every
// refund; a rotated PAYMENT_CRED_KEY or a corrupt row has to degrade the store
// to COD, not take checkout down. Returning half a credential pair would be
// worse still — it would reach Razorpay and fail there, after the customer has
// committed.
//
// ⚠ WHAT THIS CANNOT COVER. `decryptSecret` is stubbed, so nothing here proves
// the AES round-trip — that is payments.test.ts's job — only that a decrypt
// failure is caught rather than propagated.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeDbMock } from "@/app/actions/_test-helpers";

vi.mock("./crypto", () => ({ decryptSecret: vi.fn() }));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (fn: any) => fn(dbHolder.current.db)),
}));

import { decryptSecret } from "./crypto";
import { logError } from "@/lib/observability/logger";
import { getPlatformRazorpayCreds, getStoreGateway } from "./provider";

const STORE = "store-1";
const ROW = {
  key_id: "rzp_live_merchant",
  key_secret_enc: "enc:blob",
  enabled: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(decryptSecret).mockReturnValue("plaintext-secret");
  dbHolder.current = makeDbMock({ selectQueue: [[ROW]] });
});

// ---------------------------------------------------------------------------
// getStoreGateway
// ---------------------------------------------------------------------------

describe("getStoreGateway", () => {
  it("returns the decrypted pair for a connected store", async () => {
    const gw = await getStoreGateway(STORE);
    expect(gw).toEqual({
      creds: { keyId: "rzp_live_merchant", keySecret: "plaintext-secret" },
      enabled: true,
    });
    expect(decryptSecret).toHaveBeenCalledWith("enc:blob");
  });

  it("★ returns null when the store has never connected one", async () => {
    // Not an error — most stores are COD-only, and this is the ordinary answer.
    dbHolder.current = makeDbMock({ selectQueue: [[]] });
    expect(await getStoreGateway(STORE)).toBeNull();
    expect(decryptSecret).not.toHaveBeenCalled();
  });

  it("★ still returns the creds when the gateway is PAUSED", async () => {
    // `enabled` is reported, not enforced. A paused gateway must still be
    // reachable for refunds on orders it already took money for — otherwise
    // pausing would strand every past customer's money.
    dbHolder.current = makeDbMock({
      selectQueue: [[{ ...ROW, enabled: false }]],
    });
    const gw = await getStoreGateway(STORE);
    expect(gw?.enabled).toBe(false);
    expect(gw?.creds.keySecret).toBe("plaintext-secret");
  });

  it.each([null, undefined, 0, ""])(
    "reads a falsy enabled (%s) as a real boolean",
    async (enabled) => {
      // It reaches a client-visible config flag, so `null` leaking through
      // instead of `false` would render as neither on nor off.
      dbHolder.current = makeDbMock({
        selectQueue: [[{ ...ROW, enabled }]],
      });
      expect((await getStoreGateway(STORE))?.enabled).toBe(false);
    },
  );

  it("★ returns null rather than throwing when the query fails", async () => {
    // The caller is rendering checkout or a refund panel. A DB blip must
    // degrade the store to COD, not take the page down.
    dbHolder.current = {
      db: {
        select: () => {
          throw new Error("connection reset");
        },
      },
      calls: { select: [] },
    };
    expect(await getStoreGateway(STORE)).toBeNull();
    expect(logError).toHaveBeenCalledWith(
      "payments.gateway_load",
      expect.any(Error),
      { storeId: STORE },
    );
  });

  it("★★ returns null when the stored secret won't decrypt", async () => {
    // A rotated or wrong PAYMENT_CRED_KEY, or a corrupt row. This is the
    // branch that must not throw: it runs inside checkout, and the failure
    // mode of getting it wrong is a 500 at the moment of payment rather than
    // a quiet fall back to cash on delivery.
    vi.mocked(decryptSecret).mockImplementation(() => {
      throw new Error("Unsupported state or unable to authenticate data");
    });
    expect(await getStoreGateway(STORE)).toBeNull();
    expect(logError).toHaveBeenCalledWith(
      "payments.gateway_decrypt",
      expect.objectContaining({
        message: "Unsupported state or unable to authenticate data",
      }),
      { storeId: STORE },
    );
  });

  it("survives a non-Error thrown by the decrypt layer", async () => {
    vi.mocked(decryptSecret).mockImplementation(() => {
      throw "just a string";
    });
    // logError normalises it into an Error, so a thrown string still reaches
    // Error Reporting with a stack instead of vanishing into a log line.
    expect(await getStoreGateway(STORE)).toBeNull();
    expect(logError).toHaveBeenCalledWith(
      "payments.gateway_decrypt",
      "just a string",
      { storeId: STORE },
    );
  });

  it("survives a non-Error thrown by the query", async () => {
    dbHolder.current = {
      db: {
        select: () => {
          throw "db exploded";
        },
      },
      calls: { select: [] },
    };
    expect(await getStoreGateway(STORE)).toBeNull();
    expect(logError).toHaveBeenCalledWith(
      "payments.gateway_load",
      "db exploded",
      { storeId: STORE },
    );
  });
});

// ---------------------------------------------------------------------------
// getPlatformRazorpayCreds
// ---------------------------------------------------------------------------

describe("getPlatformRazorpayCreds", () => {
  const KEY_ID = process.env.RAZORPAY_KEY_ID;
  const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

  function setEnv(id?: string, secret?: string) {
    if (id === undefined) delete process.env.RAZORPAY_KEY_ID;
    else process.env.RAZORPAY_KEY_ID = id;
    if (secret === undefined) delete process.env.RAZORPAY_KEY_SECRET;
    else process.env.RAZORPAY_KEY_SECRET = secret;
  }

  afterEach(() => setEnv(KEY_ID, KEY_SECRET));

  it("returns the platform pair when both are set", async () => {
    setEnv("rzp_live_platform", "platform-secret");
    expect(getPlatformRazorpayCreds()).toEqual({
      keyId: "rzp_live_platform",
      keySecret: "platform-secret",
    });
  });

  it.each([
    ["neither set", undefined, undefined],
    ["no key id", undefined, "secret"],
    ["no secret", "rzp_live_platform", undefined],
    ["a blank key id", "", "secret"],
    ["a blank secret", "rzp_live_platform", ""],
  ])(
    "★ returns null with %s — never a half pair",
    async (_label, id, secret) => {
      // Half a credential pair would sail past a truthiness check and fail at
      // Razorpay instead, after the customer has committed to paying.
      setEnv(id, secret);
      expect(getPlatformRazorpayCreds()).toBeNull();
    },
  );

  it("★ is entirely separate from any store's gateway", async () => {
    // The platform account bills AI credits; a store's takes its own sales.
    // Crossing them would settle a merchant's revenue into our account.
    setEnv("rzp_live_platform", "platform-secret");
    const platform = getPlatformRazorpayCreds();
    const store = await getStoreGateway(STORE);
    expect(platform!.keyId).not.toBe(store!.creds.keyId);
    expect(platform!.keySecret).not.toBe(store!.creds.keySecret);
  });
});
