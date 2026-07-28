"use server";

// POS Phase 1 — device authorization + staff PIN login (the /pos auth flow).
// Everything is established SERVER-SIDE:
//   authorizeThisDevice(loc) — owner marks THIS browser as an authorized POS
//                              device (sets the signed pos_device cookie).
//   pairDevice(code)         — code fallback: authorize a device remotely.
//   posLoginWithPin(email,pin) — staff sign in on an authorized device → the
//                              signed pos_operator cookie. (Password login is
//                              client-side Firebase; the /pos device gate applies.)
//   posLock()                — clears the operator cookie.
// Admin-side: createPairingCode / listDevices / revokeDevice (gated on `pos`).

import { and, count, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { cookies, headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { withService } from "@/lib/db/client";
import { dbErrorMessage } from "@/lib/db/errors";
import { effectivePlan, limitsFor } from "@/lib/plans";
import {
  posAuditLog,
  posDevices,
  posPairingCodes,
  posStaff,
  posStaffLocations,
  stores,
} from "@/drizzle/schema";
import {
  getActingStoreId,
  getManagerIdentity,
} from "@/app/dashboard/lib/access";
import { getCurrentStoreId } from "@/lib/store/resolve";
import { getStoreLocations } from "@/lib/pos/locations";
import {
  getAuthorizedDevice,
  getDeviceNonce,
  newDeviceNonce,
  rotateDeviceNonce,
} from "@/lib/pos/devices";
import {
  SESSION_COOKIE,
  sessionCookieOptions,
} from "@/lib/auth/session-cookie";
import { posAudit } from "@/lib/pos/audit";
import { rateLimit, clientIp } from "@/lib/rate-limit";
import { hashPin, verifyPin, isValidPinFormat } from "@/lib/pos/pin";
import { isPosRole } from "@/lib/pos/permissions";
import { updateAuthUser } from "@/lib/auth/firebase-users";
import {
  emailButton,
  escapeHtml,
  posAbsoluteUrl,
  sendPosStaffEmail,
} from "@/lib/pos/staff-email";
import {
  POS_DEVICE_COOKIE,
  POS_DEVICE_MAX_AGE_S,
  POS_OPERATOR_COOKIE,
  POS_OPERATOR_MAX_AGE_S,
  POS_SECRET_MISSING_ERROR,
  posSessionConfigured,
  signDeviceToken,
  signOperatorToken,
} from "@/lib/pos/session";

export interface ActionResult {
  success?: boolean;
  error?: string;
}

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const PAIRING_TTL_MS = 10 * 60 * 1000;

function genCode(): string {
  const bytes = randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i++)
    out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  return out;
}

// POS cookies are deliberately HOST-ONLY (no Domain attribute), unlike the
// dashboard's sm_session which spans .storemink.com by design. A register
// credential has no business being transmitted to every other store's
// subdomain, the platform apex, or the help centre — scope it to the one host
// that uses it.
function posCookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    // Strict: a POS cookie should never ride a cross-site navigation.
    sameSite: "strict" as const,
    path: "/",
    maxAge,
  };
}

/**
 * Active (non-revoked) devices at a location vs. what the plan allows. Bounds
 * the damage from a leaked pairing code and keeps the device list something an
 * owner can actually review.
 */
async function deviceCapReached(
  storeId: string,
  locationId: string,
): Promise<{ reached: boolean; cap: number }> {
  const storeRows = await withService((db) =>
    db
      .select({ plan: stores.plan, plan_expires_at: stores.planExpiresAt })
      .from(stores)
      .where(eq(stores.id, storeId))
      .limit(1),
  ).catch(() => []);
  const cap = limitsFor(
    effectivePlan(storeRows[0] ?? {}),
  ).posDevicesPerLocation;

  const rows = await withService((db) =>
    db
      .select({ n: count() })
      .from(posDevices)
      .where(
        and(
          eq(posDevices.storeId, storeId),
          eq(posDevices.locationId, locationId),
          isNull(posDevices.revokedAt),
        ),
      ),
  ).catch(() => []);
  return { reached: (rows[0]?.n ?? 0) >= cap, cap };
}

