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
  const cleanDomain = clean(domainName);

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
