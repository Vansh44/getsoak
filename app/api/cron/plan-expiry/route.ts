import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { and, gt, inArray, lte, ne } from "drizzle-orm";
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
    return NextResponse.json({ ok: true, expired: 0 });
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

  return NextResponse.json({ ok: true, expired: events.length, warned });
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
