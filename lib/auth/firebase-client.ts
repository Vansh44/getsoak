// Firebase Web SDK client wrapper (GCP migration Phase 6). The browser-side
// counterpart to the server session helpers: sign-in flows use the client SDK,
// then hand their fresh ID token to the server (POST /api/auth/session), which
// mints the httpOnly session cookie every request reads.
//
// Config is the standard public Firebase web config (NEXT_PUBLIC_FIREBASE_*).

import { initializeApp, getApps, getApp, type FirebaseApp } from "firebase/app";
import {
  getAuth,
  initializeAuth,
  inMemoryPersistence,
  type Auth,
} from "firebase/auth";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

let _app: FirebaseApp | undefined;

function getFirebaseApp(): FirebaseApp {
  if (_app) return _app;
  _app = getApps().length ? getApp() : initializeApp(firebaseConfig);
  return _app;
}

/** The client-side Firebase Auth instance (browser only). */
export function getFirebaseAuth(): Auth {
  return getAuth(getFirebaseApp());
}

const SECONDARY_APP = "sm-otp";

/**
 * An ISOLATED, non-persisting Auth instance on a secondary Firebase app — used
 * to verify a phone number (e.g. the enquiries form) WITHOUT logging the
 * visitor in or touching the main session. In-memory persistence means the
 * proof-of-ownership sign-in never lands in storage; sign it out after use.
 */
export function getSecondaryFirebaseAuth(): Auth {
  const existing = getApps().find((a) => a.name === SECONDARY_APP);
  if (existing) return getAuth(existing);
  const app = initializeApp(firebaseConfig, SECONDARY_APP);
  return initializeAuth(app, { persistence: inMemoryPersistence });
}

/**
 * Exchange the signed-in user's ID token for the server session cookie. Call
 * after any successful client sign-in / credential change. `forceRefresh` mints
 * a fresh token first — needed after a custom-claim change (e.g. clearing
 * force_password_reset) so the new claim rides in the cookie. Returns null on
 * success, or a user-facing error message.
 */
export async function establishSession(
  forceRefresh = false,
): Promise<string | null> {
  const user = getFirebaseAuth().currentUser;
  if (!user) return "You're not signed in. Please try again.";
  try {
    const idToken = await user.getIdToken(forceRefresh);
    const res = await fetch("/api/auth/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idToken }),
    });
    if (!res.ok) return "Could not establish a session. Please try again.";
    return null;
  } catch {
    return "Could not establish a session. Please try again.";
  }
}

/**
 * Map a Firebase Auth error to a user-facing message. Returns "" for
 * user-cancelled popups (nothing to show). Share across all sign-in flows.
 */
export function firebaseAuthErrorMessage(err: unknown): string {
  const code =
    err && typeof err === "object" && "code" in err
      ? String((err as { code?: unknown }).code)
      : "";
  switch (code) {
    case "auth/invalid-credential":
    case "auth/wrong-password":
    case "auth/user-not-found":
      return "Incorrect email or password.";
    case "auth/invalid-email":
      return "Please enter a valid email address.";
    case "auth/too-many-requests":
      return "Too many attempts. Please wait a moment and try again.";
    case "auth/user-disabled":
      return "This account has been disabled.";
    case "auth/email-already-in-use":
      return "An account with this email already exists.";
    case "auth/weak-password":
      return "Please choose a stronger password.";
    case "auth/invalid-verification-code":
      return "That code isn't right. Please check and try again.";
    // ── Phone auth ────────────────────────────────────────────────────────
    // Every one of these used to fall through to the generic message, so a
    // shopper who typed a number one digit short and a project that had run
    // out of SMS quota saw exactly the same "Something went wrong" — and no
    // way to tell which problem they had.
    case "auth/invalid-phone-number":
    case "auth/missing-phone-number":
      return "Please enter a valid mobile number, including the country code.";
    case "auth/quota-exceeded":
      return "We can't send codes right now. Please try again later or use email.";
    case "auth/captcha-check-failed":
    case "auth/missing-app-credential":
    case "auth/invalid-app-credential":
      return "The security check didn't complete. Please close this and try again.";
    case "auth/operation-not-allowed":
      return "Mobile sign-in isn't enabled for this store.";
    case "auth/session-expired":
      return "That code has expired. Please request a new one.";
    case "auth/code-expired":
      return "That code has expired. Please request a new one.";
    case "auth/account-exists-with-different-credential":
      return "An account already exists with a different sign-in method.";
    // ★ RAISED ONLY BY CREDENTIAL LINKING, so the message can name the cause
    // without knowing the caller. It had NO case at all, which meant the
    // single most likely way `updatePhoneNumber` fails — the number is on
    // somebody else's account — fell through to "Something went wrong".
    case "auth/credential-already-in-use":
      return "That's already linked to another account.";
    case "auth/popup-closed-by-user":
    case "auth/cancelled-popup-request":
      return ""; // user cancelled — nothing to surface
    default:
      return "Something went wrong. Please try again.";
  }
}

/**
 * The same mapper, for the two screens that LINK a phone to an existing
 * account (`updatePhoneNumber`): signup's phone step and set-password's.
 *
 * ★ THE SHARED MESSAGE IS WRONG IN THIS CONTEXT, WHICH IS WHY THIS EXISTS.
 * "An account already exists with a different sign-in method" is Google-popup
 * language — accurate on the login screen, meaningless under a box asking for
 * a mobile number, where it reads as though the EMAIL were the problem. Both
 * linking-conflict codes mean one thing here: the number is on somebody else's
 * account. Firebase raises `credential-already-in-use` for it, and
 * `account-exists-with-different-credential` when one-account-per-email is on,
 * so both are handled rather than guessing which.
 *
 * Everything else defers to `firebaseAuthErrorMessage`, so the phone-specific
 * codes it already knows about (invalid number, expired code, quota) keep their
 * wording and there is no second copy to drift.
 */
export function phoneLinkErrorMessage(err: unknown): string {
  const code =
    err && typeof err === "object" && "code" in err
      ? String((err as { code?: unknown }).code)
      : "";
  if (
    code === "auth/credential-already-in-use" ||
    code === "auth/account-exists-with-different-credential"
  ) {
    return "That mobile number is already linked to another StoreMink account. Use a different number, or log in to the account that has it.";
  }
  return firebaseAuthErrorMessage(err);
}

/** Sign out of both the client SDK and the server session cookie. */
export async function endSession(): Promise<void> {
  try {
    await getFirebaseAuth().signOut();
  } catch {
    // Ignore — we still clear the server cookie below.
  }
  try {
    await fetch("/api/auth/signout", { method: "POST" });
  } catch {
    // Best-effort; the client is already signed out locally.
  }
}
