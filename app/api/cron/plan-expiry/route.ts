import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { and, gt, inArray, lte, ne, sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { planEvents, stores } from "@/drizzle/schema";
import { STORE_TAG } from "@/lib/store/resolve";
import { recordEvent } from "@/lib/notifications/record";
import {
  PLAN_META,
  normalizePlan,
  EXPIRY_WARN_DAYS,
  expiryWarnWindow,
} from "@/lib/plans";
import {
  resolveBillingEmail,
  sendBillingEmail,
  manageUrl,
  planDowngradedTemplate,
} from "@/lib/email/billing-emails";

// Durably flips expired timed plans to free (see lib/plans.ts effectivePlan —
// the read-time guard already treats them as free the moment they lapse; this
// job makes the row itself honest and writes the audit trail). Driven by
// Vercel Cron daily (vercel.json).
//
// Auth: requires `Authorization: Bearer <CRON_SECRET>`. Vercel Cron is
// configured to send this header. Set CRON_SECRET in the environment.

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

async function handle(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const nowIso = new Date().toISOString();

  // ★★ THE COMP SWEEP IS A SEPARATE PASS OVER DISJOINT COLUMNS, and it must
  // never touch `plan` / `plan_expires_at`. Clearing the overlay IS the whole
  // operation: the paid entitlement underneath was never modified, so the store
  // falls back to it automatically (docs/comped-plans-spec.md §8.3).
  //
  // Run FIRST so a store losing both in the same tick is audited falling from
  // the plan it was actually on.
  const compsEnded = await endLapsedComps(nowIso);

  let lapsed: { id: string; plan: string }[];
  let flippedIds: Set<string>;
  try {
    ({ lapsed, flippedIds } = await withService(async (db) => {
      // Snapshot the lapsed stores first — the UPDATE returns new values, and
      // the audit rows need the plan each store is falling FROM.
      const lapsed = await db
        .select({ id: stores.id, plan: stores.plan })
        .from(stores)
        .where(and(ne(stores.plan, "free"), lte(stores.planExpiresAt, nowIso)));
      if (lapsed.length === 0) {
        return { lapsed, flippedIds: new Set<string>() };
      }

      // Re-check the expiry inside the UPDATE so a store whose plan was extended
      // between the snapshot and now is left alone; .returning() gives only the
      // rows actually flipped, which is what gets audited.
      const flipped = await db
        .update(stores)
        .set({ plan: "free", planExpiresAt: null })
        .where(
          and(
            inArray(
              stores.id,
              lapsed.map((s) => s.id),
            ),
            ne(stores.plan, "free"),
            lte(stores.planExpiresAt, nowIso),
          ),
        )
        .returning({ id: stores.id });
      return { lapsed, flippedIds: new Set(flipped.map((s) => s.id)) };
    }));
  } catch (err) {
    console.error(
      "plan-expiry (read/update):",
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json({ error: "update failed" }, { status: 500 });
  }

  if (!lapsed.length) {
    // ⚠ Warnings are deliberately NOT sent here. That is a pre-existing defect
    // (pinned by "does NOT warn anyone on a day when no plan lapsed"), left
    // exactly as it was: fixing it as a side effect of the comp sweep would
    // change who gets emailed, which is not this change's business.
    return NextResponse.json({ ok: true, expired: 0, compsEnded });
  }

  const events = lapsed
    .filter((s) => flippedIds.has(s.id))
    .map((s) => ({
      storeId: s.id,
      fromPlan: s.plan,
      toPlan: "free",
      source: "system",
      actor: "plan-expiry-cron",
      note: "plan expired",
    }));
  if (events.length) {
    // Best-effort audit trail — the flip itself is the source of truth.
    try {
      await withService((db) => db.insert(planEvents).values(events));
    } catch (auditErr) {
      console.error(
        "plan-expiry (audit):",
        auditErr instanceof Error ? auditErr.message : auditErr,
      );
    }
    revalidateTag(STORE_TAG, "max");

    // Tell each merchant their plan lapsed to free (best-effort).
    await Promise.all(
      events.map(async (ev) => {
        const recip = await resolveBillingEmail(ev.storeId);
        if (!recip) return;
        await sendBillingEmail(
          recip.email,
          planDowngradedTemplate({
            storeName: recip.storeName,
            fromPlanName: PLAN_META[normalizePlan(ev.fromPlan)].name,
            manageUrl: manageUrl(recip.slug),
          }),
        );
      }),
    );
  }

  const warned = await warnExpiringPlans(nowIso);

  return NextResponse.json({
    ok: true,
    expired: events.length,
    compsEnded,
    warned,
  });
}

/**
 * Clear every comped-plan overlay whose window has closed.
 *
 * ★★ IT WRITES ONLY THE `comp_*` COLUMNS. The paid entitlement is untouched, so
 * a merchant whose free Pro month ends falls back to the Basic they have been
 * paying for all along — the failure the overlay design exists to prevent
 * (docs/comped-plans-spec.md §3.2), where the old shape would have written
 * `plan = 'free'` over a live subscription.
 *
 * ★ The fall-back plan is read AFTER the clear so the notification names what
 * they actually land on. Reusing `plan.changed` would tell a Basic subscriber
 * they had been downgraded; this is its own event.
 */
async function endLapsedComps(nowIso: string): Promise<number> {
  let ended: { id: string; compPlanBefore: string | null; plan: string }[];
  try {
    ended = await withService(async (db) => {
      // ★★ ONE STATEMENT, WITH A SNAPSHOT OF THE OLD ROW.
      //
      // Postgres RETURNING yields the row AFTER the update, so a plain
      // `returning({ compPlan })` comes back NULL — the sweep would clear the
      // comp and then be unable to name the plan that ended, which is half the
      // notification. The `FROM stores old` self-join is the snapshot: `old.*`
      // is the pre-update row, while the SET applies to the target.
      //
      // Still a single conditional claim, so a concurrent run cannot double-
      // notify: the second one matches zero rows.
      const res = await db.execute(sql`
        update stores s
           set comp_plan = null,
               comp_duration_days = null,
               comp_offered_at = null,
               comp_starts_at = null,
               comp_expires_at = null
          from stores old
         where old.id = s.id
           and s.comp_expires_at is not null
           and s.comp_expires_at <= ${nowIso}::timestamptz
        returning s.id,
                  old.comp_plan as comp_plan_before,
                  -- Untouched by this UPDATE: the entitlement they fall back to.
                  s.plan
      `);
      const rows = (res as unknown as { rows?: Record<string, unknown>[] })
        .rows;
      return (rows ?? []).map((r) => ({
        id: String(r.id),
        compPlanBefore:
          r.comp_plan_before == null ? null : String(r.comp_plan_before),
        plan: String(r.plan ?? "free"),
      }));
    });
  } catch (err) {
    console.error(
      "plan-expiry (comp sweep):",
      err instanceof Error ? err.message : err,
    );
    return 0;
  }
  if (!ended.length) return 0;

  revalidateTag(STORE_TAG, "max");

  try {
    await withService((db) =>
      db.insert(planEvents).values(
        ended.map((s) => ({
          storeId: s.id,
          fromPlan: null,
          toPlan: normalizePlan(s.plan),
          source: "system",
          actor: "plan-expiry-cron",
          note: "comped plan ended",
        })),
      ),
    );
  } catch (auditErr) {
    console.error(
      "plan-expiry (comp audit):",
      auditErr instanceof Error ? auditErr.message : auditErr,
    );
  }

  // ★★ NAME THE PLAN THEY LAND ON, not the one they lost. `row.plan` is the
  // PAID entitlement, untouched by the clear above — for a paying merchant that
  // is the plan they have been paying for all along, and telling them they
  // "moved to Free" would be flatly wrong. This is why it is its own event and
  // not `plan.changed`.
  //
  // recordEvent, not emitEvent: a cron response is already gone by the time
  // after() would run.
  for (const store of ended) {
    await recordEvent({
      type: "store.comp_ended",
      storeId: store.id,
      payload: {
        comp_plan: PLAN_META[normalizePlan(store.compPlanBefore)].name,
        plan: PLAN_META[normalizePlan(store.plan)].name,
      },
    });
  }

  return ended.length;
}

// Warn merchants BEFORE a timed plan lapses. The horizons and the 24-hour-band
// rule that keeps each warning once-only live in lib/plans.ts (pure + tested).
async function warnExpiringPlans(nowIso: string): Promise<number> {
  const now = new Date(nowIso);
  let warned = 0;

  for (const days of EXPIRY_WARN_DAYS) {
    const { from, to } = expiryWarnWindow(now, days);

    let due: { id: string; plan: string; planExpiresAt: string | null }[];
    try {
      due = await withService((db) =>
        db
          .select({
            id: stores.id,
            plan: stores.plan,
            planExpiresAt: stores.planExpiresAt,
          })
          .from(stores)
          .where(
            and(
              ne(stores.plan, "free"),
              gt(stores.planExpiresAt, from),
              lte(stores.planExpiresAt, to),
            ),
          ),
      );
    } catch (err) {
      console.error(
        `plan-expiry (warn ${days}d):`,
        err instanceof Error ? err.message : err,
      );
      continue;
    }

    for (const store of due) {
      // recordEvent, not emitEvent: a cron response is already gone by the
      // time after() would run.
      await recordEvent({
        type: "plan.expiring",
        storeId: store.id,
        actor: { type: "system" },
        subject: {
          type: "plan",
          id: store.plan,
          label: PLAN_META[normalizePlan(store.plan)].name,
        },
        payload: {
          plan: PLAN_META[normalizePlan(store.plan)].name,
          daysLeft: days,
          expiresOn: store.planExpiresAt ?? "",
        },
      });
      warned++;
    }
  }

  return warned;
}

export const GET = handle;
export const POST = handle;
