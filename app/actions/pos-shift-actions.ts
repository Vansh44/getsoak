"use server";

// POS Phase 3 — shifts & cash reconciliation (supabase/pos_10_shifts.sql).
//
// Opening and closing a drawer needs `open_close_shift`; recording a cash
// movement needs `cash_drop`. Both are manager/owner capabilities, so a
// cashier can sell into the drawer but cannot declare what was in it.
//
// The location always comes from the operator's own session — never from the
// client — so a manager at one shop cannot open, bank or close another's till.
//
// The arithmetic lives in lib/pos/shifts.ts and is tested there; this file is
// only the gate, the queries and the writes.

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withService } from "@/lib/db/client";
import { dbErrorMessage, isUniqueViolation } from "@/lib/db/errors";
import {
  orderPayments,
  orders,
  posCashMovements,
  posShifts,
  storeLocations,
} from "@/drizzle/schema";
import { resolvePosOperator } from "@/lib/pos/operator";
import { posCan } from "@/lib/pos/permissions";
import { getStoreSettings } from "@/lib/settings/resolve";
import {
  shiftTotals,
  totalsByMethod,
  varianceOf,
  varianceState,
  type CashMovementType,
  type VarianceState,
} from "@/lib/pos/shifts";

/** A float larger than this is a typo, not a drawer. */
const MAX_MONEY = 10_000_000;
const CASH_TYPES: CashMovementType[] = ["drop", "payout", "paid_in"];

export interface ShiftMovement {
  id: string;
  type: CashMovementType;
  amount: number;
  reason: string | null;
  at: string;
  byName: string | null;
}

export interface ShiftReport {
  id: string;
  status: "open" | "closed";
  locationName: string;
  openedAt: string;
  openedByName: string | null;
  openingFloat: number;
  closedAt: string | null;
  closedByName: string | null;
  /** Net cash the drawer should hold (open) or should have held (closed). */
  expectedCash: number;
  cashSales: number;
  paidIn: number;
  payouts: number;
  drops: number;
  /** Takings per payment method — the Z-report breakdown. */
  byMethod: Record<string, number>;
  saleCount: number;
  grossSales: number;
  movements: ShiftMovement[];
  /** Present only once closed. */
  countedCash: number | null;
  variance: number | null;
  varianceState: VarianceState | null;
  note: string | null;
}

export interface ShiftState {
  shift: ShiftReport | null;
  /** Whether this operator may open/close (drives the UI). */
  canManage: boolean;
  /** Whether a cashier is blocked from selling without one. */
  required: boolean;
  error?: string;
}

function money(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : (v as number);
  if (!Number.isFinite(n) || n < 0 || n > MAX_MONEY) return null;
  return Math.round(n * 100) / 100;
}

/**
 * Load a shift with everything derived from its sales and movements.
 *
 * A CLOSED shift reports the figures snapshotted at close rather than
 * recomputing them — an old Z-report must not shift under a merchant's feet
 * because an order was later edited or cancelled.
 */
