// The single server-side identity seam (GCP migration — see
// docs/gcp-migration-phase5-6.md §5.3).
//
// WHY THIS EXISTS: Phase 5 moves the database to Cloud SQL, where tenant
// isolation is enforced by a per-request `SET LOCAL app.current_user_id = <uid>`
// (the 2A model). That wrapper needs ONE thing: a *verified* user id. It does
// not care whether the id came from Supabase or Google Identity Platform. So
// every server caller that needs "who is signed in" goes through THIS function
// instead of touching the auth provider directly — making the Phase 6 provider
// swap a one-file change.
//
// Phase 6: the identity source is now Identity Platform — this reads and
// verifies the Firebase SESSION COOKIE (`sm_session`, minted by the client auth
// flows via POST /api/auth/session). There is no Supabase fallback: the auth
// flows, proxy, and this seam cut over together, and the app requires Identity
// Platform to be provisioned + users imported to authenticate (mirrors how the
// data layer requires Cloud SQL).

import { cookies } from "next/headers";
import { SESSION_COOKIE, verifySessionCookie } from "./session-cookie";

export interface ServerUser {
  /** Stable user id — the value fed to `SET LOCAL app.current_user_id`. */
  id: string;
  /** Used by platform-admin checks (`auth.email()` → GUC in the RLS shim). */
  email: string | null;
  /** True after Google verification or the signup email OTP succeeds. */
  emailConfirmed: boolean;
  phone: string | null;
  /** True once the phone is OTP-verified (the signup wizard gates on this). */
  phoneConfirmed: boolean;
  /** OAuth/profile metadata (e.g. Google name prefill during signup). */
  metadata: Record<string, unknown>;
}

/**
 * The authenticated server-side user, or null when there is no valid session.
 * Validates the session with the auth server (not just a cookie read).
 */
export async function getServerUser(): Promise<ServerUser | null> {
  const session = (await cookies()).get(SESSION_COOKIE)?.value;
  const fb = await verifySessionCookie(session);
  if (!fb) return null;

  return {
    id: fb.uid,
    email: fb.email,
    emailConfirmed: fb.emailConfirmed,
    phone: fb.phone,
    phoneConfirmed: fb.phoneConfirmed,
    // Mirror the Supabase user_metadata name fields the signup wizard reads.
    metadata: fb.name ? { name: fb.name, full_name: fb.name } : {},
  };
}

/** Convenience: just the verified id (the common case for DB scoping). */
export async function getServerUserId(): Promise<string | null> {
  return (await getServerUser())?.id ?? null;
}
