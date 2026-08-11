// Firebase Admin user-management helpers (GCP migration Phase 6). Thin wrappers
// over the Admin SDK for the server-side auth admin ops that used to go through
// Supabase's `auth.admin.*` + `auth.updateUser` — create/delete/update an
// Identity Platform user, server-side password re-verification, and admin
// password-reset links.
//
// IMPORTANT — no cross-system cascade: with auth in Identity Platform and the
// profile rows (admins/users) in Cloud SQL, deleting an auth user does NOT
// remove its Cloud SQL row (the old `id REFERENCES auth.users ON DELETE CASCADE`
// is gone). Callers must delete BOTH explicitly.

import { getFirebaseAdminAuth } from "./firebase-admin";

/** The `auth/...` code of a thrown FirebaseAuthError, if any. */
export function authErrorCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

export interface CreateAuthUserInput {
  email?: string;
  phone?: string;
  password?: string;
  emailVerified?: boolean;
  displayName?: string;
}

/**
 * Create an Identity Platform user and return its uid. Throws when Identity
 * Platform isn't configured (a create must never silently no-op) or on a
 * duplicate (`auth/email-already-exists` / `auth/phone-number-already-exists`).
 */
export async function createAuthUser(
  input: CreateAuthUserInput,
): Promise<string> {
  const auth = getFirebaseAdminAuth();
  if (!auth) throw new Error("Identity Platform is not configured.");
  const rec = await auth.createUser({
    ...(input.email ? { email: input.email } : {}),
    ...(input.phone ? { phoneNumber: input.phone } : {}),
    ...(input.password ? { password: input.password } : {}),
    emailVerified: input.emailVerified ?? false,
    ...(input.displayName ? { displayName: input.displayName } : {}),
  });
  return rec.uid;
}

/**
 * Delete an Identity Platform user. Tolerates an already-deleted user
 * (`auth/user-not-found`) — the Cloud SQL row is the authoritative record and
 * may be removed independently. No-op when unconfigured.
 */
export async function deleteAuthUser(uid: string): Promise<void> {
  const auth = getFirebaseAdminAuth();
  if (!auth) return;
  try {
    await auth.deleteUser(uid);
  } catch (err) {
    if (authErrorCode(err) === "auth/user-not-found") return;
    throw err;
  }
}

/** Update an Identity Platform user's credentials/identity/enabled state. */
export async function updateAuthUser(
  uid: string,
  updates: {
    password?: string;
    email?: string;
    emailVerified?: boolean;
    phone?: string;
    disabled?: boolean;
  },
): Promise<void> {
  const auth = getFirebaseAdminAuth();
  if (!auth) throw new Error("Identity Platform is not configured.");
  await auth.updateUser(uid, {
    ...(updates.password !== undefined ? { password: updates.password } : {}),
    ...(updates.email !== undefined ? { email: updates.email } : {}),
    ...(updates.emailVerified !== undefined
      ? { emailVerified: updates.emailVerified }
      : {}),
    ...(updates.phone !== undefined ? { phoneNumber: updates.phone } : {}),
    ...(updates.disabled !== undefined ? { disabled: updates.disabled } : {}),
  });
}

/**
 * Resolve an email to its Identity Platform uid, creating the auth user if it
 * doesn't exist yet (email pre-verified — the caller has already proven control
 * of the address, e.g. via an emailed one-time code). Used by the operator
 * email-OTP login so an allowlisted operator can sign in even before a Firebase
 * user exists for their address.
 */
export async function getOrCreateAuthUserIdByEmail(
  email: string,
): Promise<string> {
  const auth = getFirebaseAdminAuth();
  if (!auth) throw new Error("Identity Platform is not configured.");
  try {
    const rec = await auth.getUserByEmail(email);
    return rec.uid;
  } catch (err) {
    if (authErrorCode(err) === "auth/user-not-found") {
      const rec = await auth.createUser({ email, emailVerified: true });
      return rec.uid;
    }
    throw err;
  }
}

/**
 * Mint a Firebase custom token for a uid. The client exchanges it via
 * `signInWithCustomToken` → ID token → the session-cookie bridge. On Cloud Run
 * the signing uses the runtime SA's self `serviceAccountTokenCreator` (IAM
 * signBlob) since ADC carries no private key.
 */
export async function createCustomAuthToken(
  uid: string,
  claims?: Record<string, unknown>,
): Promise<string> {
  const auth = getFirebaseAdminAuth();
  if (!auth) throw new Error("Identity Platform is not configured.");
  return auth.createCustomToken(uid, claims);
}

/**
 * Server-side re-verification of an email + password (firebase-admin can't check
 * a password). Calls the Identity Platform REST endpoint with the web API key;
 * returns true only on a valid credential. Used by "change password" reauth.
 */
export async function verifyPassword(
  email: string,
  password: string,
): Promise<boolean> {
  const apiKey =
    process.env.FIREBASE_API_KEY || process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
  if (!apiKey) return false;
  try {
    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password, returnSecureToken: false }),
      },
    );
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * An admin-triggered password-reset link (delivered via our own email
 * transport, like the Supabase resetPasswordForEmail flow). Null when Identity
 * Platform isn't configured or generation fails.
 */
export async function generatePasswordResetLink(
  email: string,
): Promise<string | null> {
  const auth = getFirebaseAdminAuth();
  if (!auth) return null;
  try {
    return await auth.generatePasswordResetLink(email);
  } catch (err) {
    console.error("generatePasswordResetLink:", err);
    return null;
  }
}
