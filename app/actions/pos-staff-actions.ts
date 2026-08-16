"use server";

// POS Phase 1 — staff management (dashboard admin side) + the self-registration
// finalize. The admin invites a cashier/manager by name/email/role/locations;
// the staff self-registers (phone OTP + 8-digit PIN + password → Firebase
// account with a role claim). pin_hash is WRITE-ONLY here (listStaff never
// returns it); PIN verification happens at login (pos-auth-actions).

import { and, eq, inArray } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { withService } from "@/lib/db/client";
import { dbErrorMessage, isUniqueViolation } from "@/lib/db/errors";
import { admins, posStaff, posStaffLocations } from "@/drizzle/schema";
import {
  getActingStoreId,
  getManagerIdentity,
} from "@/app/dashboard/lib/access";
import { getServerUser } from "@/lib/auth/server-user";
import { getStoreLocations } from "@/lib/pos/locations";
import { getAuthorizedDevice } from "@/lib/pos/devices";
import { hashPin, isValidPinFormat } from "@/lib/pos/pin";
import { isPosRole, type PosRole } from "@/lib/pos/permissions";
import { setUserClaims } from "@/lib/auth/firebase-claims";
import { logError } from "@/lib/observability/logger";
import { deleteAuthUser } from "@/lib/auth/firebase-users";
import {
  emailButton,
  escapeHtml,
  posAbsoluteUrl,
  sendPosStaffEmail,
} from "@/lib/pos/staff-email";

export interface ActionResult {
  success?: boolean;
  error?: string;
  /** Succeeded, but something the operator should know about didn't. Distinct
   *  from `error`: the thing they asked for HAPPENED. */
  warning?: string;
}

export interface PosStaffRow {
  id: string;
  name: string;
  email: string;
  role: PosRole;
  status: "invited" | "active" | "disabled";
  active: boolean;
  locationIds: string[];
}

const MAX_NAME = 80;
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function cleanName(v: unknown): string {
  return typeof v === "string" ? v.trim().slice(0, MAX_NAME) : "";
}
function cleanEmail(v: unknown): string {
  return typeof v === "string" ? v.trim().toLowerCase().slice(0, 200) : "";
}
async function validLocationIds(
  storeId: string,
  ids: unknown,
): Promise<string[]> {
  if (!Array.isArray(ids)) return [];
  const wanted = new Set(
    ids.filter((x): x is string => typeof x === "string" && !!x),
  );
  if (wanted.size === 0) return [];
  const locations = await getStoreLocations(storeId);
  return locations.filter((l) => wanted.has(l.id)).map((l) => l.id);
}

// ---- List --------------------------------------------------------------

export async function listStaff(): Promise<{
  staff: PosStaffRow[];
  error?: string;
}> {
  const admin = await getManagerIdentity("pos");
  if (!admin) return { staff: [], error: "Not authorized" };
  const storeId = await getActingStoreId();

  try {
    const { rows, locs } = await withService(async (db) => {
      const rows = await db
        .select({
          id: posStaff.id,
          name: posStaff.name,
          email: posStaff.email,
          role: posStaff.role,
          status: posStaff.status,
          active: posStaff.active,
        })
        .from(posStaff)
        .where(eq(posStaff.storeId, storeId));
      const ids = rows.map((r) => r.id);
      const locs = ids.length
        ? await db
            .select({
              staff_id: posStaffLocations.staffId,
              location_id: posStaffLocations.locationId,
            })
            .from(posStaffLocations)
            .where(inArray(posStaffLocations.staffId, ids))
        : [];
      return { rows, locs };
    });

    const byStaff = new Map<string, string[]>();
    for (const l of locs) {
      const arr = byStaff.get(l.staff_id) ?? [];
      arr.push(l.location_id);
      byStaff.set(l.staff_id, arr);
    }

    return {
      staff: rows.map((r) => ({
        id: r.id,
        name: r.name,
        email: r.email,
        role: (r.role as PosRole) ?? "cashier",
        status: (r.status as PosStaffRow["status"]) ?? "invited",
        active: r.active,
        locationIds: byStaff.get(r.id) ?? [],
      })),
    };
  } catch (err) {
    return { staff: [], error: dbErrorMessage(err, "Couldn't load staff.") };
  }
}

