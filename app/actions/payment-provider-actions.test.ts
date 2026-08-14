/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock } from "./_test-helpers";

vi.mock("@/app/dashboard/lib/access", () => ({
  getManagerUserId: vi.fn(),
  getActingStoreId: vi.fn(async () => STORE),
}));
vi.mock("@/lib/payments/crypto", () => ({
  encryptSecret: vi.fn((s: string) => `enc(${s})`),
}));
vi.mock("@/lib/payments/razorpay", () => ({
  validateCredentials: vi.fn(),
}));

// The ported data layer: with* runners invoke the callback with the mock db.
const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withUser: vi.fn((_identity: any, fn: any) =>
    Promise.resolve(fn(dbHolder.current.db)),
  ),
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
  withAnon: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import {
  getChannelState,
  saveRazorpayCredentials,
  setRazorpayEnabled,
  disconnectRazorpay,
} from "./payment-provider-actions";
import { getManagerUserId } from "@/app/dashboard/lib/access";
import { validateCredentials } from "@/lib/payments/razorpay";

const STORE = "a0000000-0000-4000-8000-000000000001";
const KEY_ID = "rzp_test_abc123XYZ";
const SECRET = "super_secret_value";

const storeRow = (plan: string) => ({ plan, plan_expires_at: null });

beforeEach(() => {
  vi.clearAllMocks();
  dbHolder.current = makeDbMock({ returning: [{ store_id: STORE }] });
  vi.mocked(getManagerUserId).mockResolvedValue("admin-1");
  vi.mocked(validateCredentials).mockResolvedValue({
    ok: true,
    data: true,
  } as any);
});

// saveRazorpayCredentials — select #1 = the plan-gate stores read.
describe("saveRazorpayCredentials", () => {
  it("rejects a caller without channels manage permission", async () => {
    vi.mocked(getManagerUserId).mockResolvedValue(null);
    const res = await saveRazorpayCredentials(KEY_ID, SECRET);
    expect(res.error).toMatch(/permission/i);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("enforces the plan gate server-side (free plan blocked)", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[storeRow("free")]] });
    const res = await saveRazorpayCredentials(KEY_ID, SECRET);
    expect(res.error).toMatch(/basic plan/i);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("rejects a malformed key id before calling Razorpay", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[storeRow("basic")]] });
    const res = await saveRazorpayCredentials("not-a-key", SECRET);
    expect(res.error).toMatch(/key id/i);
    expect(validateCredentials).not.toHaveBeenCalled();
  });

  it("rejects credentials Razorpay itself refuses", async () => {
    vi.mocked(validateCredentials).mockResolvedValue({
      ok: false,
      error: "Authentication failed",
    } as any);
    dbHolder.current = makeDbMock({ selectQueue: [[storeRow("basic")]] });
    const res = await saveRazorpayCredentials(KEY_ID, SECRET);
    expect(res.error).toMatch(/rejected/i);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("verifies, encrypts the secret, and enables the gateway", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[storeRow("basic")]] });
    const res = await saveRazorpayCredentials(` ${KEY_ID} `, ` ${SECRET} `);
    expect(res.success).toBe(true);
    expect(validateCredentials).toHaveBeenCalledWith({
      keyId: KEY_ID,
      keySecret: SECRET,
    });
    const upserted = dbHolder.current.calls.values[0];
    expect(upserted.keyId).toBe(KEY_ID);
    // The secret is stored ENCRYPTED, never plaintext.
    expect(upserted.keySecretEnc).toBe(`enc(${SECRET})`);
    expect(upserted).not.toHaveProperty("keySecret");
    expect(upserted.enabled).toBe(true);
    expect(upserted.storeId).toBe(STORE);
    // Reconnecting updates the single per-store row via the conflict clause.
    expect(dbHolder.current.calls.onConflict).toHaveLength(1);
  });
});

describe("setRazorpayEnabled", () => {
  it("blocks enabling on a plan without online payments", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[storeRow("free")]] });
    const res = await setRazorpayEnabled(true);
    expect(res.error).toMatch(/basic plan/i);
  });

  it("allows PAUSING regardless of plan (no upsell wall to turn things off)", async () => {
    // Disabling skips the plan check entirely; the update matches a row.
    dbHolder.current = makeDbMock({ returning: [{ store_id: STORE }] });
    const res = await setRazorpayEnabled(false);
    expect(res.success).toBe(true);
    expect(dbHolder.current.calls.set[0]).toMatchObject({ enabled: false });
  });

  it("errors when nothing is connected yet", async () => {
    dbHolder.current = makeDbMock({
      returning: [],
      selectQueue: [[storeRow("basic")]],
    });
    const res = await setRazorpayEnabled(true);
    expect(res.error).toMatch(/connect razorpay first/i);
  });
});

// getChannelState — selects: #1 the provider row, #2 the plan-gate read.
describe("getChannelState", () => {
  it("returns the key id and enabled state — never the secret", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[{ key_id: KEY_ID, enabled: true }], [storeRow("basic")]],
    });
    const state = await getChannelState();
    expect(state).toEqual({
      connected: true,
      keyId: KEY_ID,
      enabled: true,
      planAllowsOnlinePayments: true,
      // Whether a webhook EXISTS, never its signing secret.
      webhookConfigured: false,
      webhookUrl: null,
    });
    // The provider-row projection never asks for the encrypted secret column.
    const projectionKeys = Object.keys(dbHolder.current.calls.select[0] ?? {});
    expect(projectionKeys.join(",")).not.toMatch(/secret/i);
  });

  it("reports not-connected for a fresh store", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[], [storeRow("basic")]],
    });
    const state = await getChannelState();
    expect(state.connected).toBe(false);
    expect(state.keyId).toBeNull();
  });
});

describe("disconnectRazorpay", () => {
  it("requires manage permission", async () => {
    vi.mocked(getManagerUserId).mockResolvedValue(null);
    const res = await disconnectRazorpay();
    expect(res.error).toMatch(/permission/i);
  });

  it("deletes the provider row for the acting store", async () => {
    const res = await disconnectRazorpay();
    expect(res.success).toBe(true);
    expect(dbHolder.current.calls.delete).toHaveLength(1);
    expect(dbHolder.current.calls.where).toHaveLength(1);
  });
});
