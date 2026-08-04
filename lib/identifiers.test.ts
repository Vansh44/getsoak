import { describe, it, expect } from "vitest";
import {
  luhnCheckDigit,
  isValidCode,
  formatStoreCode,
  formatSku,
  formatVariantSku,
  formatOrderRef,
  formatCreditNoteRef,
  refKind,
} from "./identifiers";

describe("luhnCheckDigit", () => {
  // The canonical vectors from the spec — these MUST match the SQL sm_luhn()
  // used by the backfill (supabase/identifiers_02_backfill.sql), so both paths
  // produce identical codes for the same numbers.
  it("computes the documented check digits", () => {
    expect(luhnCheckDigit("10010001")).toBe(5); // store 1001, product 0001
    expect(luhnCheckDigit("10011000")).toBe(6); // store 1001, order 1000
    expect(luhnCheckDigit("1001000101")).toBe(3); // store 1001, prod 0001, var 01
  });

  it("ignores non-digit characters (can be passed a full code)", () => {
    expect(luhnCheckDigit("SKU10010001")).toBe(luhnCheckDigit("10010001"));
  });

  it("always returns a single digit 0-9", () => {
    for (let n = 0; n < 500; n++) {
      const d = luhnCheckDigit(String(n));
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(9);
    }
  });
});

describe("format generators (exact strings from the spec)", () => {
  it("store code is a bare, zero-padded number", () => {
    expect(formatStoreCode(1000)).toBe("1000");
    expect(formatStoreCode(1001)).toBe("1001");
    expect(formatStoreCode(12345)).toBe("12345"); // grows past 4 digits
  });

  it("product SKU", () => {
    expect(formatSku(1001, 1)).toBe("SKU100100015");
    expect(formatSku(1001, 7)).toBe("SKU100100072");
  });

  it("variant SKU (parent product code + V## + check)", () => {
    expect(formatVariantSku(1001, 1, 1)).toBe("SKU10010001V013");
  });

  it("order reference", () => {
    expect(formatOrderRef(1001, 1000)).toBe("ORD100110006");
  });

  it("credit note reference", () => {
    // Same grammar as an order ref, different prefix — so the SQL mirror
    // sm_credit_note_ref() in returns_04_credit_notes.sql produces this too.
    // 1001 + 0001 has Luhn check 5 (the vector above).
    expect(formatCreditNoteRef(1001, 1)).toBe("CRN100100015");
    expect(formatCreditNoteRef(1001, 1000)).toBe("CRN100110006");
  });

  // ★ THE SQL MIRROR TRUNCATED PAST 9999, AND THESE ARE THE VECTORS THAT
  // CAUGHT IT (verified against staging 2026-08-03).
  //
  // Postgres `lpad('12345', 4, '0')` returns '1234' — it truncates as well as
  // pads. Every formatter in identifiers_04_triggers.sql padded to exactly 4,
  // so a store's 10,000th order/product silently lost a digit:
  //     sm_order_ref(1001,  1000) = ORD100110006
  //     sm_order_ref(1001, 10000) = ORD100110006   ← the same string
  // `(store_id, sku)` is UNIQUE, so the 10,000th product FAILED TO INSERT;
  // order_ref isn't, so orders quietly shared a customer-visible reference.
  // Fixed by supabase/identifiers_05_no_truncate.sql. These assertions are
  // what its migration-time guard checks itself against.
  it("★ codes GROW past their pad width — they never truncate", () => {
    expect(formatOrderRef(1001, 12345)).toBe("ORD1001123452");
    expect(formatSku(1001, 12345)).toBe("SKU1001123452");
    expect(formatCreditNoteRef(1001, 12345)).toBe("CRN1001123452");
    // 5-digit sequence stays 5 digits — "12345", not "1234".
    expect(formatOrderRef(1001, 12345)).toContain("100112345");
  });

  it("★ …and a 5-digit sequence never collides with a 4-digit one", () => {
    // The actual production symptom: these MUST differ.
    expect(formatOrderRef(1001, 10000)).not.toBe(formatOrderRef(1001, 1000));
    expect(formatSku(1001, 10000)).not.toBe(formatSku(1001, 1000));
    expect(formatCreditNoteRef(1001, 10000)).not.toBe(
      formatCreditNoteRef(1001, 1000),
    );
  });

  it("leaves already-issued codes untouched below the wall", () => {
    // Why identifiers_05 is safe to run: at ≤ 9999 the fixed and broken forms
    // are byte-identical, so no code that has ever been issued changes.
    expect(formatOrderRef(1001, 1000)).toBe("ORD100110006");
    expect(formatSku(1001, 1)).toBe("SKU100100015");
    expect(formatCreditNoteRef(1001, 1)).toBe("CRN100100015");
  });
});

describe("isValidCode", () => {
  it("accepts every freshly generated code", () => {
    for (let store = 1000; store < 1010; store++) {
      for (let seq = 1; seq < 60; seq++) {
        expect(isValidCode(formatSku(store, seq))).toBe(true);
        expect(isValidCode(formatOrderRef(store, 1000 + seq))).toBe(true);
        expect(isValidCode(formatVariantSku(store, seq, 1))).toBe(true);
      }
    }
  });

  it("rejects a code whose check digit was altered", () => {
    const good = formatOrderRef(1001, 1000); // ORD100110006
    const bad = good.slice(0, -1) + ((Number(good.slice(-1)) + 1) % 10);
    expect(isValidCode(bad)).toBe(false);
  });

  it("catches a single-digit transposition in the payload", () => {
    // ORD100110006 -> swap two adjacent payload digits; check no longer matches.
    const good = "ORD100110006";
    expect(isValidCode(good)).toBe(true);
    const swapped = "ORD100101006"; // 1000 -> 0100 within the sequence portion
    expect(isValidCode(swapped)).toBe(false);
  });

  it("rejects junk / too-short input", () => {
    expect(isValidCode("")).toBe(false);
    expect(isValidCode("SKU")).toBe(false);
    expect(isValidCode("nope")).toBe(false);
  });
});

describe("refKind", () => {
  it("routes by prefix, case-insensitively", () => {
    expect(refKind("SKU100100015")).toBe("sku");
    expect(refKind("ord100110006")).toBe("order");
    expect(refKind("1001")).toBeNull();
  });
});