// Create a pos_devices row + set the signed pos_device cookie on THIS browser.
async function registerDevice(
  storeId: string,
  locationId: string,
  actor: string | null,
): Promise<ActionResult> {
  // Enforced HERE — the single choke point both authorization paths funnel
  // through, so a pairing code can't be used to exceed the cap either.
  const { reached, cap } = await deviceCapReached(storeId, locationId);
  if (reached) {
    return {
      error: `This location already has ${cap} authorized devices. Revoke one in Dashboard → POS → Devices before adding another.`,
    };
  }

  const deviceId = crypto.randomUUID();
  const nonce = newDeviceNonce();

  // Mint the cookie BEFORE inserting the row. Every input is already known, and
  // signing is the one step that can fail for a reason the DB knows nothing
  // about (a missing POS_SESSION_SECRET). Insert-then-sign left an authorized
  // device row behind on every failure — rows that counted against the
  // per-location cap, so a genuinely broken deployment eventually reported
  // "this location already has 5 authorized devices" instead of its real fault.
  let token: string;
  try {
    token = signDeviceToken({ deviceId, storeId, locationId, nonce });
  } catch {
    return { error: POS_SECRET_MISSING_ERROR };
  }

  try {
    await withService((db) =>
      db.insert(posDevices).values({
        id: deviceId,
        storeId,
        locationId,
        label: "",
        tokenNonce: nonce,
        authorizedBy: actor,
        lastSeenAt: new Date().toISOString(),
      }),
    );
  } catch (err) {
    return { error: dbErrorMessage(err, "Couldn't authorize this device.") };
  }
  (await cookies()).set(
    POS_DEVICE_COOKIE,
    token,
    posCookieOptions(POS_DEVICE_MAX_AGE_S),
  );
  await posAudit({
    storeId,
    event: "device_authorized",
    deviceId,
    locationId,
    actor,
  });
  return { success: true };
}

// ---- Owner: authorize this device -----------------------------------------

export async function authorizeThisDevice(
  locationId: string,
): Promise<ActionResult> {
  // Only an owner/admin (dashboard POS access) may authorize a device.
  const admin = await getManagerIdentity("pos");
  if (!admin) return { error: "Only a store owner can authorize a device." };
  const storeId = await getCurrentStoreId();

  const locations = await getStoreLocations(storeId);
  if (!locations.some((l) => l.id === locationId)) {
    return { error: "Pick a location." };
  }
  return registerDevice(storeId, locationId, admin.email ?? admin.uid);
}

// ---- Admin: pairing codes & devices ---------------------------------------

export async function createPairingCode(
  locationId: string,
): Promise<{ code?: string; expiresAt?: string; error?: string }> {
  const admin = await getManagerIdentity("pos");
  if (!admin) return { error: "You don't have permission to do this." };
  const storeId = await getActingStoreId();

  const locations = await getStoreLocations(storeId);
  if (!locations.some((l) => l.id === locationId)) {
    return { error: "Pick a location." };
  }

  // Tell the admin now rather than after they've handed out a code that can't
  // be redeemed (registerDevice enforces the same cap).
  const { reached, cap } = await deviceCapReached(storeId, locationId);
  if (reached) {
    return {
      error: `This location already has ${cap} authorized devices. Revoke one before adding another.`,
    };
  }

  const code = genCode();
  const expiresAt = new Date(Date.now() + PAIRING_TTL_MS).toISOString();
  try {
    await withService((db) =>
      db
        .insert(posPairingCodes)
        .values({ code, storeId, locationId, expiresAt }),
    );
  } catch (err) {
    return { error: dbErrorMessage(err, "Couldn't create a pairing code.") };
  }
  return { code, expiresAt };
}

