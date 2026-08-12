import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// App-layer encryption for stored channel secrets (AES-256-GCM).
// Defense in depth: provider credential tables are already service-role-only at
// the DB layer, but a merchant's Razorpay or Shiprocket secret must not be readable
// from a DB dump alone — it's encrypted with PAYMENT_CRED_KEY (32-byte,
// base64) which lives only in the app environment.
//
// Wire format: base64("v1" is implied) of `iv (12B) || authTag (16B) || ciphertext`.
// Key rotation = decrypt-with-old, re-encrypt-with-new script (offline).

const IV_LENGTH = 12; // GCM standard nonce size
const TAG_LENGTH = 16;

function credKey(): Buffer {
  const raw = process.env.PAYMENT_CRED_KEY;
  if (!raw) {
    throw new Error(
      "PAYMENT_CRED_KEY is not set — cannot handle payment credentials.",
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("PAYMENT_CRED_KEY must be 32 bytes, base64-encoded.");
  }
  return key;
}

/** Encrypt a secret for storage in a service-only provider table. */
export function encryptSecret(plaintext: string): string {
  const key = credKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString(
    "base64",
  );
}

/** Decrypt a stored secret. Throws on tampering (GCM auth failure). */
export function decryptSecret(encoded: string): string {
  const key = credKey();
  const buf = Buffer.from(encoded, "base64");
  if (buf.length < IV_LENGTH + TAG_LENGTH) {
    throw new Error("Corrupt encrypted secret.");
  }
  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}
