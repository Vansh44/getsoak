import "server-only";

// ---------------------------------------------------------------------------
// Certificate Manager — provisioning TLS for one merchant domain.
//
// Three resources per domain, created in dependency order:
//
//   1. DnsAuthorization   issues a _acme-challenge CNAME the merchant adds.
//                         Also serves as PROOF OF OWNERSHIP: a certificate
//                         cannot be issued without control of the domain's DNS,
//                         so there is no separate ownership token to invent.
//   2. Certificate        managed, referencing (1). Goes ACTIVE once Google
//                         sees the challenge record and issues.
//   3. CertificateMapEntry  attaches (2) to the load balancer's certificate map
//                         under the merchant's hostname. Until this exists, the
//                         certificate is issued but nothing serves it.
//
// IDEMPOTENCY IS THE WHOLE DESIGN. Every step is create-or-adopt: names are
// deterministic (naming.ts), so a retried job, a redeployed revision or an
// impatient merchant clicking Verify twice recomputes the same name, gets
// ALREADY_EXISTS, and adopts what is there. Nothing here creates a duplicate,
// and duplicates would be the expensive kind of bug — certificates are billed
// per certificate per month beyond the free 100.
//
// KEY TYPE. Left at the API default (RSA-2048 / ECDSA P-256). RSA-3072 and
// RSA-4096 carry a per-connection charge that scales with TRAFFIC rather than
// with domain count, which is the one line item here that could actually grow
// into real money. Do not set a larger key type without pricing it first.
// ---------------------------------------------------------------------------

import { GoogleAuth } from "google-auth-library";
import { logError, logInfo } from "@/lib/observability/logger";
import { resourceId, assertManaged } from "./naming";

const API = "https://certificatemanager.googleapis.com/v1";
const LOCATION = "global";

export interface CertConfig {
  projectId: string;
  /** Certificate map attached to the HTTPS proxy (env-specific by name). */
  certificateMap: string;
  /** Reserved load balancer IP merchants point their A record at. */
  loadBalancerIp: string;
}

/**
 * Configuration, or null when this environment isn't set up for custom domains.
 *
 * Null rather than throwing: a deployment without these variables should
 * degrade to "custom domains unavailable" instead of 500ing the settings page.
 * Every caller treats null as unavailable.
 */
export function getCertConfig(): CertConfig | null {
  const projectId =
    process.env.DOMAIN_GCP_PROJECT_ID ?? process.env.GCP_PROJECT_ID ?? "";
  const certificateMap = process.env.DOMAIN_CERT_MAP ?? "";
  const loadBalancerIp = process.env.DOMAIN_LB_IP ?? "";
  if (!projectId || !certificateMap || !loadBalancerIp) return null;
  return { projectId, certificateMap, loadBalancerIp };
}

let authClient: GoogleAuth | null = null;
function auth(): GoogleAuth {
  authClient ??= new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  return authClient;
}

interface ApiResult<T> {
  ok: boolean;
  data?: T;
  /** HTTP status, so callers can distinguish 409 (exists) from real failure. */
  status?: number;
  error?: string;
}