async function loadReport(
  shiftId: string,
  /** Rupees a hand-counted drawer may differ before it is called over/short. */
  tolerance = 0,
): Promise<ShiftReport | null> {
  const rows = await withService(async (db) => {
    const shiftRows = await db
      .select({
        id: posShifts.id,
        status: posShifts.status,
        opened_at: posShifts.openedAt,
        opened_by_name: posShifts.openedByName,
        opening_float: posShifts.openingFloat,
        closed_at: posShifts.closedAt,
        closed_by_name: posShifts.closedByName,
        counted_cash: posShifts.countedCash,
        expected_cash: posShifts.expectedCash,
        variance: posShifts.variance,
        note: posShifts.note,
        location_name: storeLocations.name,
      })
      .from(posShifts)
      .leftJoin(storeLocations, eq(storeLocations.id, posShifts.locationId))
      .where(eq(posShifts.id, shiftId))
      .limit(1);
    if (shiftRows.length === 0) return null;

    const [payments, movements, saleAgg] = await Promise.all([
      db
        .select({
          order_id: orderPayments.orderId,
          method: orderPayments.method,
          amount: orderPayments.amount,
          change_due: orderPayments.changeDue,
        })
        .from(orderPayments)
        .innerJoin(orders, eq(orders.id, orderPayments.orderId))
        .where(eq(orders.shiftId, shiftId)),
      db
        .select({
          id: posCashMovements.id,
          type: posCashMovements.type,
          amount: posCashMovements.amount,
          reason: posCashMovements.reason,
          created_at: posCashMovements.createdAt,
          created_by_name: posCashMovements.createdByName,
        })
        .from(posCashMovements)
        .where(eq(posCashMovements.shiftId, shiftId))
        .orderBy(posCashMovements.createdAt),
      db
        .select({
          n: sql<number>`count(*)::int`,
          gross: sql<number>`coalesce(sum(${orders.total}), 0)::float8`,
        })
        .from(orders)
        .where(eq(orders.shiftId, shiftId)),
    ]);
    return { shift: shiftRows[0], payments, movements, saleAgg };
  });
  if (!rows) return null;

  const { shift, payments, movements, saleAgg } = rows;
  const closed = shift.status === "closed";

  const totals = shiftTotals({
    openingFloat: Number(shift.opening_float) || 0,
    payments: payments
      .filter((p) => p.method === "cash")
      .map((p) => ({
        orderId: p.order_id,
        amount: Number(p.amount) || 0,
        changeDue: p.change_due === null ? null : Number(p.change_due),
      })),
    movements: movements.map((m) => ({
      type: m.type as CashMovementType,
      amount: Number(m.amount) || 0,
    })),
  });

  const counted = closed ? (Number(shift.counted_cash) ?? null) : null;
  // Closed shifts report what was recorded AT CLOSE; only an open shift is
  // computed live.
  const expected = closed
    ? (Number(shift.expected_cash) ?? totals.expectedCash)
    : totals.expectedCash;
  const variance = closed ? (Number(shift.variance) ?? 0) : null;

  return {
    id: shift.id,
    status: closed ? "closed" : "open",
    locationName: shift.location_name ?? "Location",
    openedAt: shift.opened_at,
    openedByName: shift.opened_by_name,
    openingFloat: totals.openingFloat,
    closedAt: shift.closed_at,
    closedByName: shift.closed_by_name,
    expectedCash: expected,
    cashSales: totals.cashSales,
    paidIn: totals.paidIn,
    payouts: totals.payouts,
    drops: totals.drops,
    byMethod: totalsByMethod(
      payments.map((p) => ({
        orderId: p.order_id,
        method: p.method,
        amount: Number(p.amount) || 0,
        changeDue: p.change_due === null ? null : Number(p.change_due),
      })),
    ),
    saleCount: Number(saleAgg[0]?.n) || 0,
    grossSales: Math.round((Number(saleAgg[0]?.gross) || 0) * 100) / 100,
    movements: movements.map((m) => ({
      id: m.id,
      type: m.type as CashMovementType,
      amount: Number(m.amount) || 0,
      reason: m.reason,
      at: m.created_at,
      byName: m.created_by_name,
    })),
    countedCash: counted,
    variance,
    varianceState:
      variance === null ? null : varianceState(variance, tolerance),
    note: shift.note,
  };
}

/** The open shift at this operator's location, with live totals. */
export async function getCurrentShift(): Promise<ShiftState> {
  const op = await resolvePosOperator();
  if (!op)
    return {
      shift: null,
      canManage: false,
      required: false,
      error: "Not signed in.",
    };

  const canManage = posCan(op.role, "open_close_shift");
  let required = false;
  let tolerance = 0;
  try {
    const settings = await getStoreSettings();
    required = settings["pos.requireOpenShift"] === true;
    tolerance = Number(settings["pos.cashVarianceTolerance"]) || 0;
  } catch {
    // A settings read failure must not decide that selling is blocked, nor
    // silently widen the tolerance on a variance.
    required = false;
    tolerance = 0;
  }

  try {
    const open = await withService((db) =>
      db
        .select({ id: posShifts.id })
        .from(posShifts)
        .where(
          and(
            eq(posShifts.locationId, op.locationId),
            eq(posShifts.status, "open"),
          ),
        )
        .limit(1),
    );
    if (open.length === 0) return { shift: null, canManage, required };
    return {
      shift: await loadReport(open[0].id, tolerance),
      canManage,
      required,
    };
  } catch (err) {
    return {
      shift: null,
      canManage,
      required,
      error: dbErrorMessage(err, "Couldn't load the shift."),
    };
  }
}

export async function openShift(
  openingFloat: number,
): Promise<{ success?: boolean; error?: string; shiftId?: string }> {
  const op = await resolvePosOperator();
  if (!op) return { error: "Not signed in." };
  if (!posCan(op.role, "open_close_shift")) {
    return { error: "Only a manager or the owner can open a shift." };
  }
  const float = money(openingFloat);
  if (float === null) return { error: "Enter a valid opening float." };

  try {
    const rows = await withService((db) =>
      db
        .insert(posShifts)
        .values({
          storeId: op.storeId,
          locationId: op.locationId,
          openingFloat: float,
          openedBy: op.staffId ?? null,
          openedByName: op.name,
        })
        .returning({ id: posShifts.id }),
    );
    revalidatePath("/pos");
    return { success: true, shiftId: rows[0]?.id };
  } catch (err) {
    // The partial unique index is the concurrency guarantee: two managers
    // tapping Open at once cannot split a day's cash across two drawers.
    if (isUniqueViolation(err)) {
      return { error: "A shift is already open at this location." };
    }
    return { error: dbErrorMessage(err, "Couldn't open the shift.") };
  }
}

