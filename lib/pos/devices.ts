// Device authorization + clone detection (docs/pos-plan.md §3.3).
//
// A browser becomes an authorized POS device when the OWNER authorizes it — it
// then holds a signed httpOnly pos_device cookie. Staff can only sell on such a
// device, so their personal phone is useless even with correct credentials.
//
// The signature alone cannot detect a COPIED cookie (a clone carries a valid
// signature), so the cookie also embeds a rotation `nonce` matched against
// pos_devices.token_nonce. The nonce rotates on every operator sign-in; a
// cookie presenting a retired nonce means two copies exist, and we fail secure
// by revoking the device (the owner then re-authorizes deliberately).

import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { withService } from "@/lib/db/client";
import { posDevices } from "@/drizzle/schema";
import { POS_DEVICE_COOKIE, verifyDeviceToken } from "@/lib/pos/session";
import { posAudit } from "@/lib/pos/audit";

export interface AuthorizedDevice {
  deviceId: string;
  locationId: string;
}

/** A fresh rotation nonce. */
export function newDeviceNonce(): string {
  return randomBytes(18).toString("base64url");
}

/**
 * How long a JUST-ROTATED previous nonce keeps working. Without this, requests
 * already in flight when a rotation lands (a page's parallel server actions,
 * a slow tab) would present the old nonce and be misread as a clone — locking
 * a legitimate shop out mid-shift. Two minutes absorbs that without giving a
 * real attacker a useful window.
 */
const PREV_NONCE_GRACE_MS = 2 * 60 * 1000;

/**
 * The current browser's authorized device for this store, or null. Verifies:
 *   1. the cookie's HMAC signature and store binding,
 *   2. the device row still exists and is not revoked,
 *   3. the rotation nonce is current (or within the grace window).
 * A nonce mismatch revokes the device and records `device_clone_detected`.
 */
export async function getAuthorizedDevice(
  storeId: string,
): Promise<AuthorizedDevice | null> {
  const claims = verifyDeviceToken(
    (await cookies()).get(POS_DEVICE_COOKIE)?.value,
  );
  if (!claims || claims.storeId !== storeId) return null;

  const rows = await withService((db) =>
    db
      .select({
        id: posDevices.id,
        location_id: posDevices.locationId,
        revoked_at: posDevices.revokedAt,
        token_nonce: posDevices.tokenNonce,
        prev_nonce: posDevices.prevNonce,
        prev_nonce_until: posDevices.prevNonceUntil,
      })
      .from(posDevices)
      .where(
        and(
          eq(posDevices.id, claims.deviceId),
          eq(posDevices.storeId, storeId),
        ),
      )
      .limit(1),
  ).catch(() => []);

  const row = rows[0];
  if (!row || row.revoked_at) return null;

  // Devices enrolled before rotation shipped have no nonce — adopt the one they
  // present rather than locking them out (they rotate normally from here).
  if (!row.token_nonce) {
    await withService((db) =>
      db
        .update(posDevices)
        .set({ tokenNonce: claims.nonce })
        .where(eq(posDevices.id, row.id)),
    ).catch(() => {});
    return { deviceId: row.id, locationId: row.location_id };
  }

  if (claims.nonce !== row.token_nonce) {
    const graceOk =
      !!row.prev_nonce &&
      claims.nonce === row.prev_nonce &&
      !!row.prev_nonce_until &&
      new Date(row.prev_nonce_until) > new Date();
    if (!graceOk) {
      // Two copies of this cookie exist. Fail secure.
      await withService((db) =>
        db
          .update(posDevices)
          .set({
            revokedAt: new Date().toISOString(),
            revokedReason: "clone_detected",
            revokedBy: "system",
          })
          .where(
            and(eq(posDevices.id, row.id), eq(posDevices.storeId, storeId)),
          ),
      ).catch(() => {});
      await posAudit({
        storeId,
        event: "device_clone_detected",
        deviceId: row.id,
        locationId: row.location_id,
        actor: "system",
        detail:
          "A POS device cookie was presented with a retired token. The device was revoked automatically — re-authorize it if this was legitimate.",
      });
      return null;
    }
  }

  return { deviceId: row.id, locationId: row.location_id };
}

/**
 * Rotate a device's nonce (called on every operator sign-in) and return the new
 * one so the caller can re-issue the cookie. The outgoing nonce stays valid for
 * a short grace window to absorb in-flight requests.
 */
export async function rotateDeviceNonce(
  storeId: string,
  deviceId: string,
  currentNonce: string | null,
): Promise<string | null> {
  const nonce = newDeviceNonce();
  try {
    await withService((db) =>
      db
        .update(posDevices)
        .set({
          tokenNonce: nonce,
          prevNonce: currentNonce,
          prevNonceUntil: new Date(
            Date.now() + PREV_NONCE_GRACE_MS,
          ).toISOString(),
          lastSeenAt: new Date().toISOString(),
        })
        .where(
          and(eq(posDevices.id, deviceId), eq(posDevices.storeId, storeId)),
        ),
    );
    return nonce;
  } catch (err) {
    // Rotation is a hardening measure, not a gate — never block a sign-in on it.
    console.error("rotateDeviceNonce:", err);
    return null;
  }
}

/** The device's current nonce (needed to hand the outgoing one to rotation). */
export async function getDeviceNonce(
  storeId: string,
  deviceId: string,
): Promise<string | null> {
  const rows = await withService((db) =>
    db
      .select({ token_nonce: posDevices.tokenNonce })
      .from(posDevices)
      .where(and(eq(posDevices.id, deviceId), eq(posDevices.storeId, storeId)))
      .limit(1),
  ).catch(() => []);
  return rows[0]?.token_nonce ?? null;
}