async function api<T>(
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<ApiResult<T>> {
  try {
    const client = await auth().getClient();
    const token = await client.getAccessToken();
    const res = await fetch(`${API}/${path}`, {
      method: init?.method ?? "GET",
      headers: {
        authorization: `Bearer ${token.token ?? ""}`,
        "content-type": "application/json",
      },
      body: init?.body ? JSON.stringify(init.body) : undefined,
      // Never let a slow control-plane call hold a merchant's request open.
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!res.ok) {
      const err = json.error as { message?: string } | undefined;
      return { ok: false, status: res.status, error: err?.message ?? text };
    }
    return { ok: true, status: res.status, data: json as T };
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error
          ? err.message
          : "certificate manager request failed",
    };
  }
}

const parent = (cfg: CertConfig) =>
  `projects/${cfg.projectId}/locations/${LOCATION}`;

/**
 * Create, or adopt if it already exists.
 *
 * This is the idempotency primitive the whole module rests on. 409 is not an
 * error — it is the expected result of the second run — so it falls through to
 * a GET of the same name. Anything else is a real failure.
 *
 * Note the create is fire-and-read rather than awaiting the long-running
 * operation: Certificate Manager creates are LROs, but the resource exists as
 * soon as the call is accepted, and every caller here polls state separately.
 */
async function createOrAdopt<T>(
  collection: string,
  id: string,
  body: unknown,
  idParam: string,
): Promise<ApiResult<T>> {
  const created = await api<T>(`${collection}?${idParam}=${id}`, {
    method: "POST",
    body,
  });
  if (created.ok) {
    return api<T>(`${collection}/${id}`);
  }
  if (created.status === 409) {
    // Already provisioned — the retry case, and the normal one.
    return api<T>(`${collection}/${id}`);
  }
  return created;
}

export interface DnsChallenge {
  /** Record name the merchant must create, e.g. _acme-challenge.shop.acme.com */
  name: string;
  /** CNAME target Google issues for it. */
  value: string;
}

export interface ProvisionState {
  /** All three resources exist and the certificate is serving. */
  ready: boolean;
  /** The CNAME the merchant still has to add (null once issued). */
  challenge: DnsChallenge | null;
  /** Raw certificate provisioning state, for display + debugging. */
  certificateState: string | null;
  /** True once the map entry exists — nothing serves the cert before that. */
  attached: boolean;
  error?: string;
}

interface DnsAuthResource {
  name?: string;
  dnsResourceRecord?: { name?: string; type?: string; data?: string };
}
interface CertResource {
  name?: string;
  managed?: { state?: string; provisioningIssue?: { reason?: string } };
}

/**
 * Ensure the DNS authorization exists and return the challenge record.
 *
 * Called FIRST and on its own, because the merchant cannot do anything until
 * they have this record to add — there is no point creating a certificate that
 * will sit failing until they do.
 */
export async function ensureDnsAuthorization(
  domain: string,
): Promise<{ challenge?: DnsChallenge; error?: string }> {
  const cfg = getCertConfig();
  if (!cfg) return { error: "Custom domains aren't configured." };

  const id = resourceId("auth", domain);
  const res = await createOrAdopt<DnsAuthResource>(
    `${parent(cfg)}/dnsAuthorizations`,
    id,
    { domain },
    "dnsAuthorizationId",
  );
  if (!res.ok || !res.data) {
    logError("ensureDnsAuthorization", res.error, { domain });
    return { error: "Couldn't start domain verification. Please try again." };
  }

  const rec = res.data.dnsResourceRecord;
  if (!rec?.name || !rec.data) {
    return { error: "Verification record isn't ready yet. Try again shortly." };
  }
  // Google returns a trailing dot; DNS UIs generally don't want one.
  const strip = (s: string) => s.replace(/\.$/, "");
  return { challenge: { name: strip(rec.name), value: strip(rec.data) } };
}

/**
 * Drive the domain toward "serving", and report exactly how far it got.
 *
 * Safe to call repeatedly — that is the point. It is the single entry point for
 * both the merchant pressing Verify and any background retry, and it makes at
 * most one step of forward progress per call, so calling it in a loop converges
 * rather than thrashing.
 */
export async function ensureProvisioned(
  domain: string,
): Promise<ProvisionState> {
  const cfg = getCertConfig();
  if (!cfg) {
    return {
      ready: false,
      challenge: null,
      certificateState: null,
      attached: false,
      error: "Custom domains aren't configured.",
    };
  }

  // 1. Authorization (idempotent) — also the ownership proof.
  const authRes = await ensureDnsAuthorization(domain);
  if (authRes.error || !authRes.challenge) {
    return {
      ready: false,
      challenge: null,
      certificateState: null,
      attached: false,
      error: authRes.error,
    };
  }
  const authId = resourceId("auth", domain);

  // 2. Certificate (idempotent), referencing the authorization by name.
  const certId = resourceId("cert", domain);
  const certRes = await createOrAdopt<CertResource>(
    `${parent(cfg)}/certificates`,
    certId,
    {
      managed: {
        domains: [domain],
        dnsAuthorizations: [`${parent(cfg)}/dnsAuthorizations/${authId}`],
      },
    },
    "certificateId",
  );
  if (!certRes.ok || !certRes.data) {
    logError("ensureProvisioned (certificate)", certRes.error, { domain });
    return {
      ready: false,
      challenge: authRes.challenge,
      certificateState: null,
      attached: false,
      error: "Couldn't request a certificate. Please try again.",
    };
  }

  const state = certRes.data.managed?.state ?? null;
  if (state !== "ACTIVE") {
    // Still waiting on the merchant's CNAME (or on issuance). Keep showing the
    // record — that is the action they need to take.
    return {
      ready: false,
      challenge: authRes.challenge,
      certificateState: state,
      attached: false,
    };
  }

  // 3. Map entry (idempotent). Only now — an entry pointing at a certificate
  // that isn't ACTIVE would attach a hostname the load balancer cannot serve.
  const entryId = resourceId("entry", domain);
  const entryRes = await createOrAdopt<{ name?: string }>(
    `${parent(cfg)}/certificateMaps/${cfg.certificateMap}/certificateMapEntries`,
    entryId,
    {
      hostname: domain,
      certificates: [`${parent(cfg)}/certificates/${certId}`],
    },
    "certificateMapEntryId",
  );
  if (!entryRes.ok) {
    logError("ensureProvisioned (map entry)", entryRes.error, { domain });
    return {
      ready: false,
      challenge: null,
      certificateState: state,
      attached: false,
      error: "Certificate issued, but attaching it failed. Please try again.",
    };
  }

  logInfo("custom domain provisioned", { domain, certificateState: state });
  return {
    ready: true,
    challenge: null,
    certificateState: state,
    attached: true,
  };
}

/**
 * Remove everything provisioned for a domain, in reverse dependency order.
 *
 * Every delete passes assertManaged first. That guard — not IAM — is what stops
 * this from being able to remove `prod-apex` or `prod-wildcard`, which share
 * the certificate map and carry TLS for the whole platform.
 *
 * Best effort and order-tolerant: a resource that is already gone is a success,
 * so a half-finished earlier cleanup completes rather than wedging.
 */
export async function deprovision(domain: string): Promise<{ error?: string }> {
  const cfg = getCertConfig();
  if (!cfg) return {};

  const targets = [
    `${parent(cfg)}/certificateMaps/${cfg.certificateMap}/certificateMapEntries/${resourceId("entry", domain)}`,
    `${parent(cfg)}/certificates/${resourceId("cert", domain)}`,
    `${parent(cfg)}/dnsAuthorizations/${resourceId("auth", domain)}`,
  ];

  let failed = false;
  for (const target of targets) {
    assertManaged(target);
    const res = await api(target, { method: "DELETE" });
    // 404 means someone already cleaned it up — not a failure.
    if (!res.ok && res.status !== 404) {
      failed = true;
      logError("deprovision", res.error, { domain, target });
    }
  }
  // Deliberately vague to the merchant, specific in the logs: a leftover
  // certificate keeps billing, so this needs to be visible to an operator.
  return failed
    ? { error: "Some certificate resources couldn't be removed." }
    : {};
}