export interface PosDeviceRow {
  id: string;
  label: string;
  locationId: string;
  revoked: boolean;
  /** Why it stopped working: clone_detected | revoked_by_admin. */
  revokedReason: string | null;
  revokedAt: string | null;
  authorizedBy: string | null;
  lastSeenAt: string | null;
  createdAt: string;
}

export async function listDevices(): Promise<{
  devices: PosDeviceRow[];
  error?: string;
}> {
  const admin = await getManagerIdentity("pos");
  if (!admin) return { devices: [], error: "Not authorized" };
  const storeId = await getActingStoreId();
  try {
    const rows = await withService((db) =>
      db
        .select({
          id: posDevices.id,
          label: posDevices.label,
          location_id: posDevices.locationId,
          revoked_at: posDevices.revokedAt,
          revoked_reason: posDevices.revokedReason,
          authorized_by: posDevices.authorizedBy,
          last_seen_at: posDevices.lastSeenAt,
          created_at: posDevices.createdAt,
        })
        .from(posDevices)
        .where(eq(posDevices.storeId, storeId))
        .orderBy(desc(posDevices.createdAt)),
    );
    return {
      devices: rows.map((r) => ({
        id: r.id,
        label: r.label,
        locationId: r.location_id,
        revoked: !!r.revoked_at,
        revokedReason: r.revoked_reason,
        revokedAt: r.revoked_at,
        authorizedBy: r.authorized_by,
        lastSeenAt: r.last_seen_at,
        createdAt: r.created_at,
      })),
    };
  } catch (err) {
    return {
      devices: [],
      error: dbErrorMessage(err, "Couldn't load devices."),
    };
  }
}

export interface PosActivityRow {
  id: string;
  event: string;
  deviceId: string | null;
  locationId: string | null;
  actor: string | null;
  ip: string | null;
  detail: string | null;
  createdAt: string;
}

/**
 * Recent POS security events for the dashboard. Without this the audit trail is
 * write-only: a device auto-revoked for clone detection would just stop working
 * with no visible explanation.
 */
export async function listPosActivity(
  limit = 50,
): Promise<{ events: PosActivityRow[]; error?: string }> {
  const admin = await getManagerIdentity("pos");
  if (!admin) return { events: [], error: "Not authorized" };
  const storeId = await getActingStoreId();
  const safeLimit = Math.min(Math.max(Math.trunc(limit) || 50, 1), 200);

  try {
    const rows = await withService((db) =>
      db
        .select({
          id: posAuditLog.id,
          event: posAuditLog.event,
          device_id: posAuditLog.deviceId,
          location_id: posAuditLog.locationId,
          actor: posAuditLog.actor,
          ip: posAuditLog.ip,
          detail: posAuditLog.detail,
          created_at: posAuditLog.createdAt,
        })
        .from(posAuditLog)
        .where(eq(posAuditLog.storeId, storeId))
        .orderBy(desc(posAuditLog.createdAt))
        .limit(safeLimit),
    );
    return {
      events: rows.map((r) => ({
        id: r.id,
        event: r.event,
        deviceId: r.device_id,
        locationId: r.location_id,
        actor: r.actor,
        ip: r.ip,
        detail: r.detail,
        createdAt: r.created_at,
      })),
    };
  } catch (err) {
    return {
      events: [],
      error: dbErrorMessage(err, "Couldn't load activity."),
    };
  }
}

export async function revokeDevice(id: string): Promise<ActionResult> {
  const admin = await getManagerIdentity("pos");
  if (!admin) return { error: "You don't have permission to do this." };
  const storeId = await getActingStoreId();
  if (typeof id !== "string" || !id) return { error: "Invalid device." };
  try {
    await withService((db) =>
      db
        .update(posDevices)
        .set({
          revokedAt: new Date().toISOString(),
          revokedReason: "revoked_by_admin",
          revokedBy: admin.email ?? admin.uid,
        })
        .where(and(eq(posDevices.id, id), eq(posDevices.storeId, storeId))),
    );
  } catch (err) {
    return { error: dbErrorMessage(err, "Couldn't revoke the device.") };
  }
  await posAudit({
    storeId,
    event: "device_revoked",
    deviceId: id,
    actor: admin.email ?? admin.uid,
  });
  revalidatePath("/dashboard/pos/devices");
  return { success: true };
}

