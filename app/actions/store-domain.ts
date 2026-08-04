"use server";

import { eq } from "drizzle-orm";
import { revalidateTag } from "next/cache";
import { after } from "next/server";
import { Resend } from "resend";
import { withService } from "@/lib/db/client";
import { stores } from "@/drizzle/schema";
import {
  getActingStoreId,
  getManagerUserId,
  getViewerAccess,
} from "@/app/dashboard/lib/access";
import { STORE_TAG } from "@/lib/store/resolve";
import { emitEvent } from "@/lib/notifications/record";
import { PLAN_LIMITS, effectivePlan, type Plan } from "@/lib/plans";
import {
  validateDomain,
  routingRecords,
  dnsRecordName,
} from "@/lib/domains/domain";
import {
  ensureProvisioned,
  deprovision,
  getCertConfig,
} from "@/lib/domains/certificates";
import { checkCnameTarget, checkDomainPointsTo } from "@/lib/domains/dns";
import { logError } from "@/lib/observability/logger";
import {
  ensureGoogleCoverageForStore,
  GOOGLE_INDEXING_SETTINGS_KEYS,
} from "@/lib/seo/store-indexing";

// Domain config is a Settings surface: reads require `view`, mutations `manage`.
// Every write here uses the service scope (RLS-bypassing), so the gate is
// the ONLY thing standing between a low-priv store member and the store's domain.
const DOMAIN_SECTION = "settings";

export interface DomainResult {
  success?: boolean;
  error?: string;
}

export interface DomainStatus {
  id: string;
  name: string;
  status: string; // 'pending', 'verified', 'failed', 'temporary_failure', 'not_started'
  records?: Array<{
    record: string;
    name: string;
    type: string;
    ttl: string;
    status: string;
    value: string;
    priority?: number;
  }>;
}

function getResend(): Resend | null {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || apiKey.includes("placeholder")) return null;
  return new Resend(apiKey);
}

function clean(v: string | null | undefined): string | null {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return s ? s : null;
}

/**
 * Is this store entitled to a custom domain right now?
 *
 * Read from the EFFECTIVE plan, so a lapsed timed plan is treated as free —
 * the same rule lookupStoreByHost applies when deciding whether to serve. The
 * two must agree: a dashboard that lets you connect a domain the router will
 * refuse to serve is worse than one that says no up front.
 */