// ---- Invite ------------------------------------------------------------

export interface InviteInput {
  name: string;
  email: string;
  role: string;
  locationIds: string[];
}

async function sendInviteEmail(
  storeId: string,
  to: string,
  name: string,
  role: string,
  token: string,
) {
  // Built from the host the ADMIN is on, so the link is clickable in every
  // environment (localhost in dev, staging, prod) — see posAbsoluteUrl.
  const link = await posAbsoluteUrl(`/pos/register?token=${token}`);
  await sendPosStaffEmail({
    storeId,
    to,
    mailer: "pos_staff_invite",
    devFallback: `🧾 POS STAFF INVITED (email not configured — dev fallback)\nEmail: ${to}\nRole: ${role}\nRegister: ${link}`,
    build: (brand) => ({
      subject: `You've been added to ${brand.name} POS`,
      html: `
        <h2 style="margin-top:0;">Set up your register access</h2>
        <p>Hello ${escapeHtml(name)},</p>
        <p>You've been added to <strong>${escapeHtml(brand.name)}</strong> as a
           <strong>${escapeHtml(role)}</strong>. Finish setting up your account —
           verify your phone, then choose a password and an 8-digit PIN.</p>
        ${emailButton(link, "Complete registration")}
        <p style="color:#666;font-size:13px;">This link expires in 7 days. If you didn't expect this, you can ignore it.</p>
        <p>Regards,<br/><strong>Team ${escapeHtml(brand.name)}</strong></p>
      `,
    }),
  });
}

