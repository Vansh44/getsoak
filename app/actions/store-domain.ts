"use server";

import { eq } from "drizzle-orm";
import { revalidateTag } from "next/cache";
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
import { validateDomain, routingRecords } from "@/lib/domains/domain";
import {
  ensureProvisioned,
  deprovision,
  getCertConfig,
} from "@/lib/domains/certificates";
import { checkDomainPointsTo } from "@/lib/domains/dns";
import { logError } from "@/lib/observability/logger";

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
 * Retrieves the current custom domain and its resend verification status (if available).
 */
export async function getCustomDomainDetails(): Promise<{
  domain: string | null;
  resendDomainId: string | null;
}> {
  const access = await getViewerAccess();
  if (!access?.can(DOMAIN_SECTION, "view")) {
    return { domain: null, resendDomainId: null };
  }

  const storeId = await getActingStoreId();
  let row: Awaited<ReturnType<typeof readStoreDomainRow>> | undefined;
  try {
    row = await readStoreDomainRow(storeId);
  } catch (err) {
    console.error("getCustomDomainDetails:", err);
  }

  const settings = (row?.settings as Record<string, unknown>) ?? {};
  return {
    domain: row?.custom_domain ?? null,
    resendDomainId: (settings.resend_domain_id as string) ?? null,
  };
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
  const oldResendId = settings.resend_domain_id as string | undefined;

  const resend = getResend();

  // 2. Remove old domain from resend if one exists and we have resend enabled
  if (oldResendId && resend) {
    try {
      await resend.domains.remove(oldResendId);
    } catch (e) {
      console.warn("Failed to remove old domain from Resend:", e);
    }
  }

  // 3. Register new domain with Resend (if a new one is provided)
  let newResendId: string | null = null;
  if (cleanDomain && resend) {
    try {
      const { data, error } = await resend.domains.create({
        name: cleanDomain,
      });
      if (error) {
        return { error: `Resend error: ${error.message}` };
      }
      if (data) {
        newResendId = data.id;
      }
    } catch (e: unknown) {
      const msg =
        e instanceof Error ? e.message : "Failed to create domain on Resend.";
      return { error: msg };
    }
  } else if (cleanDomain && !resend) {
    return { error: "Resend API key is not configured." };
  }

  // 4. Update the DB
  const newSettings = { ...settings };
  if (newResendId) {
    newSettings.resend_domain_id = newResendId;
  } else {
    delete newSettings.resend_domain_id;
  }
  // A freshly set/changed domain is unproven until Resend re-verifies its DNS,
  // so clear both verification flags — they gate storefront routing (custom_domain_verified)
  // and email sending (resend_domain_verified) and must not carry over.
  delete newSettings.custom_domain_verified;
  delete newSettings.resend_domain_verified;

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
 * Gets the current status and DNS records for the domain from Resend.
 */
export async function getResendDomainStatus(
  resendDomainId: string,
): Promise<{ status?: DomainStatus; error?: string }> {
  const access = await getViewerAccess();
  if (!access?.can(DOMAIN_SECTION, "view")) {
    return { error: "Unauthorized." };
  }

  const resend = getResend();
  if (!resend) return { error: "Resend API key not configured." };

  try {
    const { data, error } = await resend.domains.get(resendDomainId);
    if (error) return { error: error.message };
    if (!data) return { error: "Domain not found on Resend." };

    return { status: data as DomainStatus };
  } catch (e: unknown) {
    const msg =
      e instanceof Error ? e.message : "Failed to fetch domain status.";
    return { error: msg };
  }
}

/**
 * Persist whether the current store's custom domain is verified. Flips the
 * routing gate (custom_domain_verified) and the email-sender gate
 * (resend_domain_verified) together, and only writes when the value changed.
 */
async function syncDomainVerified(isVerified: boolean): Promise<void> {
  const storeId = await getActingStoreId();

  let store: Awaited<ReturnType<typeof readStoreDomainRow>> | undefined;
  try {
    store = await readStoreDomainRow(storeId);
  } catch (err) {
    console.error("syncDomainVerified read:", err);
    return;
  }

  // Only meaningful for a store that actually has a custom domain set.
  if (!store?.custom_domain) return;

  const settings = ((store.settings as Record<string, unknown>) ??
    {}) as Record<string, unknown>;
  if (settings.custom_domain_verified === isVerified) return;

  try {
    await withService((db) =>
      db
        .update(stores)
        .set({
          settings: {
            ...settings,
            custom_domain_verified: isVerified,
            resend_domain_verified: isVerified,
          },
        })
        .where(eq(stores.id, storeId)),
    );
  } catch (err) {
    console.error("syncDomainVerified:", err);
    return;
  }

  // Only on the transition INTO verified — a re-check that comes back verified
  // again short-circuits above, so this can't repeat.
  if (isVerified) {
    emitEvent({
      type: "platform.domain_verified",
      storeId,
      actor: { type: "system" },
      subject: { type: "store", id: storeId, label: store.custom_domain },
      payload: { domain: store.custom_domain },
    });
  }

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
      await syncDomainVerified((data as DomainStatus).status === "verified");
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
    value: r.value,
    purpose: r.purpose as string,
  }));
  const challenge = settings.domain_challenge as
    | { name: string; value: string }
    | undefined;
  if (challenge?.name && !verified) {
    records.push({
      type: "CNAME",
      name: challenge.name,
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