export async function closeShift(
  countedCash: number,
  note?: string,
): Promise<{
  success?: boolean;
  error?: string;
  variance?: number;
  expected?: number;
}> {
  const op = await resolvePosOperator();
  if (!op) return { error: "Not signed in." };
  if (!posCan(op.role, "open_close_shift")) {
    return { error: "Only a manager or the owner can close a shift." };
  }
  const counted = money(countedCash);
  if (counted === null) return { error: "Enter the counted cash." };

  let shiftId: string;
  let expected: number;
  try {
    const open = await withService((db) =>
      db
        .select({ id: posShifts.id })
        .from(posShifts)
        .where(
          and(
            eq(posShifts.locationId, op.locationId),
            eq(posShifts.status, "open"),
          ),
        )
        .limit(1),
    );
    if (open.length === 0) return { error: "No shift is open here." };
    shiftId = open[0].id;
    const report = await loadReport(shiftId);
    if (!report) return { error: "No shift is open here." };
    expected = report.expectedCash;
  } catch (err) {
    return { error: dbErrorMessage(err, "Couldn't read the shift.") };
  }

  const variance = varianceOf(counted, expected);

  try {
    // Claim the open→closed transition conditionally, the pattern used for
    // order cancellation: whoever wins writes the figures, and a second tap
    // (or a second manager) affects zero rows instead of overwriting a count.
    const claimed = await withService((db) =>
      db
        .update(posShifts)
        .set({
          status: "closed",
          closedAt: sql`now()`,
          closedBy: op.staffId ?? null,
          closedByName: op.name,
          countedCash: counted,
          expectedCash: expected,
          variance,
          note: note?.trim().slice(0, 500) || null,
        })
        .where(and(eq(posShifts.id, shiftId), eq(posShifts.status, "open")))
        .returning({ id: posShifts.id }),
    );
    if (claimed.length === 0) {
      return { error: "That shift was already closed." };
    }
    revalidatePath("/pos");
    return { success: true, variance, expected };
  } catch (err) {
    return { error: dbErrorMessage(err, "Couldn't close the shift.") };
  }
}

export async function recordCashMovement(
  type: CashMovementType,
  amount: number,
  reason?: string,
): Promise<{ success?: boolean; error?: string }> {
  const op = await resolvePosOperator();
  if (!op) return { error: "Not signed in." };
  if (!posCan(op.role, "cash_drop")) {
    return { error: "Only a manager or the owner can move cash." };
  }
  if (!CASH_TYPES.includes(type)) return { error: "Invalid movement." };
  const amt = money(amount);
  if (amt === null || amt <= 0) return { error: "Enter a valid amount." };

  try {
    const open = await withService((db) =>
      db
        .select({ id: posShifts.id })
        .from(posShifts)
        .where(
          and(
            eq(posShifts.locationId, op.locationId),
            eq(posShifts.status, "open"),
          ),
        )
        .limit(1),
    );
    if (open.length === 0) {
      return { error: "Open a shift before moving cash." };
    }
    await withService((db) =>
      db.insert(posCashMovements).values({
        shiftId: open[0].id,
        storeId: op.storeId,
        type,
        amount: amt,
        reason: reason?.trim().slice(0, 200) || null,
        createdBy: op.staffId ?? null,
        createdByName: op.name,
      }),
    );
    revalidatePath("/pos");
    return { success: true };
  } catch (err) {
    return { error: dbErrorMessage(err, "Couldn't record the movement.") };
  }
}

/** Recent shifts at this location, for the history list. */
export async function listShifts(
  limit = 20,
): Promise<{ shifts: ShiftReport[]; error?: string }> {
  const op = await resolvePosOperator();
  if (!op) return { shifts: [], error: "Not signed in." };
  if (!posCan(op.role, "open_close_shift")) {
    return { shifts: [], error: "Not allowed." };
  }
  const take = Math.min(Math.max(Math.trunc(limit) || 20, 1), 50);
  // Read once so history labels a variance exactly as the live screen did.
  let tolerance = 0;
  try {
    tolerance =
      Number((await getStoreSettings())["pos.cashVarianceTolerance"]) || 0;
  } catch {
    tolerance = 0;
  }
  try {
    const rows = await withService((db) =>
      db
        .select({ id: posShifts.id })
        .from(posShifts)
        .where(eq(posShifts.locationId, op.locationId))
        .orderBy(desc(posShifts.openedAt))
        .limit(take),
    );
    const reports = await Promise.all(
      rows.map((r) => loadReport(r.id, tolerance)),
    );
    return { shifts: reports.filter((r): r is ShiftReport => !!r) };
  } catch (err) {
    return { shifts: [], error: dbErrorMessage(err, "Couldn't load shifts.") };
  }
}

/**
 * The open shift id for the operator's location, or null. Used by placePosSale
 * to stamp a sale onto the right drawer.
 */
export async function currentShiftIdFor(
  locationId: string,
): Promise<string | null> {
  try {
    const rows = await withService((db) =>
      db
        .select({ id: posShifts.id })
        .from(posShifts)
        .where(
          and(
            eq(posShifts.locationId, locationId),
            eq(posShifts.status, "open"),
            isNull(posShifts.closedAt),
          ),
        )
        .limit(1),
    );
    return rows[0]?.id ?? null;
  } catch {
    // A sale must never fail because the drawer lookup did — it just goes
    // unattributed, which reconciliation surfaces rather than hides.
    return null;
  }
}
