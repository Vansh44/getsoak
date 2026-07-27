import { NextResponse } from "next/server";
import { verifySvixSignature } from "@/lib/email/webhook-signature";
import { suppressEmail } from "@/lib/email/suppression";
import { logError, logInfo, logWarn } from "@/lib/observability/logger";

// Resend delivery webhooks — the missing half of "did the mail arrive?".
//
// Handing a message to Resend is not delivery. Without this endpoint a
// hard-bouncing address was re-mailed on every future notification forever, and
// every one of those bounces was spent against the SHARED sending domain
// (lib/email/sender.ts) — so one store's dead address degraded deliverability
// for all of them.
//
// Security: the RAW body is Svix-signature-verified against
// RESEND_WEBHOOK_SECRET, following the Razorpay webhook's shape. This endpoint
// decides whether we stop mailing an address; unsigned, anyone could suppress a
// store's entire customer list.
//
// ONLY PERMANENT FAILURES SUPPRESS. A soft bounce (full mailbox, greylisting)
// resolves itself and is already covered by the queue's retry/backoff — cutting
// a real customer off over one would be worse than the bounce.
//
// Setup (one-time, per environment): Resend dashboard → Webhooks → add
// {origin}/api/webhooks/resend, subscribe to email.bounced + email.complained,
// and put the signing secret in RESEND_WEBHOOK_SECRET.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Resend/SES bounce sub-types that mean "this mailbox is gone for good". */
const PERMANENT_BOUNCE = new Set(["permanent", "hard", "suppressed", "block"]);

interface ResendWebhook {
  type?: string;
  data?: {
    to?: string[] | string;
    email_id?: string;
    bounce?: { type?: string; subType?: string; message?: string };
  };
}

function recipients(data: ResendWebhook["data"]): string[] {
  const to = data?.to;
  if (!to) return [];
  return (Array.isArray(to) ? to : [to]).filter(Boolean);
}

export async function POST(request: Request) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    // Not configured is not an error worth retrying — say so and stop, rather
    // than accepting unverified payloads.
    logWarn("resend webhook: RESEND_WEBHOOK_SECRET unset, ignoring delivery");
    return NextResponse.json({ ok: false, reason: "not configured" });
  }

  // RAW body: parsing and re-serialising changes the bytes and the signature
  // would never match.
  const body = await request.text();
  const verdict = verifySvixSignature(
    secret,
    {
      id: request.headers.get("svix-id"),
      timestamp: request.headers.get("svix-timestamp"),
      signature: request.headers.get("svix-signature"),
    },
    body,
  );
  if (!verdict.ok) {
    logWarn("resend webhook: rejected", { reason: verdict.reason });
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload: ResendWebhook;
  try {
    payload = JSON.parse(body) as ResendWebhook;
  } catch {
    // Malformed and signed means it will never parse — 200 so Resend stops
    // retrying something no redelivery can fix.
    logWarn("resend webhook: unparseable body");
    return NextResponse.json({ ok: false, reason: "bad payload" });
  }

  const type = payload.type ?? "";
  const to = recipients(payload.data);
  if (to.length === 0) {
    return NextResponse.json({ ok: true, suppressed: 0 });
  }

  let suppressed = 0;
  try {
    if (type === "email.bounced") {
      const sub = (
        payload.data?.bounce?.subType ??
        payload.data?.bounce?.type ??
        ""
      ).toLowerCase();
      // Unknown sub-types are treated as SOFT: guessing wrong costs a customer
      // every future email, and the retry path already handles transient ones.
      if (!PERMANENT_BOUNCE.has(sub)) {
        logInfo("resend webhook: soft bounce, not suppressing", { sub });
        return NextResponse.json({ ok: true, suppressed: 0, soft: true });
      }
      for (const email of to) {
        if (
          await suppressEmail({
            email,
            reason: "bounce",
            detail: payload.data?.bounce?.message ?? sub,
          })
        ) {
          suppressed++;
        }
      }
    } else if (type === "email.complained") {
      // A spam complaint is the strongest possible "stop" — always permanent.
      for (const email of to) {
        if (
          await suppressEmail({
            email,
            reason: "complaint",
            detail: "Marked as spam",
          })
        ) {
          suppressed++;
        }
      }
    }
  } catch (error) {
    // 500 so Resend redelivers — losing a bounce means mailing a dead address
    // forever.
    logError("resend webhook: processing failed", error, { type });
    return NextResponse.json({ error: "processing failed" }, { status: 500 });
  }

  if (suppressed > 0) {
    logInfo("resend webhook: addresses suppressed", { type, suppressed });
  }
  return NextResponse.json({ ok: true, suppressed });
}
