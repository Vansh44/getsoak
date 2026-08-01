"use server";

// POS Phase 2 — the manager-arranged register layout (supabase/pos_09_register_layout.sql).
//
// Which products appear on the till's grid, and in what order, per location.
// Reads are open to anyone who can sell (the cashier's grid depends on it);
// writes need the `edit_layout` capability, so a cashier cannot rearrange the
// counter. Both resolve the operator SERVER-side and derive the location from
// the operator's own session — never from a client-supplied id, or a manager
// at one shop could rearrange another's till.

import { and, eq, sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { dbErrorMessage } from "@/lib/db/errors";
import { posLayouts } from "@/drizzle/schema";
import { resolvePosOperator } from "@/lib/pos/operator";
import { posCan } from "@/lib/pos/permissions";
import type { LayoutEntry } from "@/lib/pos/catalog-index";

/** Bounds the blob: a till grid is a handful of screens, not a catalogue dump. */
const MAX_LAYOUT_ITEMS = 500;

export interface PosLayoutResult {
  items: LayoutEntry[];
  /** False when no layout row exists — the register then shows everything. */
  configured: boolean;
  /** Whether THIS operator may rearrange it (drives the Edit layout button). */
  canEdit: boolean;
  error?: string;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Accept only well-formed entries. The ids are written straight back to the
 * grid and looked up against the catalogue, so anything malformed is dropped
 * here rather than stored and puzzled over later.
 */
function sanitizeLayout(raw: unknown): LayoutEntry[] | null {
  if (!Array.isArray(raw)) return null;
  if (raw.length > MAX_LAYOUT_ITEMS) return null;
  const out: LayoutEntry[] = [];
  const seen = new Set<string>();
  for (const e of raw) {
    if (!e || typeof e !== "object") return null;
    const { productId, variantId } = e as Record<string, unknown>;
    if (typeof productId !== "string" || !UUID_RE.test(productId)) return null;
    if (
      variantId !== null &&
      variantId !== undefined &&
      (typeof variantId !== "string" || !UUID_RE.test(variantId))
    ) {
      return null;
    }
    const v = typeof variantId === "string" ? variantId : null;
    // A duplicate tile would render the same product twice; drop it quietly.
    const key = `${productId}:${v ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ productId, variantId: v });
  }
  return out;
}

function readRows(rows: Array<{ items: unknown }>): LayoutEntry[] {
  return sanitizeLayout(rows[0]?.items) ?? [];
}

/** The layout for the operator's own location. */
export async function getPosLayout(): Promise<PosLayoutResult> {
  const op = await resolvePosOperator();
  if (!op)
    return {
      items: [],
      configured: false,
      canEdit: false,
      error: "Not signed in.",
    };
  if (!posCan(op.role, "sell"))
    return {
      items: [],
      configured: false,
      canEdit: false,
      error: "Not allowed.",
    };

  const canEdit = posCan(op.role, "edit_layout");
  try {
    const rows = await withService((db) =>
      db
        .select({ items: posLayouts.items })
        .from(posLayouts)
        .where(
          and(
            eq(posLayouts.locationId, op.locationId),
            eq(posLayouts.storeId, op.storeId),
          ),
        )
        .limit(1),
    );
    const items = readRows(rows);
    // An empty array is indistinguishable from "never configured", and both
    // mean the same thing to the register: show the whole catalogue.
    return { items, configured: items.length > 0, canEdit };
  } catch (err) {
    // A layout read must never take the register down — fall back to showing
    // everything, which is strictly more useful than an empty grid.
    return {
      items: [],
      configured: false,
      canEdit,
      error: dbErrorMessage(err, "Couldn't load the register layout."),
    };
  }
}

export async function savePosLayout(
  items: LayoutEntry[],
): Promise<{ success?: boolean; error?: string }> {
  const op = await resolvePosOperator();
  if (!op) return { error: "Not signed in." };
  if (!posCan(op.role, "edit_layout")) {
    return { error: "Only a manager or the owner can change the layout." };
  }

  const clean = sanitizeLayout(items);
  if (!clean) return { error: "That layout isn't valid." };

  try {
    await withService((db) =>
      db
        .insert(posLayouts)
        .values({
          storeId: op.storeId,
          locationId: op.locationId,
          items: clean,
          updatedBy: op.staffId ?? null,
          updatedAt: sql`now()`,
        })
        .onConflictDoUpdate({
          target: posLayouts.locationId,
          set: {
            items: clean,
            updatedBy: op.staffId ?? null,
            updatedAt: sql`now()`,
          },
        }),
    );
    return { success: true };
  } catch (err) {
    return { error: dbErrorMessage(err, "Couldn't save the layout.") };
  }
}

/** Clear the layout — the register goes back to showing the whole catalogue. */
export async function resetPosLayout(): Promise<{
  success?: boolean;
  error?: string;
}> {
  const op = await resolvePosOperator();
  if (!op) return { error: "Not signed in." };
  if (!posCan(op.role, "edit_layout")) {
    return { error: "Only a manager or the owner can change the layout." };
  }
  try {
    await withService((db) =>
      db
        .delete(posLayouts)
        .where(
          and(
            eq(posLayouts.locationId, op.locationId),
            eq(posLayouts.storeId, op.storeId),
          ),
        ),
    );
    return { success: true };
  } catch (err) {
    return { error: dbErrorMessage(err, "Couldn't reset the layout.") };
  }
}
