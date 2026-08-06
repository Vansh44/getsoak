import "server-only";

// ---------------------------------------------------------------------------
// Driving a store's domain to "live", WITHOUT a request context.
//
// ★ WHY THIS MODULE EXISTS. Provisioning used to have exactly one caller: the
// settings page in the merchant's browser. So finishing the connect flow
// depended on that tab staying open — and the three steps do not complete in one
// visit. Google's managed certificate is documented as taking up to ~30 minutes
// after the challenge CNAME resolves, and merchants add DNS records at their
// registrar minutes or DAYS after leaving the dashboard. The poll gave up after
// ~10 minutes and made no progress at all while the tab was backgrounded.
//
// The consequence was silent and total: the certificate would reach ACTIVE at
// Google, and then nothing ever ran step 3 (the certificate map entry) or set
// `custom_domain_verified`. The store stayed on its subdomain forever, the
// dashboard still said "Waiting for your DNS records", and the certificate the
// merchant was waiting for had in fact been issued. From their seat, "SSL
// certificates aren't being generated".
//
// So the flow gets what every other slow, externally-gated flow in this codebase
// already has (§18 payments, §26 refunds, seo-refresh): reconcile-on-read plus a
// cron backstop. This is the shared core both paths call.
//
// ★ IT IS DELIBERATELY NOT IN THE "use server" FILE. Everything exported from
// app/actions/store-domain.ts is a publicly reachable endpoint; an unauthenticated
// sweep over every store exported from there would be exactly the hazard the
// syncEmailDomainVerified comment in that file warns about. The action layer
// keeps the permission gate and delegates here.
// ---------------------------------------------------------------------------

import { eq, and, isNotNull } from "drizzle-orm";
import { revalidateTag } from "next/cache";
import { withService } from "@/lib/db/client";
import { stores } from "@/drizzle/schema";
import { STORE_TAG } from "@/lib/store/resolve";
import { PLAN_LIMITS, effectivePlan, type Plan } from "@/lib/plans";
import { logError, logInfo, logWarn } from "@/lib/observability/logger";
import { dnsRecordName } from "./domain";
import {
  ensureProvisioned,
  getCertConfig,
  reissueCertificate,
  type ProvisionState,
} from "./certificates";
import { checkCnameTarget, checkDomainPointsTo } from "./dns";
import { decideReissue, pendingDuration } from "./reissue";

export const UPGRADE_MESSAGE =
  "Connecting your own domain is part of the Pro plan. Upgrade to add one.";

/**
 * Is this store entitled to a custom domain right now?
 *
 * Read from the EFFECTIVE plan, so a lapsed timed plan is treated as free — the
 * same rule lookupStoreByHost applies when deciding whether to serve. The two
 * must agree: a dashboard that lets you connect a domain the router will refuse
 * to serve is worse than one that says no up front.
 */
export async function storeAllowsCustomDomain(
  storeId: string,
): Promise<{ allowed: boolean; plan: Plan }> {
  const rows = await withService((db) =>
    db
      .select({ plan: stores.plan, plan_expires_at: stores.planExpiresAt })
      .from(stores)
      .where(eq(stores.id, storeId))
      .limit(1),
  ).catch(() => []);
  // Fail CLOSED. Unlike the serving path — where a hiccup must not take a live
  // shop offline — the cost here is a merchant retrying a form, and the cost of
  // failing open is handing out a paid feature on a database error.
  const plan = effectivePlan(rows[0] ?? { plan: "free" });
  return { allowed: PLAN_LIMITS[plan].customDomain, plan };
}

/** The acting store's domain fields. */
export async function readStoreDomainRow(storeId: string) {
  const rows = await withService((db) =>
    db
      .select({
        custom_domain: stores.customDomain,
        settings: stores.settings,
      })
      .from(stores)
      .where(eq(stores.id, storeId))
      .limit(1),
  );
  return rows[0];
}

export async function saveDomainSettings(
  storeId: string,
  settings: Record<string, unknown>,
): Promise<void> {
  await withService((db) =>
    db.update(stores).set({ settings }).where(eq(stores.id, storeId)),
  ).catch((err) => logError("saveDomainSettings", err, { storeId }));
}

export interface DomainReconcileResult {
  storeId: string;
  domain: string | null;
  /** All three conditions hold and the store is being served on the domain. */
  verified: boolean;
  /** True only when THIS call flipped it live — the caller emits on that edge. */
  becameLive: boolean;
  certificateState: string | null;
  /** Google's machine-readable cause, for logs and support. */
  failureReason?: string;
  /** Companion hosts (the www/apex counterpart) that are also serving. */
  extraHosts?: string[];
  /** Whole days this domain has been waiting. 0 once live. */
  waitingDays?: number;
  /** Hosts whose certificate this run reset to escape Google's backoff. */
  reissued?: string[];
  /** What is still outstanding, phrased for the merchant. */
  error?: string;
}