// ---- Device: authorize via code (fallback) --------------------------------

export async function pairDevice(
  rawCode: string,
): Promise<{ success?: boolean; error?: string }> {
  const storeId = await getCurrentStoreId();
  const ip = clientIp(await headers());
  // Throttled per IP *and* per store: an IP-only limit lets a distributed
  // attacker grind codes, and the store ceiling bounds the total guess rate
  // against this tenant no matter how many addresses they come from.
  const [byIp, byStore] = await Promise.all([
    rateLimit(`pos-pair-ip:${ip}`, { max: 10, windowSeconds: 60 }),
    rateLimit(`pos-pair-store:${storeId}`, { max: 30, windowSeconds: 300 }),
  ]);
  if (!byIp.allowed || !byStore.allowed) {
    return { error: "Too many attempts. Please wait a moment." };
  }

  const code = typeof rawCode === "string" ? rawCode.trim().toUpperCase() : "";
  if (!/^[A-Z0-9]{8}$/.test(code)) return { error: "Invalid pairing code." };

  // Atomically claim an unused, unexpired code belonging to THIS host store.
  let claimed: { location_id: string } | undefined;
  try {
    const rows = await withService((db) =>
      db
        .update(posPairingCodes)
        .set({ usedAt: new Date().toISOString() })
        .where(
          and(
            eq(posPairingCodes.code, code),
            eq(posPairingCodes.storeId, storeId),
            sql`${posPairingCodes.usedAt} is null`,
            gt(posPairingCodes.expiresAt, sql`now()`),
          ),
        )
        .returning({ location_id: posPairingCodes.locationId }),
    );
    claimed = rows[0];
  } catch (err) {
    return { error: dbErrorMessage(err, "Couldn't authorize this device.") };
  }
  if (!claimed) return { error: "That code is invalid or has expired." };

  return registerDevice(storeId, claimed.location_id, "pairing_code");
}

// ---- Staff: PIN login on an authorized device -----------------------------

export interface PinLoginResult {
  success?: boolean;
  error?: string;
  /** Credentials were correct, but this browser isn't an authorized device yet
   *  — the client then asks for a pairing code rather than dead-ending. */
  needsPairing?: boolean;
  operator?: { name: string; role: "cashier" | "manager" };
}

/**
 * Sign a staff member in at the register.
 *
 * ORDER MATTERS: credentials are checked BEFORE the device. A cashier arriving
 * at work should be able to type their email and PIN and be told what to do
 * next — leading with "this device isn't set up" gives them a wall with no
 * route through it. Verifying first lets us answer precisely: wrong PIN, or
 * right PIN on a device that still needs pairing.
 *
 * This does NOT weaken the device lock. Correct credentials on an unauthorized
 * device still mint NO operator session; the caller must supply a pairing code
 * (which only an owner can generate) before anything can be sold.
 */
