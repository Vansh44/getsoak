import "server-only";

// ---------------------------------------------------------------------------
// Svix webhook signature verification (Resend's webhooks are Svix-delivered).
//
// Written out rather than pulling in the svix SDK, matching how the Razorpay
// HMAC is done (lib/payments/razorpay.ts): it's ~30 lines of standard crypto,
// and a webhook verifier is exactly the code you want to be able to read.
//
// The endpoint is public and its payload decides whether we stop mailing an
// address. Unsigned, anyone could suppress a store's entire customer list.
// ---------------------------------------------------------------------------

import crypto from "crypto";

/** Reject anything older than this — a captured-and-replayed webhook is dead. */
const TOLERANCE_SECONDS = 5 * 60;

export interface SvixHeaders {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
}

/**
 * Verify a Svix-signed webhook body.
 *
 * @param secret the endpoint secret, `whsec_<base64>` as shown in the dashboard
 * @param body   the RAW request body — parsing then re-serialising changes the
 *               bytes and the signature will never match
 */
export function verifySvixSignature(
  secret: string,
  headers: SvixHeaders,
  body: string,
  now: Date = new Date(),
): { ok: true } | { ok: false; reason: string } {
  if (!secret) return { ok: false, reason: "no signing secret configured" };
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) {
    return { ok: false, reason: "missing svix headers" };
  }

  const sent = Number(timestamp);
  if (!Number.isFinite(sent)) {
    return { ok: false, reason: "malformed timestamp" };
  }
  const skew = Math.abs(Math.floor(now.getTime() / 1000) - sent);
  if (skew > TOLERANCE_SECONDS) {
    return { ok: false, reason: "timestamp outside tolerance" };
  }

  // The secret is base64 AFTER the `whsec_` prefix; the raw bytes are the key.
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = crypto
    .createHmac("sha256", key)
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64");

  // The header carries a space-separated list of `v<version>,<signature>` —
  // more than one during a secret rotation. Any valid v1 match is enough.
  for (const part of signature.split(" ")) {
    const [version, value] = part.split(",");
    if (version !== "v1" || !value) continue;
    if (timingSafeEqual(value, expected)) return { ok: true };
  }
  return { ok: false, reason: "no matching signature" };
}

/** Constant-time compare that can't throw on a length mismatch. */
function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
