import "server-only";

// Append-only POS trail (pos_audit_log). A till system must be able to answer
// "who sold this, on which device, who enrolled that device" — and, since
// roadmap Step 14, "who gave away ₹400, and who approved it".
//
// ── ★★ WHAT BELONGS HERE IS A DISCRETIONARY ACT ────────────────────────────
// The money events are the ones where a HUMAN CHOSE to move money: a discount,
// a price override, a refund at the counter, cash out of the drawer. The
// amounts were never lost — orders, order_items and order_refunds all carry
// them — so what this adds is ATTRIBUTION, above all the APPROVER, which is
// the one fact nothing else records.
//
// ⚠ A GATEWAY TENDER IS DELIBERATELY NOT AUDITED HERE. It is not
// discretionary — the cashier chose nothing — and it is fully reconstructible:
// `order_payments` has the reference and `orders.cashier_id` has who rang it.
// Logging it would be noise in the one feed that needs to stay readable.
//
// Writing is ALWAYS best-effort: an audit failure must never block a sale or a
// sign-in. Losing a log line is bad; refusing to serve a customer is worse.

import { headers } from "next/headers";
import { withService } from "@/lib/db/client";
import { posAuditLog } from "@/drizzle/schema";
import { clientIp } from "@/lib/rate-limit";

export type PosAuditEvent =
  | "device_authorized"
  | "device_revoked"
  | "device_clone_detected"
  | "operator_login"
  | "operator_login_failed"
  | "credential_reset"
  // ── Money (Step 14) ──────────────────────────────────────────────────────
  | "sale_discount"
  | "price_override"
  | "refund_issued"
  | "cash_movement";

/** The money half — the events that carry an `amount` and answer "who". */
export const POS_MONEY_EVENTS = [
  "sale_discount",
  "price_override",
  "refund_issued",
  "cash_movement",
] as const satisfies readonly PosAuditEvent[];

export function isPosMoneyEvent(event: string): boolean {
  return (POS_MONEY_EVENTS as readonly string[]).includes(event);
}

export async function posAudit(entry: {
  storeId: string;
  event: PosAuditEvent;
  deviceId?: string | null;
  staffId?: string | null;
  locationId?: string | null;
  actor?: string | null;
  detail?: string | null;
  /** Rupees GIVEN AWAY or MOVED. Positive means it left the shop. */
  amount?: number | null;
  /** Who authorised it, when that differs from the actor. */
  approver?: string | null;
  /** The sale or refund this concerns. */
  orderId?: string | null;
}): Promise<void> {
  try {
    let ip: string | null = null;
    try {
      ip = clientIp(await headers());
    } catch {
      // No request scope (cron/worker) — the entry is still worth recording.
    }
    await withService((db) =>
      db.insert(posAuditLog).values({
        storeId: entry.storeId,
        event: entry.event,
        deviceId: entry.deviceId ?? null,
        staffId: entry.staffId ?? null,
        locationId: entry.locationId ?? null,
        actor: entry.actor ?? null,
        ip,
        detail: entry.detail ?? null,
        amount: entry.amount ?? null,
        approver: entry.approver ?? null,
        orderId: entry.orderId ?? null,
      }),
    );
  } catch (err) {
    console.error("posAudit:", err instanceof Error ? err.message : err);
  }
}
