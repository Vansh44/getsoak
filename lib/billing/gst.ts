// ---------------------------------------------------------------------------
// India GST place-of-supply split — a pure layer ON TOP of computeTax().
//
// computeTax() already decides HOW MUCH tax a line carries (inclusive vs
// exclusive, discount allocation). GST then decides how that amount DIVIDES:
//
//   * Intra-state (supplier state == place of supply)
//       → CGST + SGST, half each. Two 9% halves of an 18% rate.
//   * Inter-state (different states, or the place of supply is unknown for an
//     interstate shipment)
//       → IGST, the whole amount.
//
// Never both. The split is snapshotted per order_item so a historical receipt
// keeps printing what was actually charged, even if the store later moves state
// or changes its GST registration.
//
// Place of supply for an in-person sale is the SELLING LOCATION's state (the
// customer walks in), so a POS sale is intra-state unless the goods are shipped
// elsewhere — which is why shipping paths pass the customer's state instead.
//
// Pure module: no imports, fully deterministic, unit-tested.
// ---------------------------------------------------------------------------

/** Round to 2 dp (money). Mirrors lib/billing/tax.ts round2. */
function round2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export interface GstSplit {
  cgst: number;
  sgst: number;
  igst: number;
  /** True when this was taxed as CGST+SGST rather than IGST. */
  intraState: boolean;
}

/** Normalise a GST state code: 2 digits, zero-padded ("7" → "07"). */
export function normalizeStateCode(code: unknown): string | null {
  if (typeof code === "number" && Number.isFinite(code)) {
    const s = String(Math.trunc(code));
    return s.length === 1 ? `0${s}` : s.length === 2 ? s : null;
  }
  if (typeof code !== "string") return null;
  const t = code.trim();
  if (!t) return null;
  if (!/^\d{1,2}$/.test(t)) return null;
  return t.length === 1 ? `0${t}` : t;
}

/**
 * Is this an intra-state supply? Unknown/missing place of supply falls back to
 * INTRA-state, because the common case by far is a walk-in at the counter, and
 * CGST+SGST is what a local shop owes. Callers that know the goods are leaving
 * the state must pass the destination explicitly.
 */
export function isIntraState(
  supplierState: string | null | undefined,
  placeOfSupplyState: string | null | undefined,
): boolean {
  const a = normalizeStateCode(supplierState);
  const b = normalizeStateCode(placeOfSupplyState);
  if (!a || !b) return true;
  return a === b;
}

/**
 * Divide one line's already-computed tax into CGST/SGST or IGST.
 *
 * Takes the TAX AMOUNT (not the rate) so it stays consistent with computeTax's
 * rounding: splitting the amount can never disagree with the order total, which
 * re-deriving from the rate could.
 *
 * The halves are rounded so cgst + sgst === the input exactly, even for odd
 * paise (₹0.05 → 0.03 + 0.02): sgst takes the remainder.
 */
export function splitGst(taxAmount: number, intraState: boolean): GstSplit {
  const total = Number.isFinite(taxAmount) ? round2(Math.max(0, taxAmount)) : 0;
  if (!intraState) {
    return { cgst: 0, sgst: 0, igst: total, intraState: false };
  }
  const cgst = round2(total / 2);
  // Remainder, not a second division — guarantees the halves re-sum exactly.
  const sgst = round2(total - cgst);
  return { cgst, sgst, igst: 0, intraState: true };
}

/** CGST/SGST/IGST in integer paise. */
export interface GstSplitPaise {
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  intraState: boolean;
}

/**
 * The paise-exact counterpart of splitGst, for platform → merchant invoices
 * (§34), where every amount is an integer number of paise.
 *
 * ★ A SEPARATE FUNCTION, deliberately — not a wrapper. `splitGst` rounds to two
 * decimals because it works in RUPEES, so routing paise through it would divide
 * by 100 and back and reintroduce exactly the float error integer paise exist to
 * prevent. Same remainder trick, different unit.
 *
 * sgst takes the remainder, so cgst + sgst === the input for odd paise too
 * (₹0.05 = 5p → 3p + 2p).
 */
export function splitGstPaise(
  taxPaise: number,
  intraState: boolean,
): GstSplitPaise {
  const total = Number.isFinite(taxPaise)
    ? Math.max(0, Math.round(taxPaise))
    : 0;
  if (!intraState) {
    return { cgstPaise: 0, sgstPaise: 0, igstPaise: total, intraState: false };
  }
  const cgstPaise = Math.floor(total / 2);
  return {
    cgstPaise,
    sgstPaise: total - cgstPaise,
    igstPaise: 0,
    intraState: true,
  };
}

