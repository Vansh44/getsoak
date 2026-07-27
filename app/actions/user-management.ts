"use server";

import { count, eq } from "drizzle-orm";
import { getServerUser } from "@/lib/auth/server-user";
import { emitEvent } from "@/lib/notifications/record";
import { sendEmail } from "@/lib/email/send";
import { getActingStoreId } from "@/app/dashboard/lib/access";
import {
  deleteAuthUser,
  updateAuthUser,
  generatePasswordResetLink,
} from "@/lib/auth/firebase-users";
import { setUserClaims } from "@/lib/auth/firebase-claims";
import { withService, withUser } from "@/lib/db/client";
import { admins, roles } from "@/drizzle/schema";
import { wrapBrandedEmail } from "@/lib/email/layout";
import { fromAddress } from "@/lib/email/sender";
import { getStoreBrand } from "@/lib/store/brand";

type Result = { error?: string; success?: boolean };

// Superadmin-only staff management. NOTE: these guards are intentionally NOT
// store-scoped — they mirror the original service-role queries, which operate
// on the admins table globally (last-superadmin protection, etc.). The caller's
// own role is read under their identity (RLS own-row); the target reads/writes
// run in the service scope.

async function requireSuperadminCaller(): Promise<
  { id: string } | { error: string }
> {
  const user = await getServerUser();
  if (!user) return { error: "Not authenticated" };
  try {
    const rows = await withUser({ uid: user.id, email: user.email }, (db) =>
      db
        .select({ role: admins.role })
        .from(admins)
        .where(eq(admins.id, user.id))
        .limit(1),
    );
    if (rows[0]?.role !== "superadmin") return { error: "Unauthorized" };
    return { id: user.id };
  } catch {
    return { error: "Unauthorized" };
  }
}

// Count of superadmins across the admins table (matches the original global
// guard — not store-scoped).
async function superadminCount(): Promise<number> {
  const rows = await withService((db) =>
    db.select({ n: count() }).from(admins).where(eq(admins.role, "superadmin")),
  );
  return rows[0]?.n ?? 0;
}

export async function deleteUser(userId: string): Promise<Result> {
  const gate = await requireSuperadminCaller();
  if ("error" in gate) return gate;

  if (userId === gate.id) {
    return { error: "You cannot delete your own account." };
  }

  // Don't allow deleting the last remaining superadmin (would lock everyone out).
  const targetRows = await withService((db) =>
    db
      .select({ role: admins.role })
      .from(admins)
      .where(eq(admins.id, userId))
      .limit(1),
  ).catch(() => []);

  if (targetRows[0]?.role === "superadmin") {
    if ((await superadminCount()) <= 1) {
      return { error: "Cannot delete the last superadmin." };
    }
  }

  // Delete the Cloud SQL profile row, then the Identity Platform account. The
  // old `auth.users` ON DELETE CASCADE is gone (auth + profile now live in
  // separate systems), so both must be removed explicitly.
  try {
    await withService((db) => db.delete(admins).where(eq(admins.id, userId)));
  } catch (err) {
    console.error("deleteUser profile delete error:", err);
    return { error: "Failed to delete user." };
  }
  try {
    await deleteAuthUser(userId);
  } catch (err) {
    console.error("deleteUser auth delete error:", err);
    return { error: "Failed to delete the user's login. Please try again." };
  }

  emitEvent({
    type: "admin.removed",
    storeId: await getActingStoreId(),
    actor: { type: "admin", id: gate.id },
    subject: { type: "admin", id: userId },
  });
  return { success: true };
}