async function storeAllowsCustomDomain(
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

const UPGRADE_MESSAGE =
  "Connecting your own domain is part of the Pro plan. Upgrade to add one.";

// The acting store's domain fields.
async function readStoreDomainRow(storeId: string) {
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

/**
 * Updates the custom domain for the store. Also registers it with Resend.
 */
export async function updateCustomDomain(
  domainName: string | null,
): Promise<DomainResult> {
  if (!(await getManagerUserId(DOMAIN_SECTION))) {
    return { error: "You don't have permission to manage domain settings." };
  }

  const storeId = await getActingStoreId();

  // Validate BEFORE touching Resend or the database: the old code sent whatever
  // was typed straight to the gateway, so "https://shop.acme.com/" was stored
  // verbatim and could never match the Host header the router compares against.
  let cleanDomain: string | null = null;
  if (clean(domainName)) {
    const check = validateDomain(domainName);
    if (!check.ok) return { error: check.message ?? "Invalid domain." };
    cleanDomain = check.domain ?? null;
  }

  // Pro only, enforced server-side. Disconnecting (a null domain) is always
  // allowed — a merchant who downgrades must still be able to tidy up.
  if (cleanDomain) {
    const { allowed } = await storeAllowsCustomDomain(storeId);
    if (!allowed) return { error: UPGRADE_MESSAGE };
  }

  // 1. Get existing info
  let store: Awaited<ReturnType<typeof readStoreDomainRow>> | undefined;
  try {
    store = await readStoreDomainRow(storeId);
  } catch {
    return { error: "Failed to load the store. Please try again." };
  }

  const settings = ((store?.settings as Record<string, unknown>) ??
    {}) as Record<string, unknown>;

  // ⚠ NO RESEND CALL HERE, deliberately.
  //
  // This used to register the domain with Resend for email sending, and return
  // its error — so connecting a STOREFRONT domain failed on an EMAIL provider's
  // quota. It is not hypothetical: the platform's Resend plan allows one
  // domain, so the second merchant to try would have been told
  // "Your plan includes 1 domain. Upgrade to add more." and been unable to
  // connect at all. Every merchant connect would also have consumed a paid
  // Resend domain slot for a feature they never asked for.
  //
  // Serving a storefront on a domain and sending mail FROM that domain are
  // separate features with separate DNS records and separate costs. Sending
  // stays on the platform's from-address (lib/email/sender.ts already falls
  // back when resend_domain_verified isn't set); branded sending can be
  // offered later as its own opt-in with its own capacity planning.
  const newSettings = { ...settings };
  delete newSettings.resend_domain_id;
  // A freshly set or changed domain is unproven: it has no certificate and may
  // not point at us. Clear both gates so nothing carries over from the old one.
  delete newSettings.custom_domain_verified;
  delete newSettings.resend_domain_verified;
  delete newSettings.domain_challenge;
  delete newSettings.domain_cert_state;
  for (const key of GOOGLE_INDEXING_SETTINGS_KEYS) delete newSettings[key];

  try {
    await withService((db) =>
      db
        .update(stores)
        .set({ customDomain: cleanDomain, settings: newSettings })
        .where(eq(stores.id, storeId)),
    );
  } catch (err) {
    console.error(
      "updateCustomDomain:",
      err instanceof Error ? err.message : err,
    );
    return { error: "Failed to save domain in database." };
  }

  revalidateTag(STORE_TAG, "max");
  return { success: true };
}

/**
 * Record whether the store's domain is verified FOR SENDING EMAIL.
 *
 * ⚠ This must never touch `custom_domain_verified`. It used to set both, which
 * meant Resend's DKIM/SPF result — proof only that a domain can send mail —
 * decided whether we SERVE the storefront on that host. Since this runs from an
 * exported server action, that was a live endpoint any store manager could call
 * to mark a domain verified on any plan, with no certificate and no check that
 * the domain points at us. Routing is flipped in exactly one place now:
 * verifyDomain(), once all three conditions hold.
 */
async function syncEmailDomainVerified(isVerified: boolean): Promise<void> {
  const storeId = await getActingStoreId();

  let store: Awaited<ReturnType<typeof readStoreDomainRow>> | undefined;
  try {
    store = await readStoreDomainRow(storeId);
  } catch (err) {
    console.error("syncEmailDomainVerified read:", err);
    return;
  }

  // Only meaningful for a store that actually has a custom domain set.
  if (!store?.custom_domain) return;

  const settings = ((store.settings as Record<string, unknown>) ??
    {}) as Record<string, unknown>;
  if (settings.resend_domain_verified === isVerified) return;

  try {
    await withService((db) =>
      db
        .update(stores)
        .set({
          settings: { ...settings, resend_domain_verified: isVerified },
        })
        .where(eq(stores.id, storeId)),
    );
  } catch (err) {
    console.error("syncEmailDomainVerified:", err);
    return;
  }

  // No platform.domain_verified here. That event means "this store is now
  // being served on its own domain", which is verifyDomain()'s business —
  // emitting it for an email-sending check would announce a domain that may
  // have no certificate and may not point at us at all.
  revalidateTag(STORE_TAG, "max");
}

/**
 * Triggers a DNS verification check on Resend.
 */
export async function verifyResendDomain(
  resendDomainId: string,
): Promise<DomainResult> {
  if (!(await getManagerUserId(DOMAIN_SECTION))) {
    return { error: "You don't have permission to manage domain settings." };
  }

  const resend = getResend();
  if (!resend) return { error: "Resend API key not configured." };

  try {
    const { error } = await resend.domains.verify(resendDomainId);
    if (error) return { error: error.message };

    // Re-read the domain's status now that verification was triggered and mirror
    // it into the store settings. This runs in an action (not during render), so
    // revalidating the routing cache here is safe. If DNS isn't propagated yet
    // the status stays "pending" and the routing gate correctly stays closed.
    const { data } = await resend.domains.get(resendDomainId);
    if (data) {
      await syncEmailDomainVerified(
        (data as DomainStatus).status === "verified",
      );
    }

    return { success: true };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Failed to verify domain.";
    return { error: msg };
  }
}

// ---------------------------------------------------------------------------
// The connect flow.
//
// A domain is marked verified only when ALL THREE hold:
//   1. the certificate is ACTIVE,
//   2. the domain resolves publicly to our load balancer,
//   3. the certificate map entry exists.
//
// Each one alone is insufficient in a way that bites. Without (1) the TLS
// handshake fails before a request ever reaches the app. Without (2) we would
// flip storeOrigin() onto a host we don't serve and publish it in every
// canonical, sitemap entry and og:url. Without (3) the certificate exists but
// nothing presents it. The old flow checked none of them — it read Resend's
// DKIM/SPF result, which proves the domain can send MAIL.
// ---------------------------------------------------------------------------

export interface DomainConnectionState {
  domain: string | null;
  verified: boolean;
  /** Merchant is entitled to use this feature right now. */
  allowed: boolean;
  /** Custom domains are configured for this environment at all. */
  available: boolean;
  /** Records the merchant still needs to add. */
  records: Array<{
    type: string;
    name: string;
    fqdn: string;
    value: string;
    purpose: string;
  }>;
  certificateState: string | null;
  message?: string;
}

/**
 * Everything the settings page needs, in one call.
 *
 * Read-only and side-effect free apart from provisioning progress, which is
 * idempotent — safe to hit on every page load.
 */
export async function getDomainConnectionState(): Promise<DomainConnectionState> {
  const access = await getViewerAccess();
  const cfg = getCertConfig();
  const empty: DomainConnectionState = {
    domain: null,
    verified: false,
    allowed: false,
    available: !!cfg,
    records: [],
    certificateState: null,
  };
  if (!access?.can(DOMAIN_SECTION, "view")) return empty;

  const storeId = await getActingStoreId();
  const { allowed } = await storeAllowsCustomDomain(storeId);
  const row = await readStoreDomainRow(storeId).catch(() => undefined);
  const domain = row?.custom_domain ?? null;
  const settings = (row?.settings as Record<string, unknown>) ?? {};
  const verified = settings.custom_domain_verified === true;

  if (!domain || !cfg) return { ...empty, domain, verified, allowed };

  // Routing record is known without any network call; the challenge record
  // needs the authorization, which verifyDomain() refreshes.
  const records = routingRecords(domain, cfg.loadBalancerIp).map((r) => ({
    type: r.type,
    name: r.name,
    fqdn: r.fqdn,
    value: r.value,
    purpose: r.purpose as string,
  }));
  const challenge = settings.domain_challenge as
    | { name: string; value: string }
    | undefined;
  if (challenge?.name && !verified) {
    records.push({
      type: "CNAME",
      name: dnsRecordName(challenge.name, domain),
      fqdn: challenge.name,
      value: challenge.value,
      purpose: "certificate",
    });
  }

  return {
    domain,
    verified,
    allowed,
    available: true,
    records,
    certificateState: (settings.domain_cert_state as string) ?? null,
  };
}

/**
 * Advance the domain toward serving, and report what is still outstanding.
 *
 * Idempotent end to end: provisioning adopts existing resources, the DNS check
 * is a read, and the settings write is a no-op when nothing changed. Calling
 * this twice concurrently costs two API round-trips and converges on the same
 * state — which is what makes it safe for a retrying background job.
 */
export async function verifyDomain(): Promise<DomainResult> {
  if (!(await getManagerUserId(DOMAIN_SECTION))) {
    return { error: "You don't have permission to manage domain settings." };
  }

  const storeId = await getActingStoreId();
  const { allowed } = await storeAllowsCustomDomain(storeId);
  if (!allowed) return { error: UPGRADE_MESSAGE };

  const cfg = getCertConfig();
  if (!cfg) return { error: "Custom domains aren't configured." };

  const row = await readStoreDomainRow(storeId).catch(() => undefined);
  const domain = row?.custom_domain;
  if (!domain) return { error: "Add a domain first." };

  const settings = ((row?.settings as Record<string, unknown>) ?? {}) as Record<
    string,
    unknown
  >;

  // (1) + (3): certificate issued and attached. Idempotent.
  const prov = await ensureProvisioned(domain);

  // Persist the challenge record even when we're not done, so the merchant can
  // see what to add without re-running provisioning to find out.
  const next: Record<string, unknown> = { ...settings };
  if (prov.challenge) next.domain_challenge = prov.challenge;
  next.domain_cert_state = prov.certificateState;

  if (!prov.ready) {
    await saveDomainSettings(storeId, next);

    // Certificate Manager's PROVISIONING state does not explain a misplaced
    // record. Check the exact name so registrar UIs that append the zone (for
    // example GoDaddy) get an immediately actionable correction.
    if (!prov.error && prov.challenge) {
      const cname = await checkCnameTarget(
        prov.challenge.name,
        prov.challenge.value,
      );
      if (!cname.matches) {
        const relativeName = dnsRecordName(prov.challenge.name, domain);
        return {
          error:
            cname.found.length > 0
              ? `${cname.error} Update it to ${prov.challenge.value}.`
              : `We couldn't find the certificate CNAME at ${prov.challenge.name}. In your DNS provider, enter ${relativeName} as the Name (not the full domain) and ${prov.challenge.value} as the Value.`,
        };
      }
    }

    return {
      error:
        prov.error ??
        "Certificate isn't issued yet. Add the DNS records shown, then check again — this usually takes a few minutes.",
    };
  }

  // (2): it actually points at us. Checked AFTER the certificate, because the
  // certificate is the slow part and there is no sense reporting a routing
  // problem the merchant would have to fix twice.
  const dns = await checkDomainPointsTo(domain, cfg.loadBalancerIp);
  if (!dns.pointsToUs) {
    await saveDomainSettings(storeId, next);
    return { error: dns.error ?? "This domain doesn't point to us yet." };
  }

  // All three hold.
  next.custom_domain_verified = true;
  delete next.domain_challenge;
  await saveDomainSettings(storeId, next);

  if (settings.custom_domain_verified !== true) {
    emitEvent({
      type: "platform.domain_verified",
      storeId,
      actor: { type: "system" },
      subject: { type: "store", id: storeId, label: domain },
      payload: { domain },
    });
  }

  // Ownership verification and sitemap registration are slower, independent
  // Google API calls. Start them now without holding the merchant's DNS check
  // open; the daily seo-refresh job retries every incomplete attempt.
  after(() => ensureGoogleCoverageForStore(storeId));

  revalidateTag(STORE_TAG, "max");
  return { success: true };
}

/** Disconnect: stop serving, then release the billable resources. */
export async function disconnectDomain(): Promise<DomainResult> {
  if (!(await getManagerUserId(DOMAIN_SECTION))) {
    return { error: "You don't have permission to manage domain settings." };
  }
  const storeId = await getActingStoreId();
  const row = await readStoreDomainRow(storeId).catch(() => undefined);
  const domain = row?.custom_domain;
  if (!domain) return { success: true };

  const settings = ((row?.settings as Record<string, unknown>) ?? {}) as Record<
    string,
    unknown
  >;
  const next = { ...settings };
  delete next.custom_domain_verified;
  delete next.domain_challenge;
  delete next.domain_cert_state;
  for (const key of GOOGLE_INDEXING_SETTINGS_KEYS) delete next[key];

  // Stop serving FIRST. If deprovisioning then fails we have a leftover
  // certificate (visible in logs, costs cents); the other order would leave the
  // store advertising a domain whose certificate we just deleted.
  try {
    await withService((db) =>
      db
        .update(stores)
        .set({ customDomain: null, settings: next })
        .where(eq(stores.id, storeId)),
    );
  } catch (err) {
    logError("disconnectDomain (db)", err, { storeId });
    return { error: "Couldn't disconnect the domain. Please try again." };
  }
  revalidateTag(STORE_TAG, "max");

  const gone = await deprovision(domain);
  if (gone.error)
    logError("disconnectDomain (deprovision)", gone.error, { domain });
  return { success: true };
}

async function saveDomainSettings(
  storeId: string,
  settings: Record<string, unknown>,
): Promise<void> {
  await withService((db) =>
    db.update(stores).set({ settings }).where(eq(stores.id, storeId)),
  ).catch((err) => logError("saveDomainSettings", err, { storeId }));
}
