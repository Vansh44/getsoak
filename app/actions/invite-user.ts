"use server";

import { eq } from "drizzle-orm";
import { getServerUser } from "@/lib/auth/server-user";
import {
  createAuthUser,
  deleteAuthUser,
  authErrorCode,
} from "@/lib/auth/firebase-users";
import { setUserClaims } from "@/lib/auth/firebase-claims";
import { withService, withUser } from "@/lib/db/client";
import { admins } from "@/drizzle/schema";
import { Resend } from "resend";
import { wrapBrandedEmail } from "@/lib/email/layout";
import { getStoreBrandById } from "@/lib/store/brand";
import { fromAddress } from "@/lib/email/sender";
import { PLATFORM_URL } from "@/lib/site";
import { getRequestOrigin } from "@/lib/request-url";
import { randomInt } from "crypto";

function generateTempPassword(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%&*";
  let password = "";
  for (let i = 0; i < 16; i++) {
    // randomInt is cryptographically secure (unlike Math.random).
    password += chars.charAt(randomInt(chars.length));
  }
  return password;
}

/** Escape user-supplied values before interpolating into email HTML. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function inviteUser(formData: FormData) {
  const firstName = formData.get("firstName") as string;
  const lastName = (formData.get("lastName") as string) || null;
  const email = formData.get("email") as string;
  const role = formData.get("role") as string;

  if (!firstName || !firstName.trim()) {
    return { error: "First name is required." };
  }

  if (!email || !email.includes("@")) {
    return { error: "Please provide a valid email address." };
  }

  if (!role || !["superadmin", "member"].includes(role)) {
    return { error: "Invalid role." };
  }

  // Verify the caller is a superadmin (own-row read under their identity).
  const caller = await getServerUser();
  if (!caller) {
    return { error: "Not authenticated." };
  }

  const callerRows = await withUser(
    { uid: caller.id, email: caller.email },
    (db) =>
      db
        .select({ role: admins.role, store_id: admins.storeId })
        .from(admins)
        .where(eq(admins.id, caller.id))
        .limit(1),
  ).catch(() => []);
  const callerProfile = callerRows[0];

  if (callerProfile?.role !== "superadmin") {
    return { error: "Unauthorized. Superadmin access required." };
  }

  // The invited admin joins the inviter's store.
  const storeId = callerProfile.store_id;

  const tempPassword = generateTempPassword();

  // Reject emails already attached to a dashboard profile. Identity Platform
  // blocks duplicate auth emails, but an auth account created without an email
  // (e.g. phone sign-up) can still collide at the profile layer. Exact match on
  // the already-lowercased email (not ILIKE, whose _/% wildcards would let a
  // crafted invite address collide with an unrelated admin).
  const normalizedEmail = email.trim().toLowerCase();
  const existingRows = await withService((db) =>
    db
      .select({ id: admins.id })
      .from(admins)
      .where(eq(admins.email, normalizedEmail))
      .limit(1),
  ).catch(() => []);

  if (existingRows[0]) {
    return { error: "A user with this email already exists." };
  }

  // Create the Identity Platform user.
  let uid: string;
  try {
    uid = await createAuthUser({
      email,
      password: tempPassword,
      emailVerified: true,
    });
  } catch (err) {
    if (authErrorCode(err) === "auth/email-already-exists") {
      return { error: "A user with this email already exists." };
    }
    console.error("inviteUser createUser error:", err);
    return { error: "Failed to create user." };
  }

  // Insert the profile (upsert on the primary key so a leftover row is reused).
  const profileFields = {
    email: normalizedEmail,
    firstName: firstName.trim(),
    lastName: lastName?.trim() || null,
    role,
    forcePasswordReset: true,
    invitedBy: caller.id,
    storeId,
  };
  try {
    await withService((db) =>
      db
        .insert(admins)
        .values({ id: uid, ...profileFields })
        .onConflictDoUpdate({ target: admins.id, set: profileFields }),
    );
  } catch (err) {
    console.error("inviteUser profile insert error:", err);
    // Cleanup: delete the auth user so no orphan account is left behind.
    await deleteAuthUser(uid);
    return { error: "Failed to create user profile." };
  }

  // Mirror role + force_password_reset into the auth token as custom claims so
  // the proxy can gate the new admin's first login (replaces the Postgres
  // custom_access_token_hook). Best-effort: the admins row is authoritative for
  // permission checks, so a claim hiccup only softens the proxy's fast-path.
  await setUserClaims(uid, { role, forcePasswordReset: true }).catch((err) =>
    console.error("inviteUser setUserClaims error:", err),
  );

  // Send email via Resend
  const resendApiKey = process.env.RESEND_API_KEY;
  const isResendAvailable =
    resendApiKey && !resendApiKey.includes("placeholder");

  if (isResendAvailable) {
    try {
      const brand = await getStoreBrandById(storeId);
      // The invited admin belongs to the INVITER's store, and the inviter is on
      // that store's host — so the request origin sends them to their own store
      // dashboard ({slug}.storemink.com/dashboard) and is clickable in local dev.
      // PLATFORM_URL (the apex) would land them on the platform operator console
      // instead, and points at an unreachable host when developing locally.
      const appUrl = (await getRequestOrigin()) ?? PLATFORM_URL;

      const resend = new Resend(resendApiKey);
      await resend.emails.send({
        // From/Subject are mail headers, NOT HTML — build the From with the
        // RFC-5322-safe helper and leave the brand name unescaped in both.
        from: fromAddress(brand, { suffix: "Dashboard" }),
        to: email,
        subject: `Welcome to ${brand.name} Dashboard`,
        html: wrapBrandedEmail(
          `
        <h2 style="margin-top: 0;">You've Been Invited 🎉</h2>

        <p>Hello ${escapeHtml(firstName)}${lastName ? " " + escapeHtml(lastName) : ""},</p>

        <p>
          You have been invited to join the <strong>${escapeHtml(brand.name)} Admin Dashboard</strong>
          as a <strong>${escapeHtml(role)}</strong>.
        </p>

        <div
          style="
            background: #f8f8f8;
            border: 1px solid #e5e5e5;
            border-radius: 8px;
            padding: 20px;
            margin: 24px 0;
          "
        >
          <h3 style="margin-top: 0;">Temporary Login Credentials</h3>

          <p style="margin: 8px 0;">
            <strong>Email:</strong> ${escapeHtml(email)}
          </p>

          <p style="margin: 8px 0;">
            <strong>Password:</strong>
            <span
              style="
                font-family: monospace;
                background: #fff;
                padding: 4px 8px;
                border-radius: 4px;
                border: 1px solid #ddd;
              "
            >
              ${tempPassword}
            </span>
          </p>
        </div>

        <div style="text-align: center; margin: 32px 0;">
          <a
            href="${appUrl}/dashboard"
            style="
              display: inline-block;
              background: #000;
              color: #fff;
              text-decoration: none;
              padding: 14px 28px;
              border-radius: 6px;
              font-weight: 600;
            "
          >
            Sign In to Dashboard
          </a>
        </div>

        <p>
          You'll be prompted to set a new password when you sign in for the first time.
        </p>

        <p>
          Regards,<br />
          <strong>Team ${escapeHtml(brand.name)}</strong>
        </p>
      `,
          brand,
        ),
      });
    } catch (e) {
      console.error("Failed to send invite email via Resend:", e);
    }
  }

  // Dev fallback only: if no email provider is configured there is no other
  // way to deliver the credential, so print it. Never log the password when an
  // email was actually sent (avoids plaintext credentials in production logs).
  if (!isResendAvailable) {
    console.log("\n" + "=".repeat(60));
    console.log("📨 USER INVITED (email not configured — dev fallback)");
    console.log(`Email: ${email}`);
    console.log(`Role: ${role}`);
    console.log(`Temporary Password: ${tempPassword}`);
    console.log("=".repeat(60) + "\n");
  }

  return { success: true };
}
