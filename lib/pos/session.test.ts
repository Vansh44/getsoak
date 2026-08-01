import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";

beforeAll(() => {
  process.env.POS_SESSION_SECRET = "unit-test-pos-secret-please-change";
});
afterEach(() => vi.restoreAllMocks());

import {
  signDeviceToken,
  verifyDeviceToken,
  signOperatorToken,
  verifyOperatorToken,
} from "./session";

const DEVICE = {
  deviceId: "d1",
  storeId: "s1",
  locationId: "l1",
  nonce: "n1",
};
const OP = {
  staffId: "st1",
  storeId: "s1",
  locationId: "l1",
  // The operator session is bound to the authorized device it was created on.
  deviceId: "d1",
  role: "cashier" as const,
  name: "Priya",
};

describe("pos session tokens", () => {
  it("round-trips a device token", () => {
    const c = verifyDeviceToken(signDeviceToken(DEVICE));
    expect(c).toMatchObject({ t: "device", ...DEVICE });
    expect(c!.exp).toBeGreaterThan(Date.now() / 1000);
  });

  it("round-trips an operator token", () => {
    const c = verifyOperatorToken(signOperatorToken(OP));
    expect(c).toMatchObject({ t: "operator", ...OP });
  });

  it("rejects a tampered payload", () => {
    const token = signDeviceToken(DEVICE);
    const [payload, mac] = token.split(".");
    const flipped = payload.slice(0, -1) + (payload.at(-1) === "A" ? "B" : "A");
    expect(verifyDeviceToken(`${flipped}.${mac}`)).toBeNull();
  });

  it("rejects a forged signature", () => {
    const payload = signDeviceToken(DEVICE).split(".")[0];
    expect(verifyDeviceToken(`${payload}.not-the-real-mac`)).toBeNull();
  });

  it("rejects a token of the wrong type", () => {
    // An operator token must not validate as a device token, and vice versa.
    expect(verifyDeviceToken(signOperatorToken(OP))).toBeNull();
    expect(verifyOperatorToken(signDeviceToken(DEVICE))).toBeNull();
  });

  it("rejects malformed / empty tokens", () => {
    expect(verifyDeviceToken(undefined)).toBeNull();
    expect(verifyDeviceToken("")).toBeNull();
    expect(verifyDeviceToken("no-dot-here")).toBeNull();
    expect(verifyDeviceToken(".onlymac")).toBeNull();
  });

  it("rejects an expired token", () => {
    const token = signOperatorToken(OP);
    // Jump 13h ahead — past the 12h operator TTL.
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 13 * 60 * 60 * 1000);
    expect(verifyOperatorToken(token)).toBeNull();
  });

  it("rejects a token signed with a different secret", () => {
    const token = signDeviceToken(DEVICE);
    process.env.POS_SESSION_SECRET = "a-completely-different-secret";
    expect(verifyDeviceToken(token)).toBeNull();
    process.env.POS_SESSION_SECRET = "unit-test-pos-secret-please-change";
  });

  it("returns null (never throws) when the secret is unset", () => {
    const token = signDeviceToken(DEVICE);
    const saved = process.env.POS_SESSION_SECRET;
    delete process.env.POS_SESSION_SECRET;
    expect(verifyDeviceToken(token)).toBeNull();
    process.env.POS_SESSION_SECRET = saved;
  });
});
