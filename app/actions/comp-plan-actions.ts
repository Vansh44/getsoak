"use server";

/**
 * Comped plans — a free, time-boxed upgrade layered OVER whatever the store is
 * already paying for. Design and the decisions behind it:
 * docs/comped-plans-spec.md.
 *
 * ★★ NOTHING HERE TOUCHES BILLING. No cycle is started, no invoice is raised
 * and `plan` / `plan_source` / `plan_expires_at` are never written. A comp lives
 * entirely in its own columns and is resolved on top of the paid entitlement by
 * `effectivePlan`, which is what makes its expiry free: when the window closes
 * there is nothing to put back, because nothing was taken away.
 *
 * The operator sets the DURATION; the merchant's acceptance sets the WINDOW.
 * That split is why the merchant's click exists at all — without it a free
 * month would burn down from the grant date whether or not they ever saw it.
 */

import { and, eq, isNull, isNotNull, sql } from "drizzle-orm";
import { updateTag } from "next/cache";
import { withService } from "@/lib/db/client";
import { planEvents, stores } from "@/drizzle/schema";
import { getPlatformViewer } from "./platform";
import { getManagerIdentity } from "@/app/dashboard/lib/access";
import { getCurrentStoreId } from "@/lib/store/resolve";
import { STORE_TAG } from "@/lib/store/resolve";
import { logError } from "@/lib/observability/logger";
import { PLAN_META, normalizePlan, type Plan } from "@/lib/plans";

export interface CompResult {
  success?: boolean;
  error?: string;
  /** Set on a successful activation, for the confirmation copy. */
  plan?: Plan;
  expiresAt?: string;
}

/** Comps are an UPGRADE. 'free' is not a gift and the resolver ranks it below
 *  every paid plan, so it could only ever be a typo that looks like intent. */
const COMPABLE_PLANS: readonly Plan[] = ["basic", "pro"];
const MAX_DURATION_DAYS = 365;

/**
 * Operator: offer a store a free plan for N days. Does NOT start the clock.
 *
 * ★ Superadmin only, matching `setStorePlan` — giving away a paid plan is the
 * same authority as setting one.
 */
export async function offerCompPlan(
  storeId: string,
  input: { plan: string; durationDays: number; note?: string },
): Promise<CompResult> {
  const viewer = await getPlatformViewer();
  if (viewer?.role !== "superadmin") {
    return { error: "Only a platform superadmin can offer a comped plan." };
  }

  const plan = normalizePlan(input.plan);
  if (!COMPABLE_PLANS.includes(plan)) {
    return { error: "Choose Basic or Pro." };
  }
  const days = Number(input.durationDays);
  if (!Number.isInteger(days) || days < 1 || days > MAX_DURATION_DAYS) {
    return { error: `Choose between 1 and ${MAX_DURATION_DAYS} days.` };
  }

  // ★ An ACTIVE comp is not replaced behind the merchant's back. A new offer
  // may sit alongside it and takes effect only when they accept (spec §12.5),
  // so the write refuses a row whose window is already open.
  let claimed: { id: string }[];
  try {
    claimed = await withService((db) =>
      db
        .update(stores)
        .set({
          compPlan: plan,
          compDurationDays: days,
          compOfferedAt: sql`now()`,
        })
        .where(and(eq(stores.id, storeId), isNull(stores.compStartsAt)))
        .returning({ id: stores.id }),
    );
  } catch (err) {
    logError("comp.offer", err, { storeId });
    return { error: "Could not save the offer. Please try again." };
  }

  if (claimed.length === 0) {
    return {
      error:
        "That store already has a comped plan running. Wait for it to end before offering another.",
    };
  }

  // ⚠ Its OWN transaction. An audit failure must never roll back the grant —
  // and `plan_events.source` is 'operator' | 'billing' | 'system', NOT the
  // 'comp' | 'paid' | 'trial' of stores.plan_source (CODEBASE.md §15).
  try {
    await withService((db) =>
      db.insert(planEvents).values({
        storeId,
        fromPlan: null,
        toPlan: plan,
        source: "operator",
        actor: viewer.email ?? null,
        note:
          input.note?.trim() ||
          `Offered ${PLAN_META[plan].name} free for ${days} days`,
      }),
    );
  } catch (err) {
    logError("comp.offer_audit", err, { storeId });
  }

  updateTag(STORE_TAG);
  return { success: true, plan };
}

