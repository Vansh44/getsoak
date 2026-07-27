import "server-only";

// ---------------------------------------------------------------------------
// The email suppression list — see supabase/notifications_05_suppressions.sql.
//
// Resend accepting a message is not delivery. Before this existed, an address
// that hard-bounced was re-mailed on every future notification forever: the
// send "succeeded", the queue row was marked sent, and the mail landed nowhere.
// Because every store shares one verified sending domain by default, those
// bounces were also spending the PLATFORM's deliverability, not just one
// store's — which is why the list is global.
//
// ONLY PERMANENT SIGNALS BELONG HERE. A full mailbox or a greylisting server is
// a soft bounce: it fixes itself, and the queue's own retry/backoff covers it.
// Suppressing on one would quietly cut a real customer off from their order
// confirmations for good.
// ---------------------------------------------------------------------------

import { inArray, sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { emailSuppressions } from "@/drizzle/schema";
import { logError } from "@/lib/observability/logger";

export type SuppressionReason = "bounce" | "complaint" | "manual";

/** One mailbox per row, so casing must never create a second one. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Add (or refresh) a suppression. Idempotent: a repeat bounce bumps
 * `last_event_at` rather than erroring, so an actively-failing address is
 * distinguishable from one suppressed a year ago.
 */
export async function suppressEmail(input: {
  email: string;
  reason: SuppressionReason;
  detail?: string | null;
  source?: string;
}): Promise<boolean> {
  const email = normalizeEmail(input.email);
  if (!email) return false;
  try {
    await withService((db) =>
      db
        .insert(emailSuppressions)
        .values({
          email,
          reason: input.reason,
          detail: input.detail?.slice(0, 500) ?? null,
          source: input.source ?? "resend",
        })
        .onConflictDoUpdate({
          target: emailSuppressions.email,
          set: {
            reason: input.reason,
            detail: input.detail?.slice(0, 500) ?? null,
            lastEventAt: sql`NOW()`,
          },
        }),
    );
    return true;
  } catch (error) {
    logError("suppression: write failed", error, { email });
    return false;
  }
}

/**
 * Which of these addresses must not be mailed. Returns a Set of the normalised
 * suppressed addresses — one query per worker run, not one per recipient.
 *
 * FAILS OPEN. If the lookup errors we return an empty set and the mail goes
 * out: a database hiccup must not silently stop a store's order confirmations.
 * The cost of a wrong send is one bounce; the cost of a wrong block is a
 * customer who never hears from the shop.
 */
export async function findSuppressed(emails: string[]): Promise<Set<string>> {
  const unique = [...new Set(emails.map(normalizeEmail).filter(Boolean))];
  if (unique.length === 0) return new Set();
  try {
    const rows = await withService((db) =>
      db
        .select({ email: emailSuppressions.email })
        .from(emailSuppressions)
        .where(inArray(emailSuppressions.email, unique)),
    );
    return new Set(rows.map((r) => r.email));
  } catch (error) {
    logError("suppression: lookup failed, allowing send", error);
    return new Set();
  }
}

/** Remove a suppression — an operator judging an address good again. */
export async function unsuppressEmail(email: string): Promise<boolean> {
  const clean = normalizeEmail(email);
  if (!clean) return false;
  try {
    await withService((db) =>
      db
        .delete(emailSuppressions)
        .where(inArray(emailSuppressions.email, [clean])),
    );
    return true;
  } catch (error) {
    logError("suppression: delete failed", error, { email: clean });
    return false;
  }
}