export async function inviteStaff(
  input: InviteInput,
): Promise<{ id?: string; error?: string }> {
  const admin = await getManagerIdentity("pos");
  if (!admin) return { error: "You don't have permission to do this." };
  const storeId = await getActingStoreId();

  const name = cleanName(input.name);
  const email = cleanEmail(input.email);
  if (!name) return { error: "Enter a name." };
  if (!email.includes("@")) return { error: "Enter a valid email." };
  if (!isPosRole(input.role)) return { error: "Pick a role." };
  const locationIds = await validLocationIds(storeId, input.locationIds);
  if (locationIds.length === 0) {
    return { error: "Assign at least one location." };
  }

  const id = crypto.randomUUID();
  const token = randomBytes(24).toString("base64url");
  const inviteExpiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();

  try {
    await withService(async (db) => {
      await db.insert(posStaff).values({
        id,
        storeId,
        name,
        email,
        role: input.role,
        status: "invited",
        inviteToken: token,
        inviteExpiresAt,
        active: true,
      });
      await db.insert(posStaffLocations).values(
        locationIds.map((locationId, i) => ({
          staffId: id,
          locationId,
          storeId,
          isPrimary: i === 0,
        })),
      );
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { error: "A staff member with this email already exists." };
    }
    return { error: dbErrorMessage(err, "Couldn't invite the staff member.") };
  }

  await sendInviteEmail(storeId, email, name, input.role, token);
  revalidatePath("/dashboard/pos/staff");
  return { id };
}

export async function resendInvite(id: string): Promise<ActionResult> {
  const admin = await getManagerIdentity("pos");
  if (!admin) return { error: "You don't have permission to do this." };
  const storeId = await getActingStoreId();
  if (typeof id !== "string" || !id) return { error: "Invalid staff member." };

  const token = randomBytes(24).toString("base64url");
  const inviteExpiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
  let row: { name: string; email: string; role: string } | undefined;
  try {
    const rows = await withService((db) =>
      db
        .update(posStaff)
        .set({
          inviteToken: token,
          inviteExpiresAt,
          updatedAt: new Date().toISOString(),
        })
        .where(
          and(
            eq(posStaff.id, id),
            eq(posStaff.storeId, storeId),
            eq(posStaff.status, "invited"),
          ),
        )
        .returning({
          name: posStaff.name,
          email: posStaff.email,
          role: posStaff.role,
        }),
    );
    row = rows[0];
  } catch (err) {
    return { error: dbErrorMessage(err, "Couldn't resend the invite.") };
  }
  if (!row) return { error: "This staff member has already registered." };

  await sendInviteEmail(storeId, row.email, row.name, row.role, token);
  return { success: true };
}

// ---- Update / activate / delete ---------------------------------------

export async function updateStaff(
  id: string,
  input: { name: string; role: string; locationIds: string[] },
): Promise<ActionResult> {
  const admin = await getManagerIdentity("pos");
  if (!admin) return { error: "You don't have permission to do this." };
  const storeId = await getActingStoreId();
  if (typeof id !== "string" || !id) return { error: "Invalid staff member." };

  const name = cleanName(input.name);
  if (!name) return { error: "Enter a name." };
  if (!isPosRole(input.role)) return { error: "Pick a role." };
  const locationIds = await validLocationIds(storeId, input.locationIds);
  if (locationIds.length === 0)
    return { error: "Assign at least one location." };

  try {
    await withService(async (db) => {
      await db
        .update(posStaff)
        .set({ name, role: input.role, updatedAt: new Date().toISOString() })
        .where(and(eq(posStaff.id, id), eq(posStaff.storeId, storeId)));
      await db
        .delete(posStaffLocations)
        .where(
          and(
            eq(posStaffLocations.staffId, id),
            eq(posStaffLocations.storeId, storeId),
          ),
        );
      await db.insert(posStaffLocations).values(
        locationIds.map((locationId, i) => ({
          staffId: id,
          locationId,
          storeId,
          isPrimary: i === 0,
        })),
      );
    });
    // A role change must reach the staff's session — re-mirror the claim.
    await withService((db) =>
      db
        .select({ user_id: posStaff.userId })
        .from(posStaff)
        .where(and(eq(posStaff.id, id), eq(posStaff.storeId, storeId)))
        .limit(1),
    ).then(async (rows) => {
      const uid = rows[0]?.user_id;
      if (uid) await setUserClaims(uid, { role: input.role }).catch(() => {});
    });
  } catch (err) {
    return { error: dbErrorMessage(err, "Couldn't save the staff member.") };
  }

  revalidatePath("/dashboard/pos/staff");
  return { success: true };
}

export async function setStaffActive(
  id: string,
  active: boolean,
): Promise<ActionResult> {
  const admin = await getManagerIdentity("pos");
  if (!admin) return { error: "You don't have permission to do this." };
  const storeId = await getActingStoreId();
  if (typeof id !== "string" || !id) return { error: "Invalid staff member." };

  try {
    await withService((db) =>
      db
        .update(posStaff)
        .set({ active: !!active, updatedAt: new Date().toISOString() })
        .where(and(eq(posStaff.id, id), eq(posStaff.storeId, storeId))),
    );
  } catch (err) {
    return { error: dbErrorMessage(err, "Couldn't update the staff member.") };
  }

  revalidatePath("/dashboard/pos/staff");
  return { success: true };
}

export async function deleteStaff(id: string): Promise<ActionResult> {
  const admin = await getManagerIdentity("pos");
  if (!admin) return { error: "You don't have permission to do this." };
  const storeId = await getActingStoreId();
  if (typeof id !== "string" || !id) return { error: "Invalid staff member." };

  let uid: string | null = null;
  try {
    const rows = await withService((db) =>
      db
        .delete(posStaff)
        .where(and(eq(posStaff.id, id), eq(posStaff.storeId, storeId)))
        .returning({ user_id: posStaff.userId }),
    );
    uid = rows[0]?.user_id ?? null;
  } catch (err) {
    return { error: dbErrorMessage(err, "Couldn't remove the staff member.") };
  }
  // ── Cleaning up the sign-in account ───────────────────────────────────────
  // There is no cascade between Identity Platform and the database, so the
  // Firebase user has to be removed explicitly.
  //
  // ★ THE DATABASE ROW GOES FIRST, and that ordering is the security decision.
  // `resolvePosOperator` re-reads `pos_staff` on EVERY request, so deleting the
  // row IS the revocation — an auth account on its own cannot sell, open a
  // drawer or touch stock. Deleting the account first and then failing the row
  // delete would be the harmful order: a staff member who still looks active
  // but can no longer sign in, with nothing saying why.
  //
  // ⚠ ONLY BY UID, NEVER BY EMAIL. It is tempting to look the account up by the
  // invited address when `user_id` is null (someone deleted mid-registration
  // leaves a Firebase account the row never recorded). Don't: that address may
  // be the person's SHOPPER account on this platform, which predates the
  // invite and has orders behind it. The uid came from the staff row, so it is
  // the only id we know belongs to this staff member.
  let authCleanup: "done" | "not-needed" | "failed" = "not-needed";
  if (uid) {
    try {
      await deleteAuthUser(uid);
      authCleanup = "done";
    } catch (err) {
      authCleanup = "failed";
      // ★★ NOT SWALLOWED. This used to be `.catch(() => {})`, and the silence
      // is what produced a live Firebase account carrying a stale
      // `role: manager` claim with nothing in the database pointing at it —
      // found in production. Two consequences, neither visible to anyone: the
      // claim keeps bouncing that account out of /dashboard (proxy.ts routes
      // cashier/manager to /pos), and the account blocks its own re-invitation.
      logError("deleteStaff: auth cleanup failed", err, { storeId, uid });

      // Best-effort fallback: if the account cannot be removed, at least strip
      // the role claim, so the worst outcome is an orphaned login rather than
      // one permanently locked out of every dashboard it touches.
      await setUserClaims(uid, { role: null }).catch((e) =>
        logError("deleteStaff: claim strip failed", e, { storeId, uid }),
      );
    }
  }

  revalidatePath("/dashboard/pos/staff");

  // ★ REPORTED, not hidden. The staff member IS removed — that part succeeded
  // and is what matters — but an operator who is never told about the leftover
  // account cannot clean it up, and will meet it again as "this email already
  // has an account" the next time they invite the same person.
  if (authCleanup === "failed") {
    return {
      success: true,
      warning:
        "Staff member removed, but their sign-in account couldn't be deleted. They can no longer use the register. Remove the account in Identity Platform before inviting this email again.",
    };
  }
  return { success: true };
}

// ---- Self-registration (from the email link) --------------------------

export interface InviteInfo {
  name: string;
  email: string;
  role: PosRole;
  error?: string;
}

/** Validate a registration token for the register page (the token is the auth).
 *  Scoped to the host store. */
export async function getInviteInfo(
  token: string,
): Promise<InviteInfo | { error: string }> {
  const storeId = await getActingStoreId();
  if (typeof token !== "string" || !token) return { error: "Invalid link." };

  const rows = await withService((db) =>
    db
      .select({
        name: posStaff.name,
        email: posStaff.email,
        role: posStaff.role,
        status: posStaff.status,
        invite_expires_at: posStaff.inviteExpiresAt,
      })
      .from(posStaff)
      .where(
        and(eq(posStaff.inviteToken, token), eq(posStaff.storeId, storeId)),
      )
      .limit(1),
  ).catch(() => []);
  const row = rows[0];
  if (!row || row.status !== "invited") {
    return { error: "This invitation is no longer valid." };
  }
  if (row.invite_expires_at && new Date(row.invite_expires_at) < new Date()) {
    return {
      error: "This invitation has expired. Ask your manager to resend it.",
    };
  }
  return {
    name: row.name,
    email: row.email,
    role: (row.role as PosRole) ?? "cashier",
  };
}

export interface RegistrationResult extends ActionResult {
  /**
   * Whether the browser they registered ON is an authorized POS device. Staff
   * usually register on their PERSONAL phone from the emailed link, which is
   * fine — registration is identity setup, not selling — so the client shows a
   * "you're all set, sign in at the shop" confirmation instead of dumping them
   * on the register's device gate. If the owner handed them the shop's
   * authorized tablet to register on, they can start selling immediately.
   */
  deviceAuthorized?: boolean;
}

/**
 * Finalize registration. The client has already created the Firebase account
 * (email + password), OTP-verified the phone, and established a session — so
 * getServerUser() is the just-registered staff. We verify the token + email +
 * phone, store the PIN, link the account, and set the role claim.
 *
 * NOTE: this deliberately does NOT require an authorized device. Identity is
 * portable; only SELLING is device-bound (see resolvePosOperator).
 */
export async function completeStaffRegistration(
  token: string,
  pin: string,
): Promise<RegistrationResult> {
  const user = await getServerUser();
  if (!user) return { error: "Please finish creating your account first." };
  if (!user.phoneConfirmed) return { error: "Please verify your phone first." };
  if (!isValidPinFormat(pin)) return { error: "PIN must be 8 digits." };

  const storeId = await getActingStoreId();
  const rows = await withService((db) =>
    db
      .select({
        id: posStaff.id,
        email: posStaff.email,
        role: posStaff.role,
        status: posStaff.status,
        invite_expires_at: posStaff.inviteExpiresAt,
      })
      .from(posStaff)
      .where(
        and(eq(posStaff.inviteToken, token), eq(posStaff.storeId, storeId)),
      )
      .limit(1),
  ).catch(() => []);
  const staff = rows[0];
  if (!staff || staff.status !== "invited") {
    return { error: "This invitation is no longer valid." };
  }
  if (
    staff.invite_expires_at &&
    new Date(staff.invite_expires_at) < new Date()
  ) {
    return { error: "This invitation has expired." };
  }
  // The account they created must match the invited email.
  if ((user.email ?? "").toLowerCase() !== staff.email.toLowerCase()) {
    return { error: "Use the email address your invitation was sent to." };
  }

  // ★★ A DASHBOARD ADMIN MUST NOT COMPLETE THIS, or they lock themselves out.
  // Finishing sets a `cashier`/`manager` role claim, and proxy.ts sends those
  // straight from /dashboard to /pos — so an owner who invites themselves "to
  // try the till" would lose the dashboard for every store they administer,
  // recoverable only by editing claims by hand.
  //
  // Firebase custom claims are per-USER, not per-store, which is why this looks
  // across ALL stores rather than just this one: a claim earned at shop B
  // bounces them out of shop A's dashboard just the same. The current claim
  // model genuinely cannot represent "admin here, cashier there", so refusing
  // and saying why beats a silent lockout.
  //
  // ⚠ The owner does not need this anyway — resolvePosOperator resolves an
  // owner with no pos_staff row and no device restriction (§22).
  // try/catch rather than `.catch()`: a synchronous throw from inside the
  // callback escapes withService before it becomes a promise, so a trailing
  // .catch() would miss it and the whole action would reject instead of
  // failing closed. A test caught exactly that.
  let adminRows: { id: string }[] | null = null;
  try {
    adminRows = await withService((db) =>
      db
        .select({ id: admins.id })
        .from(admins)
        .where(eq(admins.id, user.id))
        .limit(1),
    );
  } catch {
    adminRows = null;
  }
  // A read failure fails CLOSED: wrongly refusing costs a retry, wrongly
  // allowing costs a dashboard.
  if (adminRows === null || adminRows.length > 0) {
    return {
      error:
        adminRows === null
          ? "Couldn't verify this account. Please try again."
          : "This email is already a dashboard admin, and staff accounts can't sign in to the dashboard. Ask for the invitation to be sent to a different address — as an owner or admin you can already use the register without one.",
    };
  }

  try {
    await withService((db) =>
      db
        .update(posStaff)
        .set({
          userId: user.id,
          pinHash: hashPin(pin),
          status: "active",
          inviteToken: null,
          inviteExpiresAt: null,
          updatedAt: new Date().toISOString(),
        })
        .where(and(eq(posStaff.id, staff.id), eq(posStaff.storeId, storeId))),
    );
  } catch (err) {
    return { error: dbErrorMessage(err, "Couldn't complete registration.") };
  }

  // Role claim → the proxy blocks this account from /dashboard.
  await setUserClaims(user.id, { role: staff.role }).catch((e) =>
    console.error("completeStaffRegistration setUserClaims:", e),
  );

  // Tell the client where to send them: straight into the register if they
  // registered on an authorized shop device, else a confirmation screen.
  const device = await getAuthorizedDevice(storeId).catch(() => null);
  return { success: true, deviceAuthorized: !!device };
}
