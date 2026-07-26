import { describe, it, expect } from "vitest";
import { hashPin, verifyPin, isValidPinFormat } from "./pin";

describe("pos pin", () => {
  it("verifies a correct PIN and rejects a wrong one", () => {
    const stored = hashPin("12345678");
    expect(verifyPin("12345678", stored)).toBe(true);
    expect(verifyPin("12345679", stored)).toBe(false);
    expect(verifyPin("1234567", stored)).toBe(false);
  });

  it("salts each hash (same PIN → different stored value)", () => {
    expect(hashPin("42424242")).not.toBe(hashPin("42424242"));
  });

  it("is self-describing (scrypt$N$salt$hash)", () => {
    expect(hashPin("12345678")).toMatch(/^scrypt\$\d+\$[^$]+\$[^$]+$/);
  });

  it("rejects null / malformed stored hashes without throwing", () => {
    expect(verifyPin("12345678", null)).toBe(false);
    expect(verifyPin("12345678", undefined)).toBe(false);
    expect(verifyPin("12345678", "")).toBe(false);
    expect(verifyPin("12345678", "garbage")).toBe(false);
    expect(verifyPin("12345678", "bcrypt$1$2$3")).toBe(false);
    expect(verifyPin("12345678", "scrypt$notanumber$salt$hash")).toBe(false);
  });

  // Staff set an EXACTLY 8-digit PIN at registration.
  it("validates PIN format (exactly 8 digits)", () => {
    expect(isValidPinFormat("12345678")).toBe(true);
    expect(isValidPinFormat("00000000")).toBe(true);
    expect(isValidPinFormat("1234")).toBe(false);
    expect(isValidPinFormat("1234567")).toBe(false);
    expect(isValidPinFormat("123456789")).toBe(false);
    expect(isValidPinFormat("12a45678")).toBe(false);
    expect(isValidPinFormat("")).toBe(false);
    expect(isValidPinFormat(12345678 as unknown)).toBe(false);
    expect(isValidPinFormat(null)).toBe(false);
  });
});
