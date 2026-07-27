import "server-only";

// Append-only POS security trail (pos_audit_log). A till system must be able to
// answer "who sold this, on which device, and who enrolled that device".
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
  | "credential_reset";

export async function posAudit(entry: {
  storeId: string;
  event: PosAuditEvent;
  deviceId?: string | null;
  staffId?: string | null;
  locationId?: string | null;
  actor?: string | null;
  detail?: string | null;
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
      }),
    );
  } catch (err) {
    console.error("posAudit:", err instanceof Error ? err.message : err);
  }
}
