import { NextResponse } from "next/server";
import { withService } from "@/lib/db/client";
import { isUniqueViolation } from "@/lib/db/errors";
import { billingWebhookEvents } from "@/drizzle/schema";
import { verifyWebhookSignature } from "@/lib/payments/razorpay";
import { logInfo, logWarn } from "@/lib/observability/logger";

/**
 * Razorpay webhooks — verified, deduplicated, and currently ACTING ON NOTHING.
 *
 * ★★ THIS ROUTE USED TO DRIVE RECURRING BILLING, and that is exactly why it must
 * not any more. It processed `subscription.*` events and wrote `stores.plan` /
 * `plan_expires_at` from them. The Razorpay Subscriptions path was deleted on
 * 2026-08-13 (§34) because a Subscription's amount cannot be changed on a UPI or
 * e-mandate mandate — so those events now describe an object nothing in StoreMink
 * manages. Acting on one would move a merchant's plan on the word of a gateway
 * timer our own state machine knows nothing about, which is worse than ignoring
 * it.
 *
 * ★ WHY IT IS NOT DELETED OUTRIGHT. Three reasons, in order:
 *
 *   1. The endpoint is registered in the Razorpay dashboard. Deleting the route
 *      turns every delivery into a 404 and a retry storm in their logs, which
 *      reads as an outage on our side.
 *   2. A live Subscription may still exist at the gateway for a store whose local
 *      record is gone. Answering 200 makes Razorpay stop asking; a 404 does not.
 *   3. It is where the NEW system's webhooks belong when they land (spec phase 6),
 *      and the two things worth keeping — raw-body HMAC verification and the
 *      exactly-once event marker — are already here and proved.
 *
 * ⚠ NOTHING IN THE NEW SYSTEM DEPENDS ON A WEBHOOK TODAY. Enrolment, manual
 * payment, plan changes and location purchases all confirm ON SESSION against a
 * verified signature, and the renewal worker reconciles on a schedule. That is
 * why removing the processing costs nothing.
 *
 * Security is unchanged: the RAW body is HMAC-verified against
 * `RAZORPAY_WEBHOOK_SECRET` before anything else happens, and every
 * `X-Razorpay-Event-Id` is recorded once in `billing_webhook_events`.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface WebhookBody {
  event?: string;
  created_at?: number;
  payload?: {
    subscription?: { entity?: { id?: string } };
    payment?: { entity?: { id?: string } };
  };
}

async function handle(request: Request) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) {
    logWarn("razorpay webhook: RAZORPAY_WEBHOOK_SECRET not set");
    return NextResponse.json({ error: "not configured" }, { status: 500 });
  }

  const raw = await request.text();
  const sig = request.headers.get("x-razorpay-signature") ?? "";
  if (!verifyWebhookSignature(secret, raw, sig)) {
    return NextResponse.json({ error: "bad signature" }, { status: 401 });
  }

  let event: WebhookBody;
  try {
    event = JSON.parse(raw) as WebhookBody;
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const subjectId =
    event.payload?.subscription?.entity?.id ??
    event.payload?.payment?.entity?.id ??
    "";
  const eventId =
    request.headers.get("x-razorpay-event-id") ||
    `${event.event}:${event.created_at}:${subjectId}`;

  // ★ The marker is the exactly-once guarantee: first writer wins, and a unique
  // violation means this delivery was already seen. Kept even though nothing is
  // processed, so it is already correct when processing returns.
  try {
    await withService((db) =>
      db
        .insert(billingWebhookEvents)
        .values({ eventId, eventType: event.event }),
    );
  } catch (dupErr) {
    if (isUniqueViolation(dupErr)) {
      return NextResponse.json({ ok: true, duplicate: true });
    }
    logWarn("razorpay webhook: marker failed", {
      error: dupErr instanceof Error ? dupErr.message : String(dupErr),
    });
    // ⚠ 500 so Razorpay retries. Without the marker we cannot promise
    // exactly-once, and silently accepting would make that promise false the day
    // processing comes back.
    return NextResponse.json({ error: "marker failed" }, { status: 500 });
  }

  // Recorded, not acted on. A `subscription.*` event here describes a gateway
  // object StoreMink no longer manages — worth seeing in the logs, never worth
  // applying.
  logInfo("razorpay webhook received", {
    eventType: event.event ?? "unknown",
    subjectId,
    acted: false,
  });

  return NextResponse.json({ ok: true, acknowledged: true });
}

export const POST = handle;

/**
 * ⚠ The marker rows are never pruned — `billing_webhook_events` is not in §32's
 * `RETENTION_POLICIES`, so it grows one row per delivery forever. Add it when
 * webhook processing returns and the volume becomes real.
 */