export async function posLoginWithPin(
  rawEmail: string,
  pin: string,
): Promise<PinLoginResult> {
  const storeId = await getCurrentStoreId();

  const email =
    typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : "";
  if (!email.includes("@")) return { error: "Enter your email." };
  if (!isValidPinFormat(pin)) return { error: "Enter your 8-digit PIN." };

  // Refuse up front rather than mid-flow: this sign-in ROTATES the device nonce
  // before it mints cookies, so throwing at the signing step would leave the
  // device holding a retired nonce — which getAuthorizedDevice reads as a clone
  // and punishes by revoking the device. A missing secret must not cost a shop
  // its authorized register.
  if (!posSessionConfigured()) return { error: POS_SECRET_MISSING_ERROR };

  // Throttled per email + IP: there may be no device yet to key on.
  const ip = clientIp(await headers());
  const [byEmail, byIp] = await Promise.all([
    rateLimit(`pos-pin-email:${storeId}:${email}`, {
      max: 8,
      windowSeconds: 60,
    }),
    rateLimit(`pos-pin-ip:${ip}`, { max: 20, windowSeconds: 60 }),
  ]);
  if (!byEmail.allowed || !byIp.allowed) {
    return { error: "Too many attempts. Please wait a moment." };
  }

  // 1. Verify WHO they are (login is by email, unique per store).
  let staff:
    | { id: string; name: string; role: string; pin_hash: string | null }
    | undefined;
  try {
    const rows = await withService((db) =>
      db
        .select({
          id: posStaff.id,
          name: posStaff.name,
          role: posStaff.role,
          pin_hash: posStaff.pinHash,
        })
        .from(posStaff)
        .where(
          and(
            eq(posStaff.storeId, storeId),
            eq(posStaff.email, email),
            eq(posStaff.active, true),
            eq(posStaff.status, "active"),
          ),
        )
        .limit(1),
    );
    staff = rows[0];
  } catch (err) {
    return { error: dbErrorMessage(err, "Couldn't sign in.") };
  }

  if (!staff || !verifyPin(pin, staff.pin_hash) || !isPosRole(staff.role)) {
    await posAudit({
      storeId,
      event: "operator_login_failed",
      actor: email,
      detail: "Incorrect email or PIN",
    });
    return { error: "Incorrect email or PIN." };
  }

  // 2. Only now check the device. Credentials are good, so we can guide them.
  const device = await getAuthorizedDevice(storeId);
  if (!device) {
    return {
      needsPairing: true,
      error:
        "This device isn't set up for the register yet. Enter a pairing code from Dashboard → POS → Devices.",
    };
  }

  // 3. Managers/cashiers are location-bound — the device decides which counter.
  let assigned = false;
  try {
    const rows = await withService((db) =>
      db
        .select({ staff_id: posStaffLocations.staffId })
        .from(posStaffLocations)
        .where(
          and(
            eq(posStaffLocations.staffId, staff!.id),
            eq(posStaffLocations.locationId, device.locationId),
          ),
        )
        .limit(1),
    );
    assigned = !!rows[0];
  } catch (err) {
    return { error: dbErrorMessage(err, "Couldn't sign in.") };
  }
  if (!assigned) {
    await posAudit({
      storeId,
      event: "operator_login_failed",
      deviceId: device.deviceId,
      locationId: device.locationId,
      actor: email,
      detail: "Not assigned to this location",
    });
    return { error: "You're not assigned to this location." };
  }

  const jar = await cookies();

  // Rotate the device token on every sign-in. If a copy of this device cookie
  // exists elsewhere, the copy now holds a retired nonce and will be caught by
  // getAuthorizedDevice (which revokes the device and logs it). Best-effort:
  // never block a cashier from serving a customer over a hardening step.
  const rotated = await rotateDeviceNonce(
    storeId,
    device.deviceId,
    await getDeviceNonce(storeId, device.deviceId),
  );
  if (rotated) {
    jar.set(
      POS_DEVICE_COOKIE,
      signDeviceToken({
        deviceId: device.deviceId,
        storeId,
        locationId: device.locationId,
        nonce: rotated,
      }),
      posCookieOptions(POS_DEVICE_MAX_AGE_S),
    );
  }

  jar.set(
    POS_OPERATOR_COOKIE,
    signOperatorToken({
      staffId: staff.id,
      storeId,
      locationId: device.locationId,
      deviceId: device.deviceId,
      role: staff.role,
      name: staff.name,
    }),
    posCookieOptions(POS_OPERATOR_MAX_AGE_S),
  );

  await posAudit({
    storeId,
    event: "operator_login",
    deviceId: device.deviceId,
    staffId: staff.id,
    locationId: device.locationId,
    actor: staff.name,
  });
  return { success: true, operator: { name: staff.name, role: staff.role } };
}