/**
 * Advance one store's domain toward serving, and report what is still outstanding.
 *
 * NO AUTHORIZATION. Callers must gate. The plan check stays here on purpose
 * though — it is not about who is asking, it is about whether this store may be
 * served on a custom domain at all, and a background sweep must respect a lapsed
 * plan exactly as the merchant-facing path does.
 *
 * Idempotent end to end: provisioning adopts existing resources, the DNS checks
 * are reads, and the settings write is a no-op when nothing changed.
 */
export async function reconcileDomainForStore(
  storeId: string,
): Promise<DomainReconcileResult> {
  const base = {
    storeId,
    verified: false,
    becameLive: false,
    certificateState: null as string | null,
  };

  const cfg = getCertConfig();
  if (!cfg) {
    return {
      ...base,
      domain: null,
      error: "Custom domains aren't configured.",
    };
  }

  const row = await readStoreDomainRow(storeId).catch(() => undefined);
  const domain = row?.custom_domain ?? null;
  if (!domain) return { ...base, domain: null, error: "Add a domain first." };

  const { allowed } = await storeAllowsCustomDomain(storeId);
  if (!allowed) return { ...base, domain, error: UPGRADE_MESSAGE };

  const settings = ((row?.settings as Record<string, unknown>) ?? {}) as Record<
    string,
    unknown
  >;
  const wasVerified = settings.custom_domain_verified === true;

  // (1) + (3): certificate issued and attached to the load balancer's map.
  let prov = await ensureProvisioned(domain);

  // ★ SELF-HEAL A STALE VERDICT. Google records its LAST attempt and then backs
  // off, so a merchant who fixes their DNS is not re-checked promptly — in prod
  // an apex sat down for an hour on a verdict predating the correct records.
  // Forcing a fresh attempt made it ACTIVE in 80 seconds. Every guard for when
  // NOT to do this lives in decideReissue (rate limits, CAA, thrash).
  const reissued = await maybeReissue(storeId, domain, prov, settings);
  if (reissued.length > 0) {
    // One extra pass, so the new certificate starts authorizing immediately
    // rather than waiting for the next sweep. It will not be ACTIVE yet — that
    // took ~80s — so this run still reports "provisioning" and the NEXT run (or
    // the merchant's own page load) attaches it. Bounded at one retry: this is a
    // background job, not a place to sit in a loop.
    prov = await ensureProvisioned(domain);
  }

  // Persist the challenge records even when we're not done, so the merchant can
  // see what to add without re-running provisioning to find out.
  const next: Record<string, unknown> = { ...settings };
  // Per-host, primary first — the www host has its OWN challenge CNAME, and one
  // shared field could only ever show half of what has to be added.
  const challenges = prov.hosts
    .filter((h) => h.challenge)
    .map((h) => ({ host: h.host, ...h.challenge! }));
  if (challenges.length > 0) next.domain_challenges = challenges;
  // Still written for the primary: older readers (and any cached page) expect
  // this shape, and dropping it would blank the records list mid-deploy.
  if (prov.challenge) next.domain_challenge = prov.challenge;
  next.domain_cert_state = prov.certificateState;
  // The enum only (CONFIG / CAA / RATE_LIMITED) — `settings` is anon-readable,
  // so Google's free-text details stay in the logs.
  if (prov.failureReason) next.domain_cert_issue = prov.failureReason;
  else delete next.domain_cert_issue;

  // The reissue cooldown, per host. A reissue whose timestamp is not persisted
  // is a reissue that happens every single run — which is how an anti-thrash
  // guard turns into the thrash it exists to prevent.
  if (reissued.length > 0) {
    const stamps = {
      ...((settings.domain_reissued ?? {}) as Record<string, string>),
    };
    const at = new Date().toISOString();
    for (const host of reissued) stamps[host] = at;
    next.domain_reissued = stamps;
  }

  // When this domain started waiting, so "stuck for a week" is distinguishable
  // from "stuck for a minute" — the sweep answers 200 either way, by design.
  const pendingSince = (settings.domain_pending_since as string) ?? undefined;
  if (!prov.ready && !pendingSince) {
    next.domain_pending_since = new Date().toISOString();
  }

  // Which companion hosts are serving, so the settings page can be honest about
  // www without re-querying Google on every page load.
  const extraLive = prov.hosts.slice(1).filter((h) => h.ready);
  if (extraLive.length > 0)
    next.domain_extra_hosts = extraLive.map((h) => h.host);
  else delete next.domain_extra_hosts;

  if (!prov.ready) {
    await saveDomainSettings(storeId, next);
    const waited = pendingDuration(
      pendingSince ?? (next.domain_pending_since as string),
      Date.now(),
    );
    // ★ SILENCE IS NOT SUCCESS. The sweep deliberately answers 200 while
    // domains wait, so nothing else would ever surface a domain that has been
    // stuck for days. WARN so Cloud Logging / Error Reporting can alert on it.
    if (waited.stuck) {
      logWarn("custom domain stuck", {
        storeId,
        domain,
        days: waited.days,
        certificateState: prov.certificateState,
        failureReason: prov.failureReason,
      });
    }
    return {
      ...base,
      domain,
      certificateState: prov.certificateState,
      failureReason: prov.failureReason,
      waitingDays: waited.days,
      reissued: reissued.length > 0 ? reissued : undefined,
      error: await pendingMessage(domain, prov),
    };
  }

  // (2): it actually points at us. Checked AFTER the certificate, because the
  // certificate is the slow part and there is no sense reporting a routing
  // problem the merchant would have to fix twice.
  const dns = await checkDomainPointsTo(domain, cfg.loadBalancerIp);
  if (!dns.pointsToUs) {
    await saveDomainSettings(storeId, next);
    return {
      ...base,
      domain,
      certificateState: prov.certificateState,
      error: dns.error ?? "This domain doesn't point to us yet.",
    };
  }

  // All three hold for the PRIMARY, which is what going live means. A companion
  // host still waiting keeps its challenge record on screen — deliberately: the
  // store is up, and www is a loose end the merchant can close whenever.
  next.custom_domain_verified = true;
  if (challenges.length === 0) {
    delete next.domain_challenge;
    delete next.domain_challenges;
  }
  // Live: clear the waiting clock and the cooldown stamps, so a domain that is
  // later changed or breaks starts its next wait from zero rather than
  // inheriting a months-old "stuck" timestamp and alarming immediately.
  delete next.domain_pending_since;
  delete next.domain_reissued;
  await saveDomainSettings(storeId, next);
  revalidateTag(STORE_TAG, "max");

  if (!wasVerified) {
    logInfo("custom domain live", { storeId, domain });
  }
  return {
    storeId,
    domain,
    verified: true,
    becameLive: !wasVerified,
    certificateState: prov.certificateState,
    extraHosts: extraLive.map((h) => h.host),
  };
}

