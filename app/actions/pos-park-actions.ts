"use server";

// ---------------------------------------------------------------------------
// Parking a sale — suspend the cart, serve the next customer, come back to it.
// CODEBASE §22.
//
// ── ★★ A PARK MOVES NOTHING ───────────────────────────────────────────────
// No money, no stock, no order row. It stores the CHOICES a cashier has made
// so far and nothing else, which is what makes it safe to abandon: a park that
// is never resumed costs one row and no reconciliation.
//
// That is also why it holds no stock (see the migration header). `placePosSale`
// re-reads every price and reserves atomically at completion, so a resumed cart
// whose goods sold out meanwhile fails there against live data rather than
// having quietly held them for hours.
// ---------------------------------------------------------------------------

import { and, desc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withService } from "@/lib/db/client";
import { dbErrorMessage } from "@/lib/db/errors";
import { posParkedSales } from "@/drizzle/schema";
import { resolvePosOperator } from "@/lib/pos/operator";
import { posCan } from "@/lib/pos/permissions";
import {
  MAX_PARKED_SALES,
  validateParkInput,
  type ParkedLine,
} from "@/lib/pos/park";

export interface ParkedSale {
  id: string;
  label: string | null;
  lines: ParkedLine[];
  orderDiscount: number;
  customerId: string | null;
  customerGstin: string | null;
  note: string | null;
  parkedByName: string | null;
  createdAt: string;
  /** Item count, so the list is readable without opening each one. */
  items: number;
}

export interface ParkResult {
  success?: boolean;
  id?: string;
  error?: string;
}

/**
 * Hold the current cart.
 *
 * ★ `sell`, the same grant as ringing one up. Parking is part of serving a
 * customer, not a supervisory act — gating it above the person at the counter
 * would mean it never gets used.
 */
export async function parkSale(input: {
  label?: string | null;
  lines: ParkedLine[];
  orderDiscount?: number;
  customerId?: string | null;
  customerGstin?: string | null;
  note?: string | null;
}): Promise<ParkResult> {
  const op = await resolvePosOperator();
  if (!op) return { error: "Not signed in." };
  if (!posCan(op.role, "sell")) return { error: "Not allowed." };

  const valid = validateParkInput(input);
  if (!valid.ok) return { error: valid.error };

  try {
    // ★ CAPPED, and counted at THIS location. Without a ceiling a stuck button
    // — or a cashier parking instead of voiding — fills the list until it is
    // useless for finding the one cart that matters.
    const existing = await withService((db) =>
      db
        .select({ id: posParkedSales.id })
        .from(posParkedSales)
        .where(eq(posParkedSales.locationId, op.locationId))
        .limit(MAX_PARKED_SALES + 1),
    );
    if (existing.length >= MAX_PARKED_SALES) {
      return {
        error: `There are already ${MAX_PARKED_SALES} held sales at this counter. Finish or discard one first.`,
      };
    }

    const rows = await withService((db) =>
      db
        .insert(posParkedSales)
        .values({
          storeId: op.storeId,
          locationId: op.locationId,
          label: valid.label,
          lines: valid.lines,
          orderDiscount: valid.orderDiscount,
          customerId: valid.customerId,
          customerGstin: valid.customerGstin,
          note: valid.note,
          parkedBy: op.staffId ?? null,
          parkedByName: op.name ?? null,
        } as typeof posParkedSales.$inferInsert)
        .returning({ id: posParkedSales.id }),
    );

    revalidatePath("/pos/sell");
    return { success: true, id: rows[0]?.id };
  } catch (err) {
    return { error: dbErrorMessage(err, "Couldn't hold that sale.") };
  }
}

/**
 * What is held at this counter.
 *
 * ★ Scoped to the operator's LOCATION, never to the person: a parked sale
 * belongs to the shop, so whoever is free when the customer returns can finish
 * it. `parkedByName` is carried so a busy counter can still tell three held
 * carts apart.
 */
