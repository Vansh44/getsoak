// POS staff PIN hashing (scrypt via node:crypto). A PIN is a low-entropy secret,
// so it is salted + hashed (never stored plaintext) and verified in constant
// time; the unlock action additionally rate-limits attempts per device.
//
// Stored format: `scrypt$<N>$<saltB64>$<hashB64>` — self-describing so the cost
// can be raised later without breaking existing hashes.

import "server-only";

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const N = 16384; // scrypt cost (2^14); r=8,p=1 → ~16MB, under the default maxmem
const KEYLEN = 32;

/** An 8-digit numeric PIN — the register's fast credential (staff set it at
 *  registration). Fixed length keeps the entry pad predictable. */
export function isValidPinFormat(pin: unknown): pin is string {
  return typeof pin === "string" && /^\d{8}$/.test(pin);
}

export function hashPin(pin: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(pin, salt, KEYLEN, { N });
  return `scrypt$${N}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

/** Constant-time PIN check against a stored hash. False on any malformed input. */
export function verifyPin(
  pin: string,
  stored: string | null | undefined,
): boolean {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "scrypt") return false;
  const cost = Number(parts[1]);
  if (!Number.isInteger(cost) || cost < 2) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[2], "base64");
    expected = Buffer.from(parts[3], "base64");
  } catch {
    return false;
  }
  let hash: Buffer;
  try {
    hash = scryptSync(pin, salt, expected.length, { N: cost });
  } catch {
    return false;
  }
  return hash.length === expected.length && timingSafeEqual(hash, expected);
}