/**
 * Hand the till over: end BOTH credentials so the next person gets the login
 * screen.
 *
 * Clearing only the operator cookie was not enough. An owner (and any staff who
 * signed in with a password rather than a PIN) holds a Firebase `sm_session`,
 * and resolvePosOperator checks that FIRST — so after "Lock" they still
 * resolved, /pos/login redirected them straight back to the register, and the
 * device could never actually be handed to a cashier.
 *
 * Yes, this signs an owner out of the dashboard too: it is the same
 * .storemink.com cookie. That is the correct reading of "I am walking away
 * from this shared till" — leaving dashboard access alive on a counter tablet
 * is the outcome nobody wants.
 */
export async function posLock(): Promise<ActionResult> {
  const jar = await cookies();
  jar.delete(POS_OPERATOR_COOKIE);

  // The delete must carry the SAME domain/path the cookie was set with, or the
  // cross-subdomain cookie survives (see app/api/auth/signout/route.ts).
  const h = await headers();
  const host = h.get("x-forwarded-host") || h.get("host");
  jar.set(SESSION_COOKIE, "", { ...sessionCookieOptions(host), maxAge: 0 });

  return { success: true };
}

// ---- Self-service credential reset (forgot PIN / password) ----------------
//
// A cashier who forgets their PIN mid-rush shouldn't have to wait for an admin.
// "Forgot PIN or password?" emails a single-use, 1-hour link; the token is the
// authorization (the inbox proves identity), so the reset page needs no session
// and works on any device — like registration, it is identity, not selling.

const RESET_TTL_MS = 60 * 60 * 1000;

export async function requestPosCredentialReset(
  rawEmail: string,
): Promise<ActionResult> {
  const storeId = await getCurrentStoreId();
  const email =
    typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : "";

  // Throttle per IP and per address so this can't be used to blast someone's
  // inbox or to probe which addresses exist.
  const ip = clientIp(await headers());
  const [byIp, byEmail] = await Promise.all([
    rateLimit(`pos-reset-ip:${ip}`, { max: 10, windowSeconds: 900 }),
    rateLimit(`pos-reset-email:${email}`, { max: 3, windowSeconds: 900 }),
  ]);

  // ALWAYS report success — never reveal whether an address is registered
  // (account enumeration). The email only arrives if the account is real.
  const ok: ActionResult = { success: true };
  if (!byIp.allowed || !byEmail.allowed) return ok;
  if (!email.includes("@")) return ok;

  const token = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + RESET_TTL_MS).toISOString();

  // Only an ACTIVE staff member can reset; someone still 'invited' must use
  // their invitation link (which sets up the account in the first place).
  let staff: { name: string } | undefined;
  try {
    const rows = await withService((db) =>
      db
        .update(posStaff)
        .set({ resetToken: token, resetExpiresAt: expiresAt })
        .where(
          and(
            eq(posStaff.storeId, storeId),
            eq(posStaff.email, email),
            eq(posStaff.status, "active"),
            eq(posStaff.active, true),
          ),
        )
        .returning({ name: posStaff.name }),
    );
    staff = rows[0];
  } catch (err) {
    console.error("requestPosCredentialReset:", err);
    return ok;
  }
  if (!staff) return ok;

  const link = await posAbsoluteUrl(`/pos/reset?token=${token}`);
  await sendPosStaffEmail({
    storeId,
    to: email,
    mailer: "pos_credential_reset",
    devFallback: `🔑 POS CREDENTIAL RESET (email not configured — dev fallback)\nEmail: ${email}\nReset: ${link}`,
    build: (brand) => ({
      subject: `Reset your ${brand.name} POS access`,
      html: `
        <h2 style="margin-top:0;">Reset your register access</h2>
        <p>Hello ${escapeHtml(staff!.name)},</p>
        <p>We received a request to reset the PIN or password you use at the
           <strong>${escapeHtml(brand.name)}</strong> register.</p>
        ${emailButton(link, "Reset PIN or password")}
        <p style="color:#666;font-size:13px;">This link expires in 1 hour and can be used once. If you didn't request it, you can safely ignore this email — nothing has changed.</p>
        <p>Regards,<br/><strong>Team ${escapeHtml(brand.name)}</strong></p>
      `,
    }),
  });
  return ok;
}

