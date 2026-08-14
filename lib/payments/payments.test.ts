import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";

import { encryptSecret, decryptSecret } from "./crypto";
import {
  capturedPayment,
  verifyCheckoutSignature,
  verifyWebhookSignature,
} from "./razorpay";

const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

describe("payments crypto (AES-256-GCM)", () => {
  beforeEach(() => {
    process.env.PAYMENT_CRED_KEY = TEST_KEY;
  });
  afterEach(() => {
    delete process.env.PAYMENT_CRED_KEY;
  });

  it("round-trips a secret", () => {
    const secret = "rzp_test_secret_9xYz";
    expect(decryptSecret(encryptSecret(secret))).toBe(secret);
  });

  it("produces a fresh ciphertext per call (random IV)", () => {
    expect(encryptSecret("same")).not.toBe(encryptSecret("same"));
  });

  it("rejects tampered ciphertext (GCM auth)", () => {
    const enc = Buffer.from(encryptSecret("secret"), "base64");
    enc[enc.length - 1] ^= 0xff; // flip a ciphertext bit
    expect(() => decryptSecret(enc.toString("base64"))).toThrow();
  });

  it("rejects truncated input", () => {
    expect(() => decryptSecret(Buffer.alloc(4).toString("base64"))).toThrow(
      "Corrupt encrypted secret.",
    );
  });

  it("refuses to run without PAYMENT_CRED_KEY", () => {
    delete process.env.PAYMENT_CRED_KEY;
    expect(() => encryptSecret("x")).toThrow("PAYMENT_CRED_KEY");
  });

  it("refuses a wrong-sized key", () => {
    process.env.PAYMENT_CRED_KEY = Buffer.alloc(16, 1).toString("base64");
    expect(() => encryptSecret("x")).toThrow("32 bytes");
  });
});

describe("verifyCheckoutSignature", () => {
  const secret = "test_secret";
  const orderId = "order_IluGWxBm9U8zJ8";
  const paymentId = "pay_IluGWxBm9U8zJ9";
  const valid = createHmac("sha256", secret)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");

  it("accepts the correct HMAC", () => {
    expect(verifyCheckoutSignature(secret, orderId, paymentId, valid)).toBe(
      true,
    );
  });

  it("rejects a wrong signature", () => {
    const wrong = valid.replace(/^./, valid[0] === "a" ? "b" : "a");
    expect(verifyCheckoutSignature(secret, orderId, paymentId, wrong)).toBe(
      false,
    );
  });

  it("rejects a signature for a different payment", () => {
    expect(verifyCheckoutSignature(secret, orderId, "pay_other", valid)).toBe(
      false,
    );
  });

  it("rejects a signature minted with a different secret", () => {
    const forged = createHmac("sha256", "other_secret")
      .update(`${orderId}|${paymentId}`)
      .digest("hex");
    expect(verifyCheckoutSignature(secret, orderId, paymentId, forged)).toBe(
      false,
    );
  });

  it("rejects empty inputs outright", () => {
    expect(verifyCheckoutSignature("", orderId, paymentId, valid)).toBe(false);
    expect(verifyCheckoutSignature(secret, "", paymentId, valid)).toBe(false);
    expect(verifyCheckoutSignature(secret, orderId, "", valid)).toBe(false);
    expect(verifyCheckoutSignature(secret, orderId, paymentId, "")).toBe(false);
  });

  it("rejects length-mismatched signatures without throwing", () => {
    expect(verifyCheckoutSignature(secret, orderId, paymentId, "abc")).toBe(
      false,
    );
  });
});

describe("capturedPayment", () => {
  it("finds the captured attempt among failures", () => {
    const payments = [
      { id: "pay_1", order_id: "o", amount: 100, status: "failed" },
      { id: "pay_2", order_id: "o", amount: 100, status: "captured" },
    ];
    expect(capturedPayment(payments)?.id).toBe("pay_2");
  });

  it("returns null when nothing was captured", () => {
    expect(
      capturedPayment([
        { id: "pay_1", order_id: "o", amount: 100, status: "failed" },
      ]),
    ).toBeNull();
  });

  it("returns null for no attempts", () => {
    expect(capturedPayment([])).toBeNull();
  });
});

describe("verifyWebhookSignature", () => {
  const secret = "whsec_test";
  const body = '{"event":"subscription.charged","x":1}';
  const valid = createHmac("sha256", secret).update(body).digest("hex");

  it("accepts a matching body signature", () => {
    expect(verifyWebhookSignature(secret, body, valid)).toBe(true);
  });

  it("rejects a tampered body", () => {
    expect(verifyWebhookSignature(secret, body + " ", valid)).toBe(false);
  });

  it("rejects a wrong secret", () => {
    const forged = createHmac("sha256", "nope").update(body).digest("hex");
    expect(verifyWebhookSignature(secret, body, forged)).toBe(false);
  });

  it("rejects empty inputs", () => {
    expect(verifyWebhookSignature("", body, valid)).toBe(false);
    expect(verifyWebhookSignature(secret, "", valid)).toBe(false);
    expect(verifyWebhookSignature(secret, body, "")).toBe(false);
  });
});
