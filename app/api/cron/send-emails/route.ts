import { after } from "next/server";
import { NextResponse } from "next/server";
import { processEmailQueue } from "@/lib/email/campaign-worker";
import { processNotificationEmails } from "@/lib/email/notification-worker";
import { triggerEmailWorker } from "@/lib/email/trigger-worker";

// Drains BOTH outbound email queues:
//   • coupon campaigns      (email_campaign_recipients)
//   • notification emails   (notification_email_queue — CODEBASE.md §22)
//
// One route, because they share a trigger, a secret, and a self-chaining
// pattern — and because the cron plan allows few schedules (Vercel Hobby caps
// crons at one/day), so a single entry point that drains everything is more
// reliable than two half-fed ones.
//
// Driven three ways:
//   1. Vercel Cron (see vercel.json) as the reliable heartbeat.
//   2. Self-chaining: if work remains after a run, kick another via after() so
//      a large campaign (or a burst of notifications) drains in minutes rather
//      than on the cron cadence.
//   3. On demand: emitting a notification with an instant email channel calls
//      triggerEmailWorker(), so "new order" mail goes out in seconds.
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

  // Sequential, not Promise.all: both workers send through the same Resend
  // account and claim from the same pool, so overlapping them buys nothing and
  // makes rate limits harder to reason about.
  const campaigns = await processEmailQueue();
  const notifications = await processNotificationEmails();

  // More to do in EITHER queue? Chain another run after this response is sent.
  if (campaigns.remaining > 0 || notifications.remaining > 0) {
    after(() => triggerEmailWorker());
  }

  return NextResponse.json({ ok: true, campaigns, notifications });
}

export const GET = handle;
export const POST = handle;