export interface PosResetInfo {
  name: string;
  email: string;
}

/** Validate a reset token for the reset page (the token IS the authorization). */
export async function getPosResetInfo(
  token: string,
): Promise<PosResetInfo | { error: string }> {
  const storeId = await getCurrentStoreId();
  if (typeof token !== "string" || !token) return { error: "Invalid link." };

  const rows = await withService((db) =>
    db
      .select({
        name: posStaff.name,
        email: posStaff.email,
        reset_expires_at: posStaff.resetExpiresAt,
      })
      .from(posStaff)
      .where(and(eq(posStaff.resetToken, token), eq(posStaff.storeId, storeId)))
      .limit(1),
  ).catch(() => []);
  const row = rows[0];
  if (!row) return { error: "This reset link is no longer valid." };
  if (row.reset_expires_at && new Date(row.reset_expires_at) < new Date()) {
    return { error: "This reset link has expired. Please request a new one." };
  }
  return { name: row.name, email: row.email };
}

export type PosResetMode = "pin" | "password";

/**
 * Apply the reset and consume the token. `pin` is hashed here; `password` is
 * written to the staff member's Identity Platform account with the Admin SDK
 * (the token, not a session, is the authorization).
 */
export async function completePosReset(
  token: string,
  mode: PosResetMode,
  value: string,
): Promise<ActionResult> {
  const storeId = await getCurrentStoreId();
  if (typeof token !== "string" || !token) return { error: "Invalid link." };
  if (mode !== "pin" && mode !== "password") {
    return { error: "Choose what to reset." };
  }
  if (mode === "pin" && !isValidPinFormat(value)) {
    return { error: "PIN must be exactly 8 digits." };
  }
  if (mode === "password" && (typeof value !== "string" || value.length < 8)) {
    return { error: "Password must be at least 8 characters." };
  }

  const ip = clientIp(await headers());
  const { allowed } = await rateLimit(`pos-reset-apply:${ip}`, {
    max: 20,
    windowSeconds: 900,
  });
  if (!allowed) return { error: "Too many attempts. Please wait a moment." };

  let staff:
    | { id: string; user_id: string | null; reset_expires_at: string | null }
    | undefined;
  try {
    const rows = await withService((db) =>
      db
        .select({
          id: posStaff.id,
          user_id: posStaff.userId,
          reset_expires_at: posStaff.resetExpiresAt,
        })
        .from(posStaff)
        .where(
          and(
            eq(posStaff.resetToken, token),
            eq(posStaff.storeId, storeId),
            eq(posStaff.status, "active"),
            eq(posStaff.active, true),
          ),
        )
        .limit(1),
    );
    staff = rows[0];
  } catch (err) {
    return { error: dbErrorMessage(err, "Couldn't reset your access.") };
  }
  if (!staff) return { error: "This reset link is no longer valid." };
  if (staff.reset_expires_at && new Date(staff.reset_expires_at) < new Date()) {
    return { error: "This reset link has expired. Please request a new one." };
  }

  if (mode === "password") {
    if (!staff.user_id) {
      return {
        error: "This account isn't set up yet. Use your invitation link.",
      };
    }
    try {
      await updateAuthUser(staff.user_id, { password: value });
    } catch (err) {
      console.error("completePosReset (password):", err);
      return { error: "Couldn't update your password. Please try again." };
    }
  }

  // Consume the token (single use) and, for a PIN reset, store the new hash.
  try {
    await withService((db) =>
      db
        .update(posStaff)
        .set({
          ...(mode === "pin" ? { pinHash: hashPin(value) } : {}),
          resetToken: null,
          resetExpiresAt: null,
          updatedAt: new Date().toISOString(),
        })
        .where(and(eq(posStaff.id, staff!.id), eq(posStaff.storeId, storeId))),
    );
  } catch (err) {
    return { error: dbErrorMessage(err, "Couldn't reset your access.") };
  }

  return { success: true };
}
