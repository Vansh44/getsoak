import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { orders } from "@/drizzle/schema";
import { verifyWebhookSignature } from "@/lib/payments/razorpay";
import { loadPaymentWebhookSecret } from "@/lib/payments/store-webhook";
import { markOrderPaid } from "@/lib/orders/mark-paid";
import { logError, logInfo, logWarn } from "@/lib/observability/logger";

/**
 * A MERCHANT's own Razorpay webhook (CODEBASE §18).
 *
 * Distinct from `/api/webhooks/razorpay`, which is the PLATFORM's account
 * (§34). This one is per store, verified against that store's own secret, and
 * its only job is to notice a captured payment sooner than reconcile-on-read
 * would.
 *
 * ── The rules this route obeys ─────────────────────────────────────────────
 *
 * ★★ THE SIGNATURE IS THE AUTHORISATION; THE URL IS NOT. `storeId` in the path
 * selects which secret to check — nothing more. Anyone may POST here, so every
 * decision below happens only after the HMAC verifies.
 *
 * ★★ THE ORDER LOOKUP IS STORE-SCOPED. Without `store_id = storeId`, a merchant
 * holding their own valid secret could name ANOTHER store's razorpay_order_id
 * and mark that stranger's order paid. The signature proves who is calling, not
 * what they may touch.
 *
 * ★ IT ADDS NO NEW WAY TO MARK AN ORDER PAID — it calls `markOrderPaid`, the
 * same conditional pending → paid claim the callback, reconcile-on-read and the
 * reaper all use. Razorpay retries deliveries, and a replay claims zero rows,
 * so the shopper is thanked exactly once.
 *
 * ★ STATUS CODES ARE INSTRUCTIONS TO RAZORPAY, not descriptions for us:
 *   200 — handled, or deliberately ignored. Stop retrying.
 *   401 — signature failed. Stop retrying; this delivery will never be valid.
 *   503 — we could not CHECK it (no secret loaded, database down). Retry.
 * Returning 200 on a failure we might have handled is how a payment is lost
 * silently; returning 500 on an event we simply do not care about is how a
 * merchant's webhook fills with red in their Razorpay dashboard.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface WebhookBody {
  event?: string;
  payload?: {
    payment?: { entity?: { id?: string; order_id?: string; amount?: number } };
    order?: { entity?: { id?: string } };
  };
}

/** The events that mean "money has landed". */
const PAID_EVENTS = new Set(["payment.captured", "order.paid"]);

export async function POST(
  request: Request,
  ctx: { params: Promise<{ storeId: string }> },
) {
  const { storeId } = await ctx.params;

  // Cheap shape check before touching the database. An id that cannot be a
  // store id is a scanner, not a delivery.
  if (!/^[0-9a-f-]{36}$/i.test(storeId ?? "")) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  const raw = await request.text();
  const signature = request.headers.get("x-razorpay-signature") ?? "";

  const secret = await loadPaymentWebhookSecret(storeId);
  if (!secret) {
    // Either no webhook is configured, the gateway is paused, or the read
    // failed — and from here those are indistinguishable. 503 asks Razorpay to
    // come back rather than discarding a delivery we could not verify.
    logWarn("store webhook: no verifiable secret", { storeId });
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }

  if (!verifyWebhookSignature(secret, raw, signature)) {
    return NextResponse.json({ error: "bad signature" }, { status: 401 });
  }

  let event: WebhookBody;
  try {
    event = JSON.parse(raw) as WebhookBody;
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  // Everything else — refunds, settlements, disputes — is acknowledged and
  // ignored. They are real events this system does not yet act on, and a
  // non-200 would make the merchant's dashboard look broken over a message we
  // never wanted.
  if (!PAID_EVENTS.has(event.event ?? "")) {
    return NextResponse.json({ ok: true, ignored: event.event ?? null });
  }

  const rzpOrderId =
    event.payload?.payment?.entity?.order_id ??
    event.payload?.order?.entity?.id ??
    "";
  const rzpPaymentId = event.payload?.payment?.entity?.id ?? "";
  if (!rzpOrderId || !rzpPaymentId) {
    // `order.paid` carries the order but not always a payment id. Nothing to
    // record against, and reconcile-on-read will still settle it.
    return NextResponse.json({ ok: true, incomplete: true });
  }

  try {
    const rows = await withService((db) =>
      db
        .select({ id: orders.id })
        .from(orders)
        .where(
          and(
            eq(orders.razorpayOrderId, rzpOrderId),
            // ★★ The scope that stops one merchant's secret reaching another
            // merchant's orders.
            eq(orders.storeId, storeId),
          ),
        )
        .limit(1),
    );

    const order = rows[0];
    if (!order) {
      // A payment for an order this store does not have. Not an error we can
      // fix by retrying — most likely a test event, or an order created in a
      // different environment against the same Razorpay account.
      logInfo("store webhook: no matching order", { storeId, rzpOrderId });
      return NextResponse.json({ ok: true, unmatched: true });
    }

    // Idempotent by construction: the claim inside matches zero rows on a
    // replay, so nothing is announced twice.
    await markOrderPaid(order.id, rzpPaymentId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    logError("store webhook: processing failed", err, { storeId, rzpOrderId });
    // We verified it and then failed to act on it — that is exactly the case
    // worth retrying.
    return NextResponse.json({ error: "retry" }, { status: 503 });
  }
}
