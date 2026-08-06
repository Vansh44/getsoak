// ---------------------------------------------------------------------------
// The custom-domain backstop.
//
// ★ WHY THIS EXISTS. Connecting a domain takes three steps that cannot complete
// in one sitting: the merchant adds DNS records at their registrar, Google
// issues the certificate (documented as up to ~30 minutes AFTER the challenge
// CNAME resolves), and only then can the certificate be attached to the load
// balancer's map and the store flipped live. Provisioning had exactly one
// caller — the settings page — which polled for ~10 minutes and made no
// progress at all while the tab was backgrounded. So in the ordinary case
// (merchant adds records, closes the dashboard, DNS propagates) the certificate
// reached ACTIVE at Google and NOTHING ever attached it. The domain never went
// live, and the dashboard still said "waiting for your DNS records".
//
// This is the same shape as /api/cron/expire-pending-payments and the refund
// sweep: reconcile-on-read for the person who is watching, a cron for everyone
// who isn't.
//
// Runs HOURLY. Issuance is measured in tens of minutes and merchants edit DNS on
// their own schedule, so a daily sweep would mean a domain connected at 09:05
// waits a day to serve. Cheap: only unverified domains are touched.
// ---------------------------------------------------------------------------

import { sweepPendingDomains } from "@/lib/domains/reconcile";
import { recordEvent } from "@/lib/notifications/record";
import { logError } from "@/lib/observability/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function authorised(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  return (
    !!secret && request.headers.get("authorization") === `Bearer ${secret}`
  );
}

async function handle(request: Request): Promise<Response> {
  if (!authorised(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await sweepPendingDomains();

    // recordEvent, NOT emitEvent: emitEvent defers through after(), which has
    // nothing to defer onto once a cron response is sent (§notifications).
    //
    // This is the path that MATTERS for the merchant mail. The whole reason the
    // sweep exists is that they are not watching, so in the ordinary case this
    // is what tells them their domain went live — the action path only fires for
    // someone who happened to be on the page at the moment it finished.
    for (const store of result.becameLive) {
      const subject = {
        type: "store",
        id: store.storeId,
        label: store.domain ?? "",
      };
      await recordEvent({
        type: "store.domain_live",
        storeId: store.storeId,
        actor: { type: "system" },
        subject,
        payload: {
          domain: store.domain ?? "",
          store_url: `https://${store.domain ?? ""}`,
          extra_hosts: (store.extraHosts ?? []).join(", "),
        },
      });
      await recordEvent({
        type: "platform.domain_verified",
        storeId: store.storeId,
        actor: { type: "system" },
        subject,
        payload: { domain: store.domain ?? "" },
      });
    }

    // 200 even with failures still outstanding. Unlike seo-refresh — where a
    // failure means OUR configuration is broken and Cloud Scheduler's retries
    // are wanted — the overwhelmingly common "failure" here is a merchant who
    // hasn't added their DNS records yet. Retrying that within the hour cannot
    // help, and a permanently-red job is a job nobody looks at.
    return Response.json({
      ok: true,
      pending: result.pending,
      live: result.live,
      becameLive: result.becameLive.map((s) => s.domain),
      // Hosts whose certificate was reset to escape Google's retry backoff. If
      // this is ever non-empty on consecutive runs for the same host, the
      // cooldown in reissue.ts is not doing its job — look there first.
      reissued: result.reissued,
      waiting: result.failures,
    });
  } catch (err) {
    logError("domain-reconcile cron failed", err);
    return Response.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "domain reconcile failed",
      },
      { status: 500 },
    );
  }
}

export const GET = handle;
export const POST = handle;
