// Resolve the current POS actor, server-side (docs/pos-plan.md §3). Never trusted
// from the client. Order:
//   1. Owner — a dashboard admin with POS access (Firebase session). NOT
//      device-restricted; scoped to the default location for now.
//   2. Staff via a PIN-minted pos_operator cookie — tied to the authorized
//      device it was created on.
//   3. Staff via their own Firebase session (email + password login) — must map
//      to a pos_staff row, be active, and be assigned to the authorized device's
//      location.
// Steps 2 & 3 REQUIRE an authorized device (getAuthorizedDevice), so a cashier on
// an unauthorized device (their personal phone) resolves to null → /pos/login.

import { and, eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { withService } from "@/lib/db/client";
import { posStaff, posStaffLocations } from "@/drizzle/schema";
import { getCurrentStoreId } from "@/lib/store/resolve";
import { getManagerIdentity } from "@/app/dashboard/lib/access";
import { getServerUser } from "@/lib/auth/server-user";
import { getDefaultLocationId } from "@/lib/pos/locations";
import { getAuthorizedDevice } from "@/lib/pos/devices";
import { POS_OPERATOR_COOKIE, verifyOperatorToken } from "@/lib/pos/session";
import {
  isPosRole,
  type PosActorRole,
  type PosRole,
} from "@/lib/pos/permissions";

export interface PosOperator {
  role: PosActorRole;
  storeId: string;
  locationId: string;
  /** pos_staff id, or null for the owner path. */
  staffId: string | null;
  name: string;
  source: "owner" | "operator";
  /** True when the current browser is an authorized device (owner may authorize). */
  deviceAuthorized: boolean;
}

export async function resolvePosOperator(): Promise<PosOperator | null> {
  const storeId = await getCurrentStoreId();
  const device = await getAuthorizedDevice(storeId);

  // 1. Owner — a dashboard admin with POS access. NOT device-restricted.
  const ownerIdentity = await getManagerIdentity("pos");
  if (ownerIdentity) {
    const locationId =
      device?.locationId ?? (await getDefaultLocationId(storeId));
    if (locationId) {
      return {
        role: "owner",
        storeId,
        locationId,
        staffId: null,
        name: ownerIdentity.email ?? "Owner",
        source: "owner",
        deviceAuthorized: !!device,
      };
    }
  }

  // Staff are device-locked: no authorized device ⇒ not an operator here.
  if (!device) return null;

  // 2. Staff via a PIN-minted operator cookie (must match THIS device).
  //
  // The cookie's claims are NOT trusted for authorisation: role, name and even
  // continued employment are re-read from pos_staff on every resolve. Trusting
  // the token would let a cashier you deactivated (or demoted) keep selling
  // with their old rights until it expired — offboarding has to be immediate.
  const op = verifyOperatorToken(
    (await cookies()).get(POS_OPERATOR_COOKIE)?.value,
  );
  if (op && op.storeId === storeId && op.deviceId === device.deviceId) {
    const staff = await loadActiveStaff(storeId, op.staffId, device.locationId);
    if (staff) {
      return {
        role: staff.role,
        storeId,
        locationId: device.locationId,
        staffId: staff.id,
        name: staff.name,
        source: "operator",
        deviceAuthorized: true,
      };
    }
    // Deactivated, deleted, demoted out of POS, or unassigned from this
    // location → the session is void; fall through to the signed-out state.
  }

  // 3. Staff via their own Firebase session (password login).
  const user = await getServerUser();
  if (user) {
    const staff = await loadActiveStaff(
      storeId,
      { userId: user.id },
      device.locationId,
    );
    if (staff) {
      return {
        role: staff.role,
        storeId,
        locationId: device.locationId,
        staffId: staff.id,
        name: staff.name,
        source: "operator",
        deviceAuthorized: true,
      };
    }
  }

  return null;
}

interface ActiveStaff {
  id: string;
  name: string;
  role: PosRole;
}

/**
 * The authoritative staff record for a POS session: active, registered, holding
 * a real POS role, and assigned to the location this device belongs to. Any of
 * those failing invalidates the session immediately — this is what makes
 * deactivation, deletion, demotion and location changes take effect at once
 * rather than whenever a token happens to expire.
 */
async function loadActiveStaff(
  storeId: string,
  by: string | { userId: string },
  locationId: string,
): Promise<ActiveStaff | null> {
  const match =
    typeof by === "string"
      ? eq(posStaff.id, by)
      : eq(posStaff.userId, by.userId);

  const rows = await withService((db) =>
    db
      .select({
        id: posStaff.id,
        name: posStaff.name,
        role: posStaff.role,
      })
      .from(posStaff)
      .innerJoin(
        posStaffLocations,
        and(
          eq(posStaffLocations.staffId, posStaff.id),
          eq(posStaffLocations.locationId, locationId),
        ),
      )
      .where(
        and(
          match,
          eq(posStaff.storeId, storeId),
          eq(posStaff.active, true),
          eq(posStaff.status, "active"),
        ),
      )
      .limit(1),
  ).catch(() => []);

  const row = rows[0];
  if (!row || !isPosRole(row.role)) return null;
  return { id: row.id, name: row.name, role: row.role };
}
