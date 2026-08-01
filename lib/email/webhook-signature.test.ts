import { describe, it, expect } from "vitest";
import crypto from "crypto";
import { verifySvixSignature } from "./webhook-signature";

// This endpoint decides whether we stop mailing an address. Unsigned, anyone
// could POST a bounce for a store's whole customer list and cut it off.
const SECRET = `whsec_${Buffer.from("super-secret-key").toString("base64")}`;
const NOW = new Date("2026-07-27T12:00:00.000Z");
const TS = String(Math.floor(NOW.getTime() / 1000));

function sign(body: string, id = "msg_1", timestamp = TS, secret = SECRET) {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const digest = crypto
    .createHmac("sha256", key)
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64");
  return { id, timestamp, signature: `v1,${digest}` };
}

describe("verifySvixSignature", () => {
  const body = JSON.stringify({ type: "email.bounced" });

  it("accepts a correctly signed payload", () => {
    expect(verifySvixSignature(SECRET, sign(body), body, NOW)).toEqual({
      ok: true,
    });
  });

  it("rejects a tampered body", () => {
    const headers = sign(body);
    const result = verifySvixSignature(
      SECRET,
      headers,
      JSON.stringify({ type: "email.complained" }),
      NOW,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a signature made with a different secret", () => {
    const headers = sign(body, "msg_1", TS, "whsec_b3RoZXI=");
    expect(verifySvixSignature(SECRET, headers, body, NOW).ok).toBe(false);
  });

  it("rejects a replay from outside the tolerance window", () => {
    const old = String(Math.floor(NOW.getTime() / 1000) - 3600);
    const headers = sign(body, "msg_1", old);
    const result = verifySvixSignature(SECRET, headers, body, NOW);
    expect(result).toEqual({
      ok: false,
      reason: "timestamp outside tolerance",
    });
  });

  it("rejects a signature bound to a different message id", () => {
    // The id is part of the signed content, so lifting a signature from one
    // delivery onto another must not verify.
    const headers = { ...sign(body, "msg_1"), id: "msg_2" };
    expect(verifySvixSignature(SECRET, headers, body, NOW).ok).toBe(false);
  });

  it("accepts when one of several rotated signatures matches", () => {
    const good = sign(body);
    const headers = { ...good, signature: `v1,AAAAstale ${good.signature}` };
    expect(verifySvixSignature(SECRET, headers, body, NOW).ok).toBe(true);
  });

  it("ignores signature versions it doesn't understand", () => {
    const good = sign(body);
    const headers = {
      ...good,
      signature: good.signature.replace("v1,", "v2,"),
    };
    expect(verifySvixSignature(SECRET, headers, body, NOW).ok).toBe(false);
  });

  it("refuses when headers or the secret are missing", () => {
    expect(verifySvixSignature("", sign(body), body, NOW).ok).toBe(false);
    expect(
      verifySvixSignature(
        SECRET,
        { id: null, timestamp: null, signature: null },
        body,
        NOW,
      ).ok,
    ).toBe(false);
  });

  it("refuses a malformed timestamp instead of treating it as epoch 0", () => {
    const headers = { ...sign(body), timestamp: "not-a-number" };
    expect(verifySvixSignature(SECRET, headers, body, NOW)).toEqual({
      ok: false,
      reason: "malformed timestamp",
    });
  });
});
