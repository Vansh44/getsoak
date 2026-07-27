"use server";

import { eq } from "drizzle-orm";
import { getServerUser } from "@/lib/auth/server-user";
import { emitEvent } from "@/lib/notifications/record";
import { getActingStoreId } from "@/app/dashboard/lib/access";
import { verifyPassword, updateAuthUser } from "@/lib/auth/firebase-users";
import { withUser } from "@/lib/db/client";
import { admins } from "@/drizzle/schema";

type Result = { error?: string; success?: boolean };

/** Update the signed-in admin's display name on their own profile row. */
export async function updateProfileName(formData: FormData): Promise<Result> {
  const firstName = ((formData.get("firstName") as string) || "").trim();
  const lastName = ((formData.get("lastName") as string) || "").trim();

  if (!firstName) {
    return { error: "First name is required." };
  }

  const user = await getServerUser();
  if (!user) return { error: "Not authenticated." };

  try {
    // Own-row update (admins RLS lets a user edit their own row).
    await withUser({ uid: user.id, email: user.email }, (db) =>
      db
        .update(admins)
        .set({ firstName, lastName: lastName || null })
        .where(eq(admins.id, user.id)),
    );
  } catch (err) {
    console.error("Failed to update profile name:", err);
    return { error: "Couldn't save your name. Please try again." };
  }

  return { success: true };
}

/**
 * Change the signed-in admin's password. The current password is re-verified
 * first (via the Identity Platform REST sign-in — firebase-admin can't check a
 * password), like Notion/Linear do, then updated with the Admin SDK.
 */
export async function changePassword(formData: FormData): Promise<Result> {
  const currentPassword = (formData.get("currentPassword") as string) || "";
  const newPassword = (formData.get("newPassword") as string) || "";
  const confirmPassword = (formData.get("confirmPassword") as string) || "";

  if (!currentPassword) {
    return { error: "Enter your current password." };
  }
  if (newPassword.length < 8) {
    return { error: "New password must be at least 8 characters." };
  }
  if (newPassword !== confirmPassword) {
    return { error: "New passwords do not match." };
  }
  if (newPassword === currentPassword) {
    return { error: "New password must be different from the current one." };
  }

  const user = await getServerUser();
  if (!user?.email) return { error: "Not authenticated." };

  // Re-verify the current password before allowing the change.
  const ok = await verifyPassword(user.email, currentPassword);
  if (!ok) {
    return { error: "Your current password is incorrect." };
  }

  try {
    await updateAuthUser(user.id, { password: newPassword });
  } catch (err) {
    console.error("changePassword error:", err);
    return { error: "Couldn't update your password." };
  }

  emitEvent({
    type: "security.password_changed",
    storeId: await getActingStoreId(),
    actor: { type: "admin", id: user.id, label: user.email },
    subject: { type: "admin", id: user.id, label: user.email },
  });

  return { success: true };
}

/**
 * Persist a phone number to the profile after it has been OTP-verified on the
 * client (Firebase `updatePhoneNumber`, which sets the user's phone_number and
 * is reflected in the re-minted session cookie). We only accept the number auth
 * has actually recorded as verified.
 */
export async function setVerifiedPhone(phone: string): Promise<Result> {
  const user = await getServerUser();
  if (!user) return { error: "Not authenticated." };

  const normalized = phone.trim();
  // Identity Platform stores E.164 (with a leading "+"); getServerUser reports
  // the verified phone as-is, so it must match exactly.
  if (!user.phone || user.phone !== normalized) {
    return { error: "Phone number hasn't been verified yet." };
  }

  try {
    await withUser({ uid: user.id, email: user.email }, (db) =>
      db
        .update(admins)
        .set({ phone: normalized })
        .where(eq(admins.id, user.id)),
    );
  } catch (err) {
    console.error("Failed to save verified phone:", err);
    return { error: "Couldn't save your phone number. Please try again." };
  }

  return { success: true };
}
