// Firebase custom-claims helpers (GCP migration Phase 6). Replace the former
// Supabase Postgres `custom_access_token_hook` (dropped in
// supabase/phase6_03_drop_custom_access_token_hook.sql): `role` and
// `force_password_reset` become Firebase custom claims that ride in the ID token
// → session cookie, so the proxy can authorize dashboard routes with no DB read.
//
// Set them on: invite (role + force_password_reset=true), role change (role),
// and password-set (clear force_password_reset). A claim change reaches the
// browser on the next ID-token refresh; force one (getIdToken(true)) + re-mint
// the session cookie when a flip must take effect immediately (set-password).

import { getFirebaseAdminAuth } from "./firebase-admin";
import type { SessionClaims } from "./session-cookie";

/**
 * Merge the given claim fields into a user's Firebase custom claims (leaving any
 * unspecified claim untouched). No-op when Identity Platform isn't configured.
 * The stored keys (`role`, `force_password_reset`) match what verifySessionCookie
 * reads back.
 */
export async function setUserClaims(
  uid: string,
  updates: Partial<SessionClaims>,
): Promise<void> {
  const auth = getFirebaseAdminAuth();
  if (!auth) return;

  const user = await auth.getUser(uid);
  const next: Record<string, unknown> = { ...(user.customClaims ?? {}) };
  if (updates.role !== undefined) next.role = updates.role;
  if (updates.forcePasswordReset !== undefined) {
    next.force_password_reset = updates.forcePasswordReset;
  }
  await auth.setCustomUserClaims(uid, next);
}
