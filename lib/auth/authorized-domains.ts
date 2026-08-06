import "server-only";

// ---------------------------------------------------------------------------
// Keeping merchant custom domains in Identity Platform's authorized-domain list.
//
// ★ WHY. `signInWithPopup` refuses to run on an origin that is not in the
// project's `authorizedDomains`, failing with `auth/unauthorized-domain` BEFORE
// any popup opens. The platform's own hosts are covered by ONE `storemink.com`
// entry (see `entryCovers` — an entry authorises every subdomain beneath it, so
// there is no bug on `{slug}.storemink.com`), but a merchant's own registrable
// domain is not covered by anything — so "Continue with Google" on
// `xyz.com/auth/login` was dead while email + password worked, because password
// sign-in is a direct REST call and is not origin-gated at all.
//
// Firebase does NOT accept wildcards in this list, so there is no catch-all to
// configure once. The list has to be maintained per domain, which is what this
// module does at the moment a domain verifies.
//
// ★ BEST EFFORT, ALWAYS. Google sign-in is one of two ways in. A failure here
// must never stop a domain going live or block the sweep — the merchant simply
// uses their password until the next reconcile retries.
// ---------------------------------------------------------------------------

import { GoogleAuth } from "google-auth-library";
import { getDomain } from "tldts";
import { logError, logInfo, logWarn } from "@/lib/observability/logger";

const API = "https://identitytoolkit.googleapis.com/admin/v2";

/**
 * Entries we must never remove, whatever a caller passes.
 *
 * Removing `storemink.com` would break Google sign-in for the platform AND every
 * store subdomain in one call — the same class of hazard `assertManaged` guards
 * in the certificate map, and worth the same explicit list.
 */
const PROTECTED = [/^localhost$/i, /\.firebaseapp\.com$/i, /\.web\.app$/i];

function isProtected(entry: string, rootDomain: string): boolean {
  const e = entry.trim().toLowerCase();
  if (e === rootDomain.toLowerCase()) return true;
  return PROTECTED.some((re) => re.test(e));
}

/**
 * Does an authorized-domain ENTRY cover a given host?
 *
 * ★ A FAITHFUL MIRROR of `matchDomain` in @firebase/auth (v12):
 *
 *     new RegExp('^(.+\\.' + escaped + '|' + escaped + ')$', 'i')
 *
 * i.e. an entry authorises itself AND every subdomain beneath it. That single
 * fact is why the platform needs only `storemink.com` listed to cover every
 * `{slug}.storemink.com`, and why ONE entry per merchant covers their apex, their
 * www form and anything else they point at us. Keep this in step with the SDK: if
 * the rule ever tightens, this becomes an over-estimate and we would silently
 * skip entries that are genuinely needed.
 */
