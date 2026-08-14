import "server-only";

/**
 * StoreMink's OWN tax identity — the operator-managed half of §34.
 *
 * ★★ WHY AN OPERATOR SCREEN AND NOT A CONFIG FILE. This decides what appears on
 * a GST tax invoice: the legal name, the GSTIN, the place-of-supply origin, and
 * whether tax is charged at all. Those change on a business timetable (the day a
 * GSTIN is issued, the day an address changes), not on a deploy timetable — and
 * the person who knows is the operator, not whoever is shipping that week.
 *
 * ★★ TURNING TAX ON IS NOT RETROACTIVE, and cannot be. Finalized invoices are
 * immutable by trigger (billing_03), so an April invoice cannot sprout GST in
 * September. That is the correct behaviour and it is worth saying out loud on the
 * screen, because the intuition ("I've added my GSTIN, now everything is a tax
 * invoice") is the opposite.
 *
 * ★ THE DATABASE IS THE BOUNDARY, not this module.
 * `platform_billing_tax_needs_gstin` refuses `tax_enabled` without a GSTIN, so an
 * invoice can never charge GST while naming no GSTIN — which would not be a valid
 * tax invoice, and the merchant could not claim input credit against it. The
 * checks here exist to give a sentence instead of a constraint violation.
 */

import { eq } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { platformBillingSettings } from "@/drizzle/schema";
import { logError } from "@/lib/observability/logger";
import type { PlatformTaxSettings } from "./invoice-types";
import {
  isValidGstinFormat,
  normalizeStateCode,
  stateCodeFromGstin,
} from "./gst";

export type { PlatformTaxSettings };

export const DEFAULT_TAX_SETTINGS: PlatformTaxSettings = {
  legalName: null,
  gstin: null,
  address: {},
  stateCode: null,
  taxEnabled: false,
  taxRateBps: 1800,
  taxInclusive: false,
  invoicePrefix: "SM",
  updatedAt: null,
  updatedBy: null,
};

/**
 * Read the singleton.
 *
 * ★ Returns the DEFAULTS when the row is missing or unreadable — the same
 * tax-OFF fallback `loadTaxContext` uses, and for the same reason: a read failure
 * must never invent a tax charge. The screen then shows "not configured", which
 * is true.
 */
export async function getPlatformTaxSettings(): Promise<PlatformTaxSettings> {
  try {
    return await withService(async (db) => {
      const [row] = await db
        .select()
        .from(platformBillingSettings)
        .where(eq(platformBillingSettings.id, true))
        .limit(1);
      if (!row) return DEFAULT_TAX_SETTINGS;
      return {
        legalName: row.legalName,
        gstin: row.gstin,
        address: (row.address ?? {}) as PlatformTaxSettings["address"],
        stateCode: row.stateCode,
        taxEnabled: row.taxEnabled,
        taxRateBps: row.taxRateBps,
        taxInclusive: row.taxInclusive,
        invoicePrefix: row.invoicePrefix,
        updatedAt: row.updatedAt,
        updatedBy: row.updatedBy,
      };
    });
  } catch (err) {
    logError("billing.platform_settings.read", err);
    return DEFAULT_TAX_SETTINGS;
  }
}

export interface TaxSettingsInput {
  legalName: string;
  gstin: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  postalCode: string;
  stateCode: string;
  taxEnabled: boolean;
  /** Whole percent, as typed. Converted to basis points here. */
  taxRatePercent: number;
  taxInclusive: boolean;
  invoicePrefix: string;
}

export type SaveResult = { ok: true } | { ok: false; error: string };

const trim = (v: unknown, max = 200): string =>
  typeof v === "string" ? v.trim().slice(0, max) : "";

/**
 * Validate and save.
 *
 * ★ EVERY REFUSAL HERE IS ALSO ENFORCED BY THE DATABASE or by the invoice maths.
 * The point of doing it twice is that a constraint violation is not a sentence a
 * human can act on.
 */