/** Operator: withdraw an offer the merchant has not accepted yet. */
export async function withdrawCompOffer(storeId: string): Promise<CompResult> {
  const viewer = await getPlatformViewer();
  if (viewer?.role !== "superadmin") {
    return { error: "Only a platform superadmin can withdraw a comped plan." };
  }
  let claimed: { id: string }[];
  try {
    claimed = await withService((db) =>
      db
        .update(stores)
        .set({ compPlan: null, compDurationDays: null, compOfferedAt: null })
        // ★ Only an UNACCEPTED offer. Once the window is open the comp runs to
        // its end — there is no mid-window revocation (spec §12.3).
        .where(
          and(
            eq(stores.id, storeId),
            isNull(stores.compStartsAt),
            isNotNull(stores.compPlan),
          ),
        )
        .returning({ id: stores.id }),
    );
  } catch (err) {
    logError("comp.withdraw", err, { storeId });
    return { error: "Could not withdraw the offer. Please try again." };
  }
  if (claimed.length === 0) {
    return { error: "There is no pending offer to withdraw." };
  }
  updateTag(STORE_TAG);
  return { success: true };
}

/**
 * Merchant: accept the offer their operator left them.
 *
 * ★★ TAKES NO ARGUMENTS, AND THAT IS THE SECURITY BOUNDARY. The plan, the
 * duration and both timestamps come from the stored grant or the database
 * clock. An action shaped `activateComp(plan)` would let a merchant post "pro"
 * and grant it to themselves — the same rule `confirmLocationPurchase` follows
 * by reading its count from the invoice rather than the request.
 */
export async function activateCompPlan(): Promise<CompResult> {
  const storeId = await getCurrentStoreId();
  // Plans & Billing is gated on the `ai` section; accepting a plan change is a
  // manage action on it.
  const identity = await getManagerIdentity("ai");
  if (!identity) {
    return { error: "You don't have permission to change this store's plan." };
  }

  let claimed: { plan: string | null; expiresAt: string | null }[];
  try {
    claimed = await withService((db) =>
      db
        .update(stores)
        .set({
          // ★ The DATABASE clock, not the container's — the rule placeOrder
          // follows for pickup_expires_at.
          compStartsAt: sql`now()`,
          compExpiresAt: sql`now() + make_interval(days => ${stores.compDurationDays})`,
        })
        // ★★ ONE CONDITIONAL CLAIM. It re-reads the grant inside the write, so
        // an offer withdrawn since the page rendered cannot be accepted, and a
        // double-click claims zero rows rather than opening a second window.
        .where(
          and(
            eq(stores.id, storeId),
            isNotNull(stores.compPlan),
            isNotNull(stores.compDurationDays),
            isNull(stores.compStartsAt),
          ),
        )
        .returning({
          plan: stores.compPlan,
          expiresAt: stores.compExpiresAt,
        }),
    );
  } catch (err) {
    logError("comp.activate", err, { storeId });
    return { error: "Could not start your free upgrade. Please try again." };
  }

  const row = claimed[0];
  if (!row) {
    return {
      error:
        "That offer is no longer available. Refresh the page to see your current plan.",
    };
  }

  try {
    await withService((db) =>
      db.insert(planEvents).values({
        storeId,
        fromPlan: null,
        toPlan: normalizePlan(row.plan),
        source: "operator",
        actor: identity.email ?? identity.uid,
        note: "Merchant accepted the comped plan",
      }),
    );
  } catch (err) {
    logError("comp.activate_audit", err, { storeId });
  }

  // ★ Read-your-own-writes: the merchant is about to be shown their new plan,
  // and the store row is cached for 300 s (the signup rule, CODEBASE.md §3).
  updateTag(STORE_TAG);
  return {
    success: true,
    plan: normalizePlan(row.plan),
    expiresAt: row.expiresAt ?? undefined,
  };
}
