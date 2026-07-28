"use server";

// ---------------------------------------------------------------------------
// Consent capture.
//
// The client ticks a box; THIS decides what that means. The action re-reads the
// documents currently in force and writes one acceptance row per document,
// stamped with the request's own IP and user agent. The client never tells us
// which version it agreed to — it couldn't be trusted to, and it doesn't need
// to know.
// ---------------------------------------------------------------------------

import { eq } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { admins } from "@/drizzle/schema";
import { getServerUser } from "@/lib/auth/server-user";
import { logError } from "@/lib/observability/logger";
import {
  recordSignupConsent,
  getSignupDocs,
  outstandingDocs,
} from "@/lib/legal/store";

export interface ConsentResult {
  success?: boolean;
  error?: string;
}

/**
 * Record that the signed-in person accepted StoreMink's current policies.
 *
 * Called straight after the account is created (both the password and the
 * Google path), once a session cookie exists — `getServerUser()` is what makes
 * this an observation rather than a claim.
 *
 * Idempotent: the (user_id, document_id) unique index means a retry, a double
 * click, or a resumed wizard writes nothing new.
 */
export async function acceptPlatformPolicies(input: {
  marketingOptIn?: boolean;
}): Promise<ConsentResult> {
  const user = await getServerUser();
  // Not signed in = no identity to attach the consent to. This is a real
  // failure, not something to swallow: it means the caller ran too early.
  if (!user) return { error: "Not signed in." };

  await recordSignupConsent({
    userId: user.id,
    email: user.email ?? null,
    actorType: "merchant",
    context: "signup",
  });

  // The optional box. Deliberately a separate write to a separate column —
  // agreeing to the Terms is a contract, wanting product email is a preference,
  // and conflating them is what makes a consent record arguable later.
  if (input.marketingOptIn) {
    try {
      await withService((db) =>
        db
          .update(admins)
          .set({ marketingOptIn: true })
          .where(eq(admins.id, user.id)),
      );
    } catch (error) {
      // Never fail signup over a mailing preference.
      logError("legal: marketing opt-in write failed", error, {
        userId: user.id,
      });
    }
  }

  return { success: true };
}

/**
 * Accept an UPDATED policy — the re-acceptance gate's submit.
 *
 * Same write as signup, different `context`, so a report can tell "agreed when
 * they joined" from "agreed when v2 came out". Deliberately re-checks
 * `outstandingDocs` rather than trusting that the gate sent them here: this is
 * a server action, reachable directly, and the whole design rule is that the
 * server decides what a click means.
 */
export async function acceptUpdatedPolicies(): Promise<ConsentResult> {
  const user = await getServerUser();
  if (!user) return { error: "Not signed in." };

  const outstanding = await outstandingDocs(user.id);
  if (outstanding.length === 0) {
    // Already up to date — a double submit, or a stale tab. Not an error;
    // the caller just wants to know it can move on.
    return { success: true };
  }

  await recordSignupConsent({
    userId: user.id,
    email: user.email ?? null,
    actorType: "merchant",
    context: "reaccept",
  });

  // Verify rather than assume. recordSignupConsent swallows its errors by
  // design (a failed write must not strand someone mid-signup), so without
  // this check a failure here would bounce the merchant straight back to the
  // gate with no explanation.
  const stillOutstanding = await outstandingDocs(user.id);
  if (stillOutstanding.length > 0) {
    logError("legal: re-acceptance did not stick", null, { userId: user.id });
    return { error: "We couldn't record that. Please try again." };
  }

  return { success: true };
}

/**
 * The documents a new account must agree to, for the signup UI to name and
 * link. Public: it runs before anyone has an account.
 *
 * Returns titles and slugs only — the consent sentence needs to say exactly
 * WHICH documents are being accepted, but the wizard has no use for the bodies.
 */
export async function getConsentDocuments(): Promise<
  { kind: string; title: string; version: number }[]
> {
  const docs = await getSignupDocs();
  return docs.map((d) => ({
    kind: d.kind,
    title: d.title,
    version: d.version,
  }));
}