export async function savePlatformTaxSettings(
  input: TaxSettingsInput,
  actor: string | null,
): Promise<SaveResult> {
  const legalName = trim(input.legalName);
  const gstin = trim(input.gstin, 20).toUpperCase();
  const stateCode = normalizeStateCode(trim(input.stateCode, 4));
  const prefix = trim(input.invoicePrefix, 8).toUpperCase();

  // ★ A GSTIN is 15 characters with a fixed shape. Storing a typo means every
  // invoice from then on carries an identifier that cannot be verified — and
  // because finalized invoices are immutable, they cannot be corrected.
  if (gstin && !isValidGstinFormat(gstin)) {
    return {
      ok: false,
      error: "That doesn't look like a valid 15-character GSTIN.",
    };
  }

  if (input.taxEnabled) {
    // Mirrors platform_billing_tax_needs_gstin.
    if (!gstin) {
      return {
        ok: false,
        error:
          "Add your GSTIN before switching tax on — an invoice charging GST without one isn't a valid tax invoice.",
      };
    }
    // ★ Not a database constraint, but a real one: `splitGst` compares this
    // against the merchant's state to choose CGST+SGST or IGST. With no origin
    // every invoice would silently be treated as intra-state.
    if (!stateCode) {
      return {
        ok: false,
        error:
          "Add your state before switching tax on — it decides CGST+SGST vs IGST on every invoice.",
      };
    }
    if (!legalName) {
      return {
        ok: false,
        error:
          "Add the registered legal name before switching tax on — it's what the invoice is issued by.",
      };
    }
  }

  // ★★ THE GSTIN CONTAINS THE STATE, so a mismatch is a typo we can catch rather
  // than a wrong tax split we ship. The first two digits ARE the state code; if
  // they disagree with the state entered, one of the two is wrong and every
  // invoice from then on picks CGST+SGST vs IGST on the wrong basis — a mistake
  // that is invisible on the invoice and expensive at filing time.
  if (gstin && stateCode) {
    const fromGstin = stateCodeFromGstin(gstin);
    if (fromGstin && fromGstin !== stateCode) {
      return {
        ok: false,
        error: `Your GSTIN starts with ${fromGstin}, which is a different state from the one selected (${stateCode}). One of them is wrong — they decide CGST+SGST vs IGST on every invoice.`,
      };
    }
  }

  const pct = Number(input.taxRatePercent);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    return { ok: false, error: "Enter a tax rate between 0 and 100." };
  }
  // Basis points, so no float ever touches a stored tax rate.
  const taxRateBps = Math.round(pct * 100);

  if (!prefix) {
    return { ok: false, error: "The invoice prefix can't be empty." };
  }

  try {
    await withService(async (db) => {
      await db
        .insert(platformBillingSettings)
        .values({
          id: true,
          legalName: legalName || null,
          gstin: gstin || null,
          address: {
            line1: trim(input.addressLine1),
            line2: trim(input.addressLine2),
            city: trim(input.city, 80),
            postalCode: trim(input.postalCode, 12),
          },
          stateCode: stateCode || null,
          taxEnabled: input.taxEnabled,
          taxRateBps,
          taxInclusive: input.taxInclusive,
          invoicePrefix: prefix,
          updatedAt: new Date().toISOString(),
          updatedBy: actor,
        })
        .onConflictDoUpdate({
          target: platformBillingSettings.id,
          set: {
            legalName: legalName || null,
            gstin: gstin || null,
            address: {
              line1: trim(input.addressLine1),
              line2: trim(input.addressLine2),
              city: trim(input.city, 80),
              postalCode: trim(input.postalCode, 12),
            },
            stateCode: stateCode || null,
            taxEnabled: input.taxEnabled,
            taxRateBps,
            taxInclusive: input.taxInclusive,
            invoicePrefix: prefix,
            updatedAt: new Date().toISOString(),
            updatedBy: actor,
          },
        });
    });
    return { ok: true };
  } catch (err) {
    logError("billing.platform_settings.save", err);
    return {
      ok: false,
      error: "Couldn't save those settings. Please try again.",
    };
  }
}