export function entryCovers(entry: string, host: string): boolean {
  const e = entry.trim().toLowerCase().replace(/\.+$/, "");
  const h = host.trim().toLowerCase().replace(/\.+$/, "");
  if (!e || !h) return false;
  // Extension origins never match a web host.
  if (e.startsWith("chrome-extension://")) return false;
  // An IP entry has to be exact — there are no subdomains of an address.
  if (/^\d+(\.\d+)+$/.test(e)) return h === e;
  const escaped = e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^(.+\\.${escaped}|${escaped})$`, "i").test(h);
}

/**
 * The entry to add for a connected domain.
 *
 * The REGISTRABLE domain, not the exact host: a merchant may connect either
 * `xyz.com` or `www.xyz.com`, and we serve both (§30). Listing `xyz.com` covers
 * the apex, the www form and any future subdomain in ONE entry — whereas listing
 * `www.xyz.com` would leave the apex unauthorized, which is the more common
 * address of the two.
 */
export function entryForDomain(domain: string): string | null {
  const host = domain.trim().toLowerCase().replace(/\.+$/, "");
  if (!host) return null;
  return getDomain(host) ?? host;
}

/** Append an entry unless something already present covers it. */
export function planAdd(
  current: string[],
  domain: string,
): { next: string[]; changed: boolean; entry: string | null } {
  const entry = entryForDomain(domain);
  if (!entry) return { next: current, changed: false, entry: null };
  // Coverage, not equality: `xyz.com` present means `www.xyz.com` needs nothing,
  // and re-adding it would grow a capped list for no benefit.
  if (current.some((e) => entryCovers(e, entry))) {
    return { next: current, changed: false, entry };
  }
  return { next: [...current, entry], changed: true, entry };
}

/**
 * Drop the entry for a domain we no longer serve.
 *
 * Exact match only, and never a protected entry. Removing by COVERAGE here would
 * be a disaster: disconnecting `foo.storemink.com`-shaped input could match and
 * delete the platform's own `storemink.com`.
 */
export function planRemove(
  current: string[],
  domain: string,
  rootDomain: string,
): { next: string[]; changed: boolean } {
  const entry = entryForDomain(domain);
  if (!entry || isProtected(entry, rootDomain)) {
    return { next: current, changed: false };
  }
  const next = current.filter((e) => e.trim().toLowerCase() !== entry);
  return { next, changed: next.length !== current.length };
}

// --- The API side -----------------------------------------------------------

let authClient: GoogleAuth | null = null;
function auth(): GoogleAuth {
  authClient ??= new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  return authClient;
}

function projectId(): string {
  return (
    process.env.FIREBASE_PROJECT_ID ??
    process.env.DOMAIN_GCP_PROJECT_ID ??
    process.env.GCP_PROJECT_ID ??
    ""
  );
}

async function configRequest<T>(
  method: "GET" | "PATCH",
  project: string,
  body?: unknown,
  query = "",
): Promise<{ ok: boolean; data?: T; error?: string }> {
  try {
    const client = await auth().getClient();
    const token = await client.getAccessToken();
    const res = await fetch(`${API}/projects/${project}/config${query}`, {
      method,
      headers: {
        authorization: `Bearer ${token.token ?? ""}`,
        "content-type": "application/json",
        // The Identity Platform API bills against a quota project. On Cloud Run
        // the attached SA supplies it, but stating it explicitly also makes this
        // work under local ADC, where it is otherwise a 403.
        "x-goog-user-project": project,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!res.ok) {
      const err = json.error as { message?: string } | undefined;
      return { ok: false, error: err?.message ?? text };
    }
    return { ok: true, data: json as T };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "config request failed",
    };
  }
}

/**
 * Warn well before Identity Platform's cap, since hitting it means new merchants
 * silently lose Google sign-in with nothing pointing at the cause.
 */
const LIST_WARN_AT = 150;

/**
 * Make sure `domain` can host Google sign-in. Idempotent.
 *
 * ⚠ READ-MODIFY-WRITE on a project-global list, so two domains verifying in the
 * same second can lose one update. Deliberately not solved with a lock: the loser
 * is retried by the next reconcile, and the cost of the race is one merchant
 * temporarily using a password instead of Google — far cheaper than serialising
 * every domain verification behind shared state.
 */
export async function ensureAuthorizedDomain(
  domain: string,
): Promise<{ added?: boolean; error?: string }> {
  const project = projectId();
  if (!project) return { error: "no Firebase project configured" };

  const read = await configRequest<{ authorizedDomains?: string[] }>(
    "GET",
    project,
  );
  if (!read.ok) return { error: read.error };

  const current = read.data?.authorizedDomains ?? [];
  const plan = planAdd(current, domain);
  if (!plan.changed) return { added: false };

  if (plan.next.length >= LIST_WARN_AT) {
    logWarn("authorized domains list is getting long", {
      count: plan.next.length,
    });
  }

  const write = await configRequest(
    "PATCH",
    project,
    { authorizedDomains: plan.next },
    "?updateMask=authorizedDomains",
  );
  if (!write.ok) {
    logError("ensureAuthorizedDomain", write.error, { domain });
    return { error: write.error };
  }
  logInfo("authorized domain added", { domain, entry: plan.entry });
  return { added: true };
}

/** Drop a domain we no longer serve, so the list can't grow without bound. */
export async function removeAuthorizedDomain(
  domain: string,
  rootDomain: string,
): Promise<{ removed?: boolean; error?: string }> {
  const project = projectId();
  if (!project) return { error: "no Firebase project configured" };

  const read = await configRequest<{ authorizedDomains?: string[] }>(
    "GET",
    project,
  );
  if (!read.ok) return { error: read.error };

  const plan = planRemove(
    read.data?.authorizedDomains ?? [],
    domain,
    rootDomain,
  );
  if (!plan.changed) return { removed: false };

  const write = await configRequest(
    "PATCH",
    project,
    { authorizedDomains: plan.next },
    "?updateMask=authorizedDomains",
  );
  if (!write.ok) {
    logError("removeAuthorizedDomain", write.error, { domain });
    return { error: write.error };
  }
  logInfo("authorized domain removed", { domain });
  return { removed: true };
}