export async function changeUserRole(
  userId: string,
  role: string,
): Promise<Result> {
  const gate = await requireSuperadminCaller();
  if ("error" in gate) return gate;

  // The target role must be a real, defined role. Fall back to the two
  // built-in roles when the roles table hasn't been seeded yet.
  const roleRows = await withService((db) =>
    db
      .select({ slug: roles.slug })
      .from(roles)
      .where(eq(roles.slug, role))
      .limit(1),
  ).catch(() => []);
  if (!roleRows[0] && !["superadmin", "member"].includes(role)) {
    return { error: "Invalid role" };
  }

  // Prevent demoting the last superadmin (e.g. yourself), which would leave
  // the dashboard with no one able to manage users.
  if (role !== "superadmin") {
    const targetRows = await withService((db) =>
      db
        .select({ role: admins.role })
        .from(admins)
        .where(eq(admins.id, userId))
        .limit(1),
    ).catch(() => []);

    if (targetRows[0]?.role === "superadmin") {
      if ((await superadminCount()) <= 1) {
        return { error: "Cannot demote the last superadmin." };
      }
    }
  }

  try {
    await withService((db) =>
      db.update(admins).set({ role }).where(eq(admins.id, userId)),
    );
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Failed to update." };
  }

  // Keep the auth token's role claim in sync (drives the proxy's fast-path
  // gating; reaches the user on their next token refresh). Best-effort — the
  // admins row is authoritative for actual permission checks.
  await setUserClaims(userId, { role }).catch((err) =>
    console.error("changeUserRole setUserClaims error:", err),
  );

  emitEvent({
    type: "admin.role_changed",
    storeId: await getActingStoreId(),
    actor: { type: "admin", id: gate.id },
    subject: { type: "admin", id: userId },
    payload: { role },
  });
  return { success: true };
}

export async function toggleUserSuspension(
  userId: string,
  isSuspended: boolean,
): Promise<Result> {
  const gate = await requireSuperadminCaller();
  if ("error" in gate) return gate;

  if (userId === gate.id && isSuspended) {
    return { error: "You cannot suspend your own account." };
  }

  try {
    await withService((db) =>
      db.update(admins).set({ isSuspended }).where(eq(admins.id, userId)),
    );
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Failed to update." };
  }

  return { success: true };
}

export async function changeOwnPassword(newPassword: string): Promise<Result> {
  if (!newPassword || newPassword.length < 8)
    return { error: "Password must be at least 8 characters" };

  const user = await getServerUser();
  if (!user) return { error: "Not authenticated." };

  try {
    await updateAuthUser(user.id, { password: newPassword });
  } catch (err) {
    console.error("changeOwnPassword error:", err);
    return { error: "Couldn't update your password. Please try again." };
  }
  return { success: true };
}

export async function triggerPasswordReset(email: string): Promise<Result> {
  // Generate an Identity Platform reset link and deliver it via our own email
  // transport (Resend), mirroring the old resetPasswordForEmail. Always report
  // success so the endpoint can't be used to enumerate which emails exist.
  const link = await generatePasswordResetLink(email.trim()).catch(() => null);
  if (!link) return { success: true };

  const resendApiKey = process.env.RESEND_API_KEY;
  if (resendApiKey && !resendApiKey.includes("placeholder")) {
    const brand = await getStoreBrand();
    // `password_reset` is a sensitive mailer: the log records the attempt but
    // not the body, because the reset link in it IS the credential.
    // ignoreSuppression — someone is waiting on this to get back into their
    // account, and a historic bounce shouldn't lock them out.
    await sendEmail({
      storeId: await getActingStoreId().catch(() => null),
      from: fromAddress(brand, { suffix: "Accounts" }),
      to: email,
      subject: `Reset your ${brand.name} password`,
      mailer: "password_reset",
      ignoreSuppression: true,
      html: wrapBrandedEmail(
        `
        <h2 style="margin-top: 0;">Reset your password</h2>
        <p>We received a request to reset your password. Click the button below
          to choose a new one. If you didn't ask for this, you can ignore this email.</p>
        <div style="text-align: center; margin: 32px 0;">
          <a href="${link}" style="display:inline-block;background:#000;color:#fff;text-decoration:none;padding:14px 28px;border-radius:6px;font-weight:600;">
            Reset Password
          </a>
        </div>
        <p style="font-size:13px;color:#666;">Or open this link: <br />${link}</p>
      `,
        brand,
      ),
    });
  } else {
    // Dev fallback: no email provider configured.
    console.log(`\n🔑 Password reset link for ${email}:\n${link}\n`);
  }

  return { success: true };
}