/**
 * Force a fresh authorization attempt on any host stuck behind a stale verdict.
 *
 * Decides per host, because the apex and its www companion have independent
 * certificates and can be stuck for different reasons at different times.
 * Returns the hosts actually reset, so the caller can record the cooldown — a
 * reissue whose timestamp is not persisted is a reissue that happens every run.
 *
 * Never throws: this is an optimisation on top of a flow that already works by
 * waiting, so a failure here must degrade to "keep waiting", not break the sweep.
 */
async function maybeReissue(
  storeId: string,
  domain: string,
  prov: ProvisionState,
  settings: Record<string, unknown>,
): Promise<string[]> {
  const lastReissue = (settings.domain_reissued ?? {}) as Record<
    string,
    string
  >;
  const nowMs = Date.now();
  const done: string[] = [];

  for (const host of prov.hosts) {
    // Cheap checks first — decideReissue rejects most cases without a DNS
    // lookup, and the lookup is the only expensive part.
    const dry = decideReissue({
      ready: host.ready,
      failureReason: host.failureReason,
      attemptTime: host.attemptTime,
      cnameCorrect: true, // provisional; confirmed below before acting
      lastReissueAt: lastReissue[host.host],
      nowMs,
    });
    if (!dry.reissue) continue;

    // Only now pay for the DNS check, and re-decide with the real answer.
    const cname = host.challenge
      ? await checkCnameTarget(host.challenge.name, host.challenge.value)
      : { matches: false, found: [] as string[] };

    const decision = decideReissue({
      ready: host.ready,
      failureReason: host.failureReason,
      attemptTime: host.attemptTime,
      cnameCorrect: cname.matches,
      lastReissueAt: lastReissue[host.host],
      nowMs,
    });
    if (!decision.reissue) {
      logInfo("custom domain reissue skipped", {
        storeId,
        host: host.host,
        reason: decision.reason,
      });
      continue;
    }

    const res = await reissueCertificate(host.host).catch((err) => ({
      error: err instanceof Error ? err.message : "reissue threw",
    }));
    if (res.error) {
      logError("custom domain reissue failed", res.error, {
        storeId,
        host: host.host,
      });
      continue;
    }
    logWarn("custom domain certificate reissued", {
      storeId,
      domain,
      host: host.host,
      reason: decision.reason,
    });
    done.push(host.host);
  }
  return done;
}