export async function listParkedSales(): Promise<{
  sales: ParkedSale[];
  error?: string;
}> {
  const op = await resolvePosOperator();
  if (!op) return { sales: [], error: "Not signed in." };
  if (!posCan(op.role, "sell")) return { sales: [], error: "Not allowed." };

  try {
    const rows = await withService((db) =>
      db
        .select()
        .from(posParkedSales)
        .where(
          and(
            eq(posParkedSales.storeId, op.storeId),
            eq(posParkedSales.locationId, op.locationId),
          ),
        )
        .orderBy(desc(posParkedSales.createdAt))
        .limit(MAX_PARKED_SALES),
    );

    return {
      sales: rows.map((r) => {
        const lines = Array.isArray(r.lines) ? (r.lines as ParkedLine[]) : [];
        return {
          id: r.id,
          label: r.label,
          lines,
          orderDiscount: Number(r.orderDiscount ?? 0),
          customerId: r.customerId,
          customerGstin: r.customerGstin,
          note: r.note,
          parkedByName: r.parkedByName,
          createdAt: r.createdAt,
          items: lines.reduce((n, l) => n + (Number(l.quantity) || 0), 0),
        };
      }),
    };
  } catch (err) {
    return {
      sales: [],
      error: dbErrorMessage(err, "Couldn't load held sales."),
    };
  }
}

/**
 * Take a held sale back to the register, and remove it.
 *
 * ★★ THE DELETE IS A CONDITIONAL CLAIM, so two tills resuming the same cart
 * cannot both get it. The loser is told, rather than silently loading a cart
 * the other cashier is already ringing up — which is how a customer gets
 * charged twice for one basket.
 *
 * ⚠ It returns CHOICES ONLY. The register re-prices from its own catalogue and
 * `placePosSale` re-reads authoritatively at completion; nothing here is ever
 * the basis for a charge.
 */
export async function resumeParkedSale(
  id: string,
): Promise<{ sale?: ParkedSale; error?: string }> {
  const op = await resolvePosOperator();
  if (!op) return { error: "Not signed in." };
  if (!posCan(op.role, "sell")) return { error: "Not allowed." };

  try {
    const rows = await withService((db) =>
      db
        .delete(posParkedSales)
        .where(
          and(
            eq(posParkedSales.id, id),
            eq(posParkedSales.storeId, op.storeId),
            // Scoped to the location as well as the store: a held cart at
            // another shop is none of this counter's business.
            eq(posParkedSales.locationId, op.locationId),
          ),
        )
        .returning(),
    );

    const row = rows[0];
    if (!row) {
      return {
        error: "That held sale is gone — someone else may have resumed it.",
      };
    }

    const lines = Array.isArray(row.lines) ? (row.lines as ParkedLine[]) : [];
    revalidatePath("/pos/sell");
    return {
      sale: {
        id: row.id,
        label: row.label,
        lines,
        orderDiscount: Number(row.orderDiscount ?? 0),
        customerId: row.customerId,
        customerGstin: row.customerGstin,
        note: row.note,
        parkedByName: row.parkedByName,
        createdAt: row.createdAt,
        items: lines.reduce((n, l) => n + (Number(l.quantity) || 0), 0),
      },
    };
  } catch (err) {
    return { error: dbErrorMessage(err, "Couldn't resume that sale.") };
  }
}

/** Throw a held sale away — the customer changed their mind and left. */
export async function discardParkedSale(id: string): Promise<ParkResult> {
  const op = await resolvePosOperator();
  if (!op) return { error: "Not signed in." };
  if (!posCan(op.role, "sell")) return { error: "Not allowed." };

  try {
    await withService((db) =>
      db
        .delete(posParkedSales)
        .where(
          and(
            eq(posParkedSales.id, id),
            eq(posParkedSales.storeId, op.storeId),
            eq(posParkedSales.locationId, op.locationId),
          ),
        ),
    );
    revalidatePath("/pos/sell");
    return { success: true };
  } catch (err) {
    return { error: dbErrorMessage(err, "Couldn't discard that sale.") };
  }
}