export interface GstRateBucket {
  /** The full GST rate for this bucket (e.g. 18 for 9% + 9%). */
  rate: number;
  label: string;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
}

/**
 * Group per-line GST into the rate buckets a GST invoice must print
 * ("Taxable value / CGST 9% / SGST 9%" per rate).
 */
export function gstBreakdown(
  lines: Array<{
    rate: number;
    label?: string;
    taxableValue: number;
    cgst: number;
    sgst: number;
    igst: number;
  }>,
): GstRateBucket[] {
  const buckets = new Map<number, GstRateBucket>();
  for (const l of lines) {
    if (!(l.rate > 0)) continue;
    const b = buckets.get(l.rate);
    if (b) {
      b.taxableValue = round2(b.taxableValue + l.taxableValue);
      b.cgst = round2(b.cgst + l.cgst);
      b.sgst = round2(b.sgst + l.sgst);
      b.igst = round2(b.igst + l.igst);
    } else {
      buckets.set(l.rate, {
        rate: l.rate,
        label: l.label || `GST ${l.rate}%`,
        taxableValue: round2(l.taxableValue),
        cgst: round2(l.cgst),
        sgst: round2(l.sgst),
        igst: round2(l.igst),
      });
    }
  }
  return [...buckets.values()].sort((a, b) => a.rate - b.rate);
}

/** Loose GSTIN shape check (15 chars: 2 state + 10 PAN + 3). Format only — it
 *  does not prove the number is registered. */
export function isValidGstinFormat(gstin: unknown): gstin is string {
  return (
    typeof gstin === "string" &&
    /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(
      gstin.trim().toUpperCase(),
    )
  );
}

/**
 * The GST state codes, for a picker.
 *
 * ★ THE CODE IS THE DATA, the name is the label. Everything downstream compares
 * codes (`isIntraState`, `splitGst`), so a renamed state changes nothing.
 *
 * ⚠ DELIBERATELY OMITS THE RETIRED CODES. `25` (Daman & Diu) merged into `26` in
 * 2020, and `28` (undivided Andhra Pradesh) became `37`. Nobody registering today
 * has one, so offering them in a picker only invites a wrong choice — but a
 * merchant's STORED code may still be one, which is why `normalizeStateCode`
 * accepts any two digits and nothing validates against this list.
 */
export const GST_STATES: ReadonlyArray<{ code: string; name: string }> = [
  { code: "01", name: "Jammu & Kashmir" },
  { code: "02", name: "Himachal Pradesh" },
  { code: "03", name: "Punjab" },
  { code: "04", name: "Chandigarh" },
  { code: "05", name: "Uttarakhand" },
  { code: "06", name: "Haryana" },
  { code: "07", name: "Delhi" },
  { code: "08", name: "Rajasthan" },
  { code: "09", name: "Uttar Pradesh" },
  { code: "10", name: "Bihar" },
  { code: "11", name: "Sikkim" },
  { code: "12", name: "Arunachal Pradesh" },
  { code: "13", name: "Nagaland" },
  { code: "14", name: "Manipur" },
  { code: "15", name: "Mizoram" },
  { code: "16", name: "Tripura" },
  { code: "17", name: "Meghalaya" },
  { code: "18", name: "Assam" },
  { code: "19", name: "West Bengal" },
  { code: "20", name: "Jharkhand" },
  { code: "21", name: "Odisha" },
  { code: "22", name: "Chhattisgarh" },
  { code: "23", name: "Madhya Pradesh" },
  { code: "24", name: "Gujarat" },
  { code: "26", name: "Dadra & Nagar Haveli and Daman & Diu" },
  { code: "27", name: "Maharashtra" },
  { code: "29", name: "Karnataka" },
  { code: "30", name: "Goa" },
  { code: "31", name: "Lakshadweep" },
  { code: "32", name: "Kerala" },
  { code: "33", name: "Tamil Nadu" },
  { code: "34", name: "Puducherry" },
  { code: "35", name: "Andaman & Nicobar Islands" },
  { code: "36", name: "Telangana" },
  { code: "37", name: "Andhra Pradesh" },
  { code: "38", name: "Ladakh" },
  { code: "97", name: "Other Territory" },
];

/** The display name for a stored code, falling back to the code itself. */
export function gstStateName(code: unknown): string | null {
  const c = normalizeStateCode(code);
  if (!c) return null;
  return GST_STATES.find((s) => s.code === c)?.name ?? c;
}

/** The state code embedded in a GSTIN's first two digits, if parseable. */
export function stateCodeFromGstin(gstin: unknown): string | null {
  if (typeof gstin !== "string") return null;
  const t = gstin.trim();
  if (t.length < 2) return null;
  return normalizeStateCode(t.slice(0, 2));
}