/** The most actionable sentence available for a domain that isn't live yet. */
async function pendingMessage(
  domain: string,
  prov: Awaited<ReturnType<typeof ensureProvisioned>>,
): Promise<string> {
  // A cause the records on screen cannot fix outranks everything else: a CAA
  // record forbidding Google, or a CA rate limit, is not resolved by re-adding a
  // CNAME, and saying "add the DNS records shown" to someone in that state sends
  // them round the same loop indefinitely.
  if (prov.diagnosis) return prov.diagnosis;
  if (prov.error) return prov.error;

  // Certificate Manager's PROVISIONING state does not explain a MISPLACED
  // record. Check the exact name so registrar UIs that append the zone (for
  // example GoDaddy) get an immediately actionable correction.
  if (prov.challenge) {
    const cname = await checkCnameTarget(
      prov.challenge.name,
      prov.challenge.value,
    );
    if (!cname.matches) {
      const relativeName = dnsRecordName(prov.challenge.name, domain);
      return cname.found.length > 0
        ? `${cname.error} Update it to ${prov.challenge.value}.`
        : `We couldn't find the certificate CNAME at ${prov.challenge.name}. In your DNS provider, enter ${relativeName} as the Name (not the full domain) and ${prov.challenge.value} as the Value.`;
    }
  }

  // The records are right and Google simply hasn't finished. Say so, because the
  // honest answer here is "nothing left to do" — the old message asked the
  // merchant to go and re-check DNS they had already got correct.
  return "Your DNS records look right. Google is still issuing the certificate — this can take up to 30 minutes. We'll finish this automatically, so you can close this page.";
}

/**
 * Reconcile every store waiting on a domain. The cron backstop.
 *
 * Only stores with a domain set and not yet verified: a live domain needs no
 * work, and re-provisioning it would spend API calls to learn nothing. Failures
 * are collected rather than thrown so one broken domain cannot stop the sweep.
 */
export async function sweepPendingDomains(): Promise<{
  pending: number;
  live: number;
  becameLive: DomainReconcileResult[];
  reissued: string[];
  failures: Array<{
    storeId: string;
    domain: string | null;
    waitingDays?: number;
    error?: string;
  }>;
}> {
  if (!getCertConfig()) {
    return { pending: 0, live: 0, becameLive: [], reissued: [], failures: [] };
  }

  const rows = await withService((db) =>
    db
      .select({ id: stores.id, settings: stores.settings })
      .from(stores)
      .where(and(eq(stores.status, "active"), isNotNull(stores.customDomain))),
  ).catch((err) => {
    logError("sweepPendingDomains (read)", err);
    return [] as Array<{ id: string; settings: unknown }>;
  });

  const pending = rows.filter(
    (r) =>
      ((r.settings ?? {}) as Record<string, unknown>).custom_domain_verified !==
      true,
  );

  const results: DomainReconcileResult[] = [];
  // Sequential on purpose. This is a background job with no one waiting, and
  // each store costs several Certificate Manager calls plus DNS lookups —
  // parallelising it buys nothing and risks the per-project API rate limit that
  // shows up as RATE_LIMITED on merchants' certificates.
  for (const row of pending) {
    results.push(
      await reconcileDomainForStore(row.id).catch(
        (err): DomainReconcileResult => {
          logError("sweepPendingDomains (store)", err, { storeId: row.id });
          return {
            storeId: row.id,
            domain: null,
            verified: false,
            becameLive: false,
            certificateState: null,
            error: err instanceof Error ? err.message : "reconcile failed",
          };
        },
      ),
    );
  }

  return {
    pending: pending.length,
    live: results.filter((r) => r.verified).length,
    becameLive: results.filter((r) => r.becameLive),
    // Every host reset this run, so a reissue loop would be visible in the cron
    // output rather than only in the logs.
    reissued: results.flatMap((r) => r.reissued ?? []),
    failures: results
      .filter((r) => !r.verified)
      .map((r) => ({
        storeId: r.storeId,
        domain: r.domain,
        // Days waited, so a domain nobody is fixing stands out from one
        // connected five minutes ago.
        waitingDays: r.waitingDays,
        error: r.error,
      })),
  };
}
