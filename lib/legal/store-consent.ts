import "server-only";

// ---------------------------------------------------------------------------
// Recording a SHOPPER's agreement to a store's policies.
//
// Same rule as the merchant side (see store.ts): the client ticks a box, the
// SERVER decides what that means. It re-reads the store's live policy text,
// hashes it, and writes the row from the request's own IP and user agent. The
// client never says which policy or which wording it agreed to.
// ---------------------------------------------------------------------------

import { and, eq, inArray, sql } from "drizzle-orm";
import { headers } from "next/headers";
import { withService } from "@/lib/db/client";
import { legalAcceptances, storePages } from "@/drizzle/schema";
import { logError } from "@/lib/observability/logger";
import { checksumBody } from "./documents";
import {
  STORE_POLICIES,
  checkoutPolicies,
  type StorePolicyDef,
} from "./store-policies";
import { policyHasContent, policyBodyHtml } from "./policy-text";

export interface LivePolicy {
  slug: string;
  title: string;
  shortLabel: string;
  /** Published HTML — hashed, never sent to the client. */
  html: string;
}

/**
 * The store's PUBLISHED policies among the given kinds, in registry order.
 *
 * Only policies with actual content come back. A consent box that names a
 * policy the shopper can't read is worse than no box: it manufactures a record
 * of agreement to a blank page.
 */
export async function getLivePolicies(
  storeId: string,
  defs: StorePolicyDef[] = STORE_POLICIES,
): Promise<LivePolicy[]> {
  const slugs = defs.map((d) => d.slug);
  if (slugs.length === 0) return [];

  try {
    const rows = await withService((db) =>
      db
        .select({
          slug: storePages.slug,
          status: storePages.status,
          publishedSections: storePages.publishedSections,
        })
        .from(storePages)
        .where(
          and(eq(storePages.storeId, storeId), inArray(storePages.slug, slugs)),
        ),
    );

    const bySlug = new Map(rows.map((r) => [r.slug, r]));
    return defs.flatMap((def) => {
      const row = bySlug.get(def.slug);
      if (!row || row.status !== "published") return [];
      const html = policyBodyHtml(row.publishedSections);
      if (!policyHasContent(html)) return [];
      return [
        {
          slug: def.slug,
          title: def.title,
          shortLabel: def.shortLabel,
          html,
        },
      ];
    });
  } catch (error) {
    logError("legal: live policy read failed", error, { storeId });
    return [];
  }
}

/** The subset a checkout consent box covers (payment + refund terms). */
export function getCheckoutPolicies(storeId: string): Promise<LivePolicy[]> {
  return getLivePolicies(storeId, checkoutPolicies());
}

export interface StoreConsentInput {
  userId: string;
  email?: string | null;
  storeId: string;
  context: "signup" | "checkout";
  /** Defaults to every live policy; checkout passes the narrower set. */
  policies?: LivePolicy[];
}

/**
 * Record that a shopper accepted this store's policies as they read RIGHT NOW.
 *
 * Best-effort, exactly like the merchant path: a failed consent write must
 * never take down a signup or a checkout. A shopper stranded mid-order because
 * an audit row didn't insert is a worse outcome than a missing audit row, and
 * the failure is logged either way.
 *
 * Re-accepting a REWORDED policy updates the checksum rather than inserting a
 * second row — the question this table answers for store policies is "what do
 * they currently stand agreed to?", not "how many times did they tick a box?".
 */
export async function recordStorePolicyConsent(
  input: StoreConsentInput,
): Promise<void> {
  const policies = input.policies ?? (await getLivePolicies(input.storeId));
  if (policies.length === 0) return; // nothing published to agree to

  let ip: string | null = null;
  let userAgent: string | null = null;
  try {
    const h = await headers();
    ip =
      h.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      h.get("x-real-ip") ||
      null;
    userAgent = h.get("user-agent");
  } catch {
    // No request scope. The row is still worth writing.
  }

  try {
    const rows = await Promise.all(
      policies.map(async (policy) => ({
        documentId: null,
        kind: policy.slug,
        // Store policies aren't versioned — the checksum is the identity of
        // the text. 0 keeps the NOT NULL column honest without implying a
        // version number that doesn't exist.
        version: 0,
        userId: input.userId,
        email: input.email?.slice(0, 320) ?? null,
        actorType: "customer" as const,
        storeId: input.storeId,
        context: input.context,
        policySlug: policy.slug,
        policyChecksum: await checksumBody(policy.html),
        ip: ip?.slice(0, 60) ?? null,
        userAgent: userAgent?.slice(0, 400) ?? null,
      })),
    );

    await withService((db) =>
      db
        .insert(legalAcceptances)
        .values(rows)
        .onConflictDoUpdate({
          target: [
            legalAcceptances.userId,
            legalAcceptances.storeId,
            legalAcceptances.policySlug,
          ],
          set: {
            policyChecksum: sql`excluded.policy_checksum`,
            context: sql`excluded.context`,
            ip: sql`excluded.ip`,
            userAgent: sql`excluded.user_agent`,
            acceptedAt: new Date().toISOString(),
          },
        }),
    );
  } catch (error) {
    logError("legal: store consent write failed", error, {
      userId: input.userId,
      storeId: input.storeId,
    });
  }
}
