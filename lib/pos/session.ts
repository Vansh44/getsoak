// POS signed sessions (docs/pos-plan.md §3). Two HMAC-signed, stateless cookies
// distinct from the Firebase `sm_session`:
//
//   pos_device   — a paired register: {storeId, locationId, deviceId}. Long-lived.
//                  Reaches /pos + the PIN pad, but can NOT sell on its own.
//   pos_operator — the active staff after a PIN unlock: {staffId, storeId,
//                  locationId, role}. Short-lived (+ idle). Authorises the sale.
//
// Both are verified with HMAC-SHA256 over POS_SESSION_SECRET — no DB call — so
// the Node-runtime proxy can gate /pos cheaply. Revocation (a lost tablet) is a
// DB check done in the /pos layout, not here. No `server-only`: proxy.ts (Node
// middleware) verifies these, and node:crypto can't run in a browser bundle
// anyway.

import { createHmac, timingSafeEqual } from "node:crypto";

export const POS_DEVICE_COOKIE = "pos_device";
export const POS_OPERATOR_COOKIE = "pos_operator";

// A paired register cookie lasts a season; an operator session is a shift.
export const POS_DEVICE_MAX_AGE_S = 90 * 24 * 60 * 60;
export const POS_OPERATOR_MAX_AGE_S = 12 * 60 * 60;

function secretOrNull(): string | null {
  return process.env.POS_SESSION_SECRET || null;
}

// Signing MUST have a secret; verifying without one just means "no valid
// session" (so the proxy never 500s when POS isn't configured — it falls to the
// login/pro-gate instead of throwing).
function requireSecret(): string {
  const s = secretOrNull();
  if (!s) {
    throw new Error(
      "POS_SESSION_SECRET is not set — cannot sign POS sessions.",
    );
  }
  return s;
}

interface BaseClaims {
  iat: number;
  exp: number;
}

export interface PosDeviceClaims extends BaseClaims {
  t: "device";
  deviceId: string;
  storeId: string;
  locationId: string;
  /**
   * Rotation nonce, checked against pos_devices.token_nonce. Rotated on every
   * operator sign-in, so a COPIED cookie is detected the next time either copy
   * is used (see getAuthorizedDevice). A signature alone can't catch a clone —
   * the clone carries a perfectly valid signature.
   */
  nonce: string;
}

export interface PosOperatorClaims extends BaseClaims {
  t: "operator";
  staffId: string;
  storeId: string;
  locationId: string;
  /** The authorized device this operator signed in on (ties the session to the
   *  device, so revoking the device kills the operator session). */
  deviceId: string;
  role: "cashier" | "manager";
  name: string;
}

function mac(payload: string, key: string): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

function sign(payloadObj: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString("base64url");
  return `${payload}.${mac(payload, requireSecret())}`;
}

function verify<T extends BaseClaims>(
  token: string | undefined | null,
  expectedType: string,
): T | null {
  if (!token || typeof token !== "string") return null;
  const key = secretOrNull();
  if (!key) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const provided = token.slice(dot + 1);

  // Constant-time compare of the signature.
  const expected = mac(payload, key);
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!obj || obj.t !== expectedType) return null;
  if (typeof obj.exp !== "number" || obj.exp * 1000 < Date.now()) return null;
  return obj as unknown as T;
}

export function signDeviceToken(
  claims: Pick<
    PosDeviceClaims,
    "deviceId" | "storeId" | "locationId" | "nonce"
  >,
): string {
  const now = Math.floor(Date.now() / 1000);
  return sign({
    t: "device",
    ...claims,
    iat: now,
    exp: now + POS_DEVICE_MAX_AGE_S,
  });
}

export function verifyDeviceToken(
  token: string | undefined | null,
): PosDeviceClaims | null {
  return verify<PosDeviceClaims>(token, "device");
}

export function signOperatorToken(
  claims: Pick<
    PosOperatorClaims,
    "staffId" | "storeId" | "locationId" | "deviceId" | "role" | "name"
  >,
): string {
  const now = Math.floor(Date.now() / 1000);
  return sign({
    t: "operator",
    ...claims,
    iat: now,
    exp: now + POS_OPERATOR_MAX_AGE_S,
  });
}

export function verifyOperatorToken(
  token: string | undefined | null,
): PosOperatorClaims | null {
  return verify<PosOperatorClaims>(token, "operator");
}
