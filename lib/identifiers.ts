// ---------------------------------------------------------------------------
// Human-readable business identifiers, layered ON TOP of the internal UUID keys
// (which stay the primary keys, foreign keys, and URL/lookup keys — never
// changed). These codes are for HUMANS: dashboard lists, order confirmations,
// invoices, packing labels, support. They are display + search values only;
// access control always stays on the UUID + store_id RLS.
//
// Compact grammar:   <TYPE><STORE><SEQ>[V<VAR>]<CHECK>
//   TYPE  : "SKU" (product / variant) or "ORD" (order)
//   STORE : store_no, zero-padded to >= 4 digits            (e.g. 1001)
//   SEQ   : per-store running number, zero-padded to >= 4    (product / order)
//   VAR   : per-product variant index, zero-padded to >= 2   (variant SKUs only)
//   CHECK : ONE Luhn (mod-10) check digit over ALL the numeric digits
//
// The store number is embedded in every code, so everything for a store shares
// the same core (store 1001 -> SKU1001…, ORD1001…). Because store_no is globally
// unique, 1001-codes can never collide with 1002-codes even though each store's
// SEQ counters restart from their own base. Every code is self-validating
// offline via the Luhn digit (a "closed" system — verify without a DB round-trip).
//
// Pure module (no server/React imports) so it is the single formatting authority
// shared by server actions, client components, and tests — mirrors
// lib/inventory/status.ts. The SQL backfill (supabase/identifiers_02_backfill.sql)
// re-implements the same Luhn + format and is cross-checked against these vectors.
// ---------------------------------------------------------------------------

export const SKU_PREFIX = "SKU";
export const ORDER_PREFIX = "ORD";
/** Credit note — a GST document, not a receipt. See formatCreditNoteRef. */
export const CREDIT_NOTE_PREFIX = "CRN";

// Minimum zero-pad widths (codes grow past these; they never truncate).
export const STORE_WIDTH = 4;
export const SEQ_WIDTH = 4;
export const VARIANT_WIDTH = 2;

// Counter start values (kept in sync with the SQL sequence / counter seeds).
export const STORE_NO_START = 1000; // first store  -> 1000
export const ORDER_NO_START = 1000; // first order  -> ORD….1000
export const PRODUCT_NO_START = 1; // first product -> …0001

function pad(n: number, width: number): string {
  const s = Math.trunc(Math.abs(n)).toString();
  return s.length >= width ? s : "0".repeat(width - s.length) + s;
}

// Luhn (mod-10) check digit for a string of decimal digits — the credit-card
// checksum. The digit is destined for the rightmost position, so the payload's
// rightmost digit sits at position 2 (doubled); we start doubling from there and
// alternate leftward. Non-digits are ignored so callers may pass a full code.
export function luhnCheckDigit(digits: string): number {
  let sum = 0;
  let double = true;
  for (let i = digits.length - 1; i >= 0; i--) {
    const c = digits.charCodeAt(i) - 48; // '0' === 48
    if (c < 0 || c > 9) continue; // skip letters / separators defensively
    let d = c;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return (10 - (sum % 10)) % 10;
}

// The numeric payload + its Luhn check digit.
export function appendLuhn(digits: string): string {
  return digits + luhnCheckDigit(digits);
}

// True when a code's trailing digit is the correct Luhn check for its numeric
// payload (all non-digit characters ignored). Cheap offline typo detection.
export function isValidCode(code: string): boolean {
  const digits = code.replace(/\D/g, "");
  if (digits.length < 2) return false;
  const payload = digits.slice(0, -1);
  const check = digits.charCodeAt(digits.length - 1) - 48;
  return luhnCheckDigit(payload) === check;
}

// ── Generators ────────────────────────────────────────────────────────────

// The store's short numeric code, e.g. 1001. Building block embedded in every
// other code; shown on its own without a check digit (the SKUs/orders that
// carry it protect the store digits via their own trailing check).
export function formatStoreCode(storeNo: number): string {
  return pad(storeNo, STORE_WIDTH);
}

// Product SKU: SKU + store + product-sequence + check. e.g. SKU100100015.
export function formatSku(storeNo: number, skuNo: number): string {
  const payload = pad(storeNo, STORE_WIDTH) + pad(skuNo, SEQ_WIDTH);
  return SKU_PREFIX + appendLuhn(payload);
}

// Variant SKU: parent product code + V + variant index + check.
// e.g. SKU10010001V013 (store 1001, product 0001, variant 01).
export function formatVariantSku(
  storeNo: number,
  productSkuNo: number,
  variantNo: number,
): string {
  const digits =
    pad(storeNo, STORE_WIDTH) +
    pad(productSkuNo, SEQ_WIDTH) +
    pad(variantNo, VARIANT_WIDTH);
  return (
    SKU_PREFIX +
    pad(storeNo, STORE_WIDTH) +
    pad(productSkuNo, SEQ_WIDTH) +
    "V" +
    pad(variantNo, VARIANT_WIDTH) +
    luhnCheckDigit(digits)
  );
}

// Order reference: ORD + store + order-sequence + check. e.g. ORD100110006.
export function formatOrderRef(storeNo: number, orderNo: number): string {
  const payload = pad(storeNo, STORE_WIDTH) + pad(orderNo, SEQ_WIDTH);
  return ORDER_PREFIX + appendLuhn(payload);
}

/**
 * Credit note: CRN + store + per-store sequence + check. e.g. CRN100100013.
 *
 * ★ Under Indian GST this is a LEGAL DOCUMENT, not a receipt — a refund
 * against a tax invoice needs one, and its serial must be **consecutive with
 * no gaps**. That is why the number is allocated when a refund SETTLES rather
 * than when it is raised: a pending refund that later fails would otherwise
 * burn a serial and leave a hole, which is exactly what an audit looks for.
 */
export function formatCreditNoteRef(
  storeNo: number,
  creditNoteNo: number,
): string {
  const payload = pad(storeNo, STORE_WIDTH) + pad(creditNoteNo, SEQ_WIDTH);
  return CREDIT_NOTE_PREFIX + appendLuhn(payload);
}

// Which kind of code this is (by prefix), or null if unrecognised. Cheap enough
// for the dashboard search box to route a typed code to the right column.
export function refKind(code: string): "sku" | "order" | "credit_note" | null {
  const c = code.trim().toUpperCase();
  if (c.startsWith(SKU_PREFIX)) return "sku";
  if (c.startsWith(ORDER_PREFIX)) return "order";
  if (c.startsWith(CREDIT_NOTE_PREFIX)) return "credit_note";
  return null;
}
