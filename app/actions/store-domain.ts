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
import {
  validateDomain,
  routingRecords,
  dnsRecordName,
} from "@/lib/domains/domain";
import { deprovision, getCertConfig } from "@/lib/domains/certificates";
import {
  reconcileDomainForStore,
  readStoreDomainRow,
  storeAllowsCustomDomain,
  UPGRADE_MESSAGE,
} from "@/lib/domains/reconcile";
import { logError } from "@/lib/observability/logger";
import { removeAuthorizedDomain } from "@/lib/auth/authorized-domains";
import { ROOT_DOMAIN } from "@/lib/store/host";
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
  delete newSettings.domain_challenges;
  delete newSettings.domain_cert_state;
  delete newSettings.domain_cert_issue;
  delete newSettings.domain_extra_hosts;
  delete newSettings.domain_health_checked_at;
  delete newSettings.domain_health_failures;
  delete newSettings.domain_reissued;
  delete newSettings.domain_pending_since;
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

  // ★ RELEASE THE DOMAIN THEY JUST REPLACED. `deprovision` was wired only to
  // disconnectDomain, so CHANGING a domain silently orphaned the old one's
  // certificate, authorization and map entry. Two costs: a certificate nothing
  // references keeps billing (and only shows up on an invoice), and the stale map
  // entry leaves the load balancer still terminating TLS for a hostname this
  // store no longer claims — so it resolves, handshakes, and then 404s as an
  // unknown store. This is how the orphaned www.wholesip.com resources appeared.
  //
  // AFTER the write and best-effort: the merchant's new domain is already saved,
  // and a cleanup failure must not fail the change they asked for.
  const previous = store?.custom_domain ?? null;
  if (previous && previous !== cleanDomain) {
    after(async () => {
      const gone = await deprovision(previous);
      if (gone.error) {
        logError("updateCustomDomain (deprovision old)", gone.error, {
          previous,
        });
      }
      // Stop trusting it for Google sign-in too. Leaving it listed means a
      // domain we no longer serve can still host a popup sign-in against our
      // Identity Platform project — which is precisely what the authorized-domain
      // check exists to prevent, and matters most if someone else later buys it.
      const deauth = await removeAuthorizedDomain(previous, ROOT_DOMAIN);
      if (deauth.error) {
        logError("updateCustomDomain (deauthorize old)", deauth.error, {
          previous,
        });
      }
    });
  }
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
  /** Companion hosts also serving (the www/apex counterpart). */
  extraHosts: string[];
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
    extraHosts: [],
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
  // One challenge CNAME PER HOST — the www certificate is validated separately,
  // so a single record would silently be half the instructions. `domain_challenges`
  // is the current shape; `domain_challenge` is the pre-www single-record form,
  // still read so a store written by the previous deploy keeps showing its record.
  const challenges = Array.isArray(settings.domain_challenges)
    ? (settings.domain_challenges as Array<{ name?: string; value?: string }>)
    : [settings.domain_challenge as { name?: string; value?: string }].filter(
        Boolean,
      );
  for (const challenge of challenges) {
    if (!challenge?.name || !challenge.value) continue;
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
    extraHosts: Array.isArray(settings.domain_extra_hosts)
      ? (settings.domain_extra_hosts as string[])
      : [],
  };
}

/**
 * Advance the domain toward serving, and report what is still outstanding.
 *
 * A thin gate now: the work lives in `reconcileDomainForStore` so the cron
 * backstop (`/api/cron/domain-reconcile`) runs the IDENTICAL logic. It has to be
 * shared rather than reimplemented — the previous single-caller design is what
 * made every domain depend on the merchant keeping this tab open, and a second
 * hand-written copy would drift the moment one of the three conditions changed.
 */
export async function verifyDomain(): Promise<DomainResult> {
  if (!(await getManagerUserId(DOMAIN_SECTION))) {
    return { error: "You don't have permission to manage domain settings." };
  }

  const storeId = await getActingStoreId();
  const res = await reconcileDomainForStore(storeId);
  if (!res.verified)
    return { error: res.error ?? "This domain isn't live yet." };

  if (res.becameLive) {
    // TWO events, one moment: the merchant milestone and the operator console
    // line. Same precedent as store.created / platform.store_created.
    emitEvent({
      type: "store.domain_live",
      storeId,
      actor: { type: "system" },
      subject: { type: "store", id: storeId, label: res.domain ?? "" },
      payload: {
        domain: res.domain ?? "",
        store_url: `https://${res.domain ?? ""}`,
        extra_hosts: (res.extraHosts ?? []).join(", "),
      },
    });
    emitEvent({
      type: "platform.domain_verified",
      storeId,
      actor: { type: "system" },
      subject: { type: "store", id: storeId, label: res.domain ?? "" },
      payload: { domain: res.domain ?? "" },
    });
    // Ownership verification and sitemap registration are slower, independent
    // Google API calls. Start them now without holding the merchant's DNS check
    // open; the daily seo-refresh job retries every incomplete attempt.
    after(() => ensureGoogleCoverageForStore(storeId));
  }
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
  delete next.domain_challenges;
  delete next.domain_cert_state;
  delete next.domain_cert_issue;
  delete next.domain_extra_hosts;
  delete next.domain_health_checked_at;
  delete next.domain_health_failures;
  delete next.domain_reissued;
  delete next.domain_pending_since;
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

  // Same reasoning as a domain change: an entry for a host we no longer serve is
  // standing permission we do not need. Guarded so it can never strip the
  // platform's own entry (see planRemove).
  const deauth = await removeAuthorizedDomain(domain, ROOT_DOMAIN);
  if (deauth.error)
    logError("disconnectDomain (deauthorize)", deauth.error, { domain });
  return { success: true };
}
