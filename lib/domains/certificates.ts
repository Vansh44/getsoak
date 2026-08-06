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
import { domainHosts } from "./domain";

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * GET a resource that was just created and may not be readable yet.
 *
 * ★ Certificate Manager creates are LONG-RUNNING OPERATIONS. The POST returns an
 * Operation, not the resource, and the resource is not queryable until that
 * operation completes — so an immediate GET can legitimately 404. This module
 * used to read straight back and treat that 404 as a hard failure, which had a
 * specific and bad consequence: `ensureDnsAuthorization` returned "Couldn't
 * start domain verification" on the FIRST attempt, so nothing persisted
 * `domain_challenge`, so the settings page listed the A record ALONE. The
 * merchant added it, saw no other record to add, and left — and the certificate
 * could never validate, because the one record that proves ownership was never
 * put on screen.
 *
 * `ready` exists for the same reason: a DnsAuthorization can be readable a beat
 * before `dnsResourceRecord` is populated, and a resource without the challenge
 * record in it is no more use to the caller than a 404.
 *
 * Bounded deliberately (~2.8s worst case). This runs inside a merchant's
 * request, and the caller polls anyway — this only has to cover the sub-second
 * window that made the FIRST attempt fail.
 */
async function getEventually<T>(
  path: string,
  ready?: (data: T) => boolean,
  attempts = 4,
): Promise<ApiResult<T>> {
  let last: ApiResult<T> = { ok: false, error: "resource was never read" };
  for (let i = 0; i < attempts; i++) {
    last = await api<T>(path);
    // A real error (403 on IAM, 400 on a bad body) must surface immediately —
    // retrying it just makes the merchant wait longer for the same answer.
    if (!last.ok && last.status !== 404) return last;
    if (last.ok && (!ready || (last.data && ready(last.data)))) return last;
    if (i < attempts - 1) await sleep(400 * (i + 1));
  }
  return last;
}

/**
 * Create, or adopt if it already exists.
 *
 * This is the idempotency primitive the whole module rests on. 409 is not an
 * error — it is the expected result of the second run — so both the created and
 * the already-there case fall through to the same read. Anything else is a real
 * failure.
 */
async function createOrAdopt<T>(
  collection: string,
  id: string,
  body: unknown,
  idParam: string,
  ready?: (data: T) => boolean,
): Promise<ApiResult<T>> {
  const created = await api<T>(`${collection}?${idParam}=${id}`, {
    method: "POST",
    body,
  });
  if (created.ok || created.status === 409) {
    return getEventually<T>(`${collection}/${id}`, ready);
  }
  return created;
}

export interface DnsChallenge {
  /** Record name the merchant must create, e.g. _acme-challenge.shop.acme.com */
  name: string;
  /** CNAME target Google issues for it. */
  value: string;
}

/** How far one hostname got. A domain has one of these per host it serves. */
export interface HostProvision {
  host: string;
  /** All three resources exist and this hostname is serving. */
  ready: boolean;
  /** The CNAME the merchant still has to add for THIS host (null once issued). */
  challenge: DnsChallenge | null;
  /** Raw certificate provisioning state, for display + debugging. */
  certificateState: string | null;
  /** True once the map entry exists — nothing serves the cert before that. */
  attached: boolean;
  /** Why issuance hasn't finished, in words the merchant can act on. */
  diagnosis?: string;
  /** Google's machine-readable cause (CONFIG / CAA / RATE_LIMITED), for logs. */
  failureReason?: string;
  /**
   * When Google last attempted authorization. ISO, absent if it never has.
   * Load-bearing for `decideReissue` — a FAILED verdict is only worth escaping
   * if it predates the DNS fix, and without this there is no way to tell.
   */
  attemptTime?: string;
  error?: string;
}

export interface ProvisionState extends HostProvision {
  /**
   * Every host, PRIMARY FIRST.
   *
   * ★ The top-level fields mirror the PRIMARY host, and that is the whole
   * contract: the domain the merchant typed is what gates going live, and its
   * apex/www companion is strictly best-effort. Gating on both would mean a
   * merchant who added one A record instead of two has a working certificate for
   * the address they asked for and a store that still refuses to serve it —
   * trading a real outage for a cosmetic one.
   */
  hosts: HostProvision[];
}

interface DnsAuthResource {
  name?: string;
  dnsResourceRecord?: { name?: string; type?: string; data?: string };
}

/** The subset of the managed-certificate resource we act on. */
export interface ManagedCert {
  state?: string;
  provisioningIssue?: { reason?: string; details?: string };
  authorizationAttemptInfo?: Array<{
    domain?: string;
    state?: string;
    failureReason?: string;
    details?: string;
    /**
     * ★ WHEN Google last looked — and a FAILED attempt is very often STALE.
     * It describes a check made BEFORE the merchant fixed their DNS, and it
     * keeps saying FAILED until Google re-attempts on its own schedule. Without
     * this in the logs, a fixed domain and a broken one are indistinguishable:
     * wholesip.com sat reading `CONFIG / CNAME_MISMATCH` from an attempt 94
     * minutes older than the correct records that were already published.
     */
    attemptTime?: string;
    /**
     * Richer than `failureReason`, and what the live API actually returns —
     * `issues: ["CNAME_MISMATCH"]` plus the exact record Google wants. The REST
     * reference documents `details` instead; this is present in practice, so
     * both are declared and neither is relied on.
     */
    troubleshooting?: {
      issues?: string[];
      cname?: { name?: string; expectedData?: string };
    };
  }>;
}
interface CertResource {
  name?: string;
  managed?: ManagedCert;
}

/**
 * Turn Google's provisioning fields into something a merchant can act on.
 *
 * ★ THIS IS THE FIELD THAT WAS BEING THROWN AWAY. The interface declared
 * `provisioningIssue.reason` and nothing ever read it, and
 * `authorizationAttemptInfo` — the PER-DOMAIN cause, which is the only field
 * that distinguishes the three real failure modes — wasn't declared at all. So
 * every stalled domain produced the same sentence ("Certificate isn't issued
 * yet. Add the DNS records shown…") whether the CNAME was genuinely missing, or
 * a CAA record was forbidding Google outright, or the domain had hit a CA rate
 * limit. Two of those three are NOT fixed by adding the records shown, and the
 * merchant had no way to find that out — nor did an operator reading the logs.
 *
 * Pure, so each mapping is testable without touching GCP.
 */
export function explainCertificate(managed: ManagedCert | undefined): {
  diagnosis?: string;
  failureReason?: string;
  attemptTime?: string;
} {
  if (!managed) return {};

  // Prefer the per-domain attempt: it carries the specific cause. The
  // top-level provisioningIssue only ever says "AUTHORIZATION_ISSUE".
  const failed = managed.authorizationAttemptInfo?.find(
    (a) => a.state === "FAILED" || a.failureReason,
  );
  const reason = failed?.failureReason ?? managed.provisioningIssue?.reason;
  const details = failed?.details ?? managed.provisioningIssue?.details;
  // Carried on EVERY branch below, including the ones with no diagnosis: the
  // reissue decision needs it precisely in the CONFIG case, which is the branch
  // that deliberately says nothing to the merchant.
  const attemptTime = failed?.attemptTime;
  const withTime = (r: { diagnosis?: string; failureReason?: string }) => ({
    ...r,
    ...(attemptTime ? { attemptTime } : {}),
  });

  switch (reason) {
    case "CAA":
      return withTime({
        failureReason: reason,
        // The one failure the DNS records on screen cannot fix.
        diagnosis:
          "This domain has a CAA record that doesn't permit Google to issue certificates. " +
          'Add a CAA record with the value 0 issue "pki.goog", or remove the existing CAA records, then check again.',
      });
    case "RATE_LIMITED":
      return withTime({
        failureReason: reason,
        diagnosis:
          "Google has temporarily rate-limited certificate requests for this domain. " +
          "This clears by itself — try again in an hour. Nothing needs changing.",
      });
    case "CONFIG":
    case "AUTHORIZATION_ISSUE":
      // The common case, and the one the caller's own CNAME check explains far
      // better (it names the record and what it currently points at), so no
      // diagnosis here — only the reason, for the logs.
      return withTime({ failureReason: reason });
    default:
      return reason
        ? withTime({ failureReason: reason, diagnosis: details || undefined })
        : {};
  }
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
    // Not readable-yet is not good enough: without the challenge record in hand
    // there is nothing to show the merchant, which is the whole point of this
    // call. Wait the extra beat rather than reporting a false failure.
    (d) => !!d.dnsResourceRecord?.name && !!d.dnsResourceRecord?.data,
  );
  if (!res.ok || !res.data) {
    logError("ensureDnsAuthorization", res.error, {
      domain,
      status: res.status,
    });
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
 * Drive ONE hostname through all three steps, and report exactly how far it got.
 *
 * Safe to call repeatedly — that is the point. Every step adopts what is already
 * there, so it makes at most one step of forward progress per call and calling it
 * in a loop converges rather than thrashing.
 *
 * ★ A FULL TRIPLE PER HOSTNAME, not one certificate with two SANs. A managed
 * certificate's `domains` list is IMMUTABLE, so widening an existing single-host
 * certificate is impossible — `createOrAdopt` would 409 and adopt the old
 * narrow one, and the www map entry would then point at a certificate that does
 * not cover www. Per-host triples keep every already-provisioned resource
 * byte-identical in name (nothing to migrate, live domains keep their
 * certificates) and let each host validate independently, which is what makes
 * the primary able to go live while www is still waiting.
 */
async function provisionHost(
  cfg: CertConfig,
  host: string,
): Promise<HostProvision> {
  const base = {
    host,
    ready: false,
    challenge: null,
    certificateState: null,
    attached: false,
  };

  // 1. Authorization (idempotent) — also the ownership proof.
  const authRes = await ensureDnsAuthorization(host);
  if (authRes.error || !authRes.challenge) {
    return { ...base, error: authRes.error };
  }
  const authId = resourceId("auth", host);

  // 2. Certificate (idempotent), referencing the authorization by name.
  const certId = resourceId("cert", host);
  const certRes = await createOrAdopt<CertResource>(
    `${parent(cfg)}/certificates`,
    certId,
    {
      managed: {
        domains: [host],
        dnsAuthorizations: [`${parent(cfg)}/dnsAuthorizations/${authId}`],
      },
    },
    "certificateId",
  );
  if (!certRes.ok || !certRes.data) {
    logError("provisionHost (certificate)", certRes.error, { host });
    return {
      ...base,
      challenge: authRes.challenge,
      error: "Couldn't request a certificate. Please try again.",
    };
  }

  const state = certRes.data.managed?.state ?? null;
  if (state !== "ACTIVE") {
    // Still waiting on the merchant's CNAME (or on issuance). Keep showing the
    // record — that is usually the action they need to take. But say so only
    // when it IS the cause: a CAA block or a rate limit is not fixed by adding
    // the records on screen, and telling someone to add them again is how a
    // domain sits broken for days with everybody thinking they are waiting.
    const why = explainCertificate(certRes.data.managed);
    if (why.failureReason) {
      const attempt = certRes.data.managed?.authorizationAttemptInfo?.find(
        (a) => a.state === "FAILED" || a.failureReason,
      );
      logInfo("custom domain not issued", {
        host,
        certificateState: state,
        failureReason: why.failureReason,
        // ★ attemptTime OR THE LINE IS UNREADABLE. Google re-attempts on its own
        // schedule, so a FAILED attempt routinely predates the records that
        // fixed it — without the timestamp there is no way to tell "still
        // broken" from "fixed, not re-checked yet", and the two need opposite
        // responses. `issues` names the specific fault (CNAME_MISMATCH) that the
        // CONFIG enum flattens away.
        attemptTime: attempt?.attemptTime,
        issues: attempt?.troubleshooting?.issues?.join(","),
      });
    }
    return {
      ...base,
      challenge: authRes.challenge,
      certificateState: state,
      ...why,
    };
  }

  // 3. Map entry (idempotent). Only now — an entry pointing at a certificate
  // that isn't ACTIVE would attach a hostname the load balancer cannot serve.
  const entryId = resourceId("entry", host);
  const entryRes = await createOrAdopt<{ name?: string }>(
    `${parent(cfg)}/certificateMaps/${cfg.certificateMap}/certificateMapEntries`,
    entryId,
    {
      hostname: host,
      certificates: [`${parent(cfg)}/certificates/${certId}`],
    },
    "certificateMapEntryId",
  );
  if (!entryRes.ok) {
    logError("provisionHost (map entry)", entryRes.error, { host });
    return {
      ...base,
      certificateState: state,
      error: "Certificate issued, but attaching it failed. Please try again.",
    };
  }

  logInfo("custom domain host provisioned", { host, certificateState: state });
  return {
    host,
    ready: true,
    challenge: null,
    certificateState: state,
    attached: true,
  };
}

/**
 * Provision every hostname this domain should serve — the domain itself plus its
 * apex/www companion — and report the primary's state at the top level.
 */
export async function ensureProvisioned(
  domain: string,
): Promise<ProvisionState> {
  const cfg = getCertConfig();
  if (!cfg) {
    const unavailable = {
      host: domain,
      ready: false,
      challenge: null,
      certificateState: null,
      attached: false,
      error: "Custom domains aren't configured.",
    };
    return { ...unavailable, hosts: [unavailable] };
  }

  // Sequential, primary first. Certificate Manager rate-limits per project and a
  // burst of parallel creates is exactly what surfaces later as RATE_LIMITED on
  // a merchant's certificate — there is nobody waiting on the extra second.
  const hosts: HostProvision[] = [];
  for (const host of domainHosts(domain)) {
    hosts.push(await provisionHost(cfg, host));
  }

  // The primary decides. See ProvisionState.hosts for why www cannot gate.
  const primary = hosts[0]!;
  return { ...primary, hosts };
}

/**
 * Delete ONE host's certificate so provisioning mints a fresh one.
 *
 * ★ THE AUTHORIZATION IS DELIBERATELY NOT TOUCHED. That resource holds the
 * challenge token the merchant has already published in their DNS; deleting it
 * would issue a NEW token and silently invalidate their record, turning a
 * self-healing situation into "please go and edit your DNS again". Only the
 * certificate — the thing carrying Google's stale verdict and its backoff timer
 * — is removed. `ensureProvisioned` then recreates it under the identical
 * deterministic name, referencing the same authorization.
 *
 * Guarded by assertManaged, so this can never reach `prod-apex` or
 * `prod-wildcard`. Callers must consult `decideReissue` first — see reissue.ts
 * for the rate-limit and CAA cases where doing this makes matters worse.
 */
export async function reissueCertificate(
  host: string,
): Promise<{ error?: string }> {
  const cfg = getCertConfig();
  if (!cfg) return { error: "Custom domains aren't configured." };

  const target = `${parent(cfg)}/certificates/${resourceId("cert", host)}`;
  assertManaged(target);
  const res = await api(target, { method: "DELETE" });
  // Already gone is success: the next provisioning pass creates it either way.
  if (!res.ok && res.status !== 404) {
    logError("reissueCertificate", res.error, { host });
    return { error: "Couldn't reset the certificate." };
  }
  logInfo("custom domain certificate reset to escape backoff", { host });
  return {};
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

  // EVERY host, not just the primary — the www triple is billable too, and a
  // certificate nothing references is the kind of leak that only shows up on an
  // invoice. `domainHosts` is the same list provisioning used, so the two cannot
  // drift; a host that was never provisioned just 404s, which counts as success.
  const targets = domainHosts(domain).flatMap((host) => [
    `${parent(cfg)}/certificateMaps/${cfg.certificateMap}/certificateMapEntries/${resourceId("entry", host)}`,
    `${parent(cfg)}/certificates/${resourceId("cert", host)}`,
    `${parent(cfg)}/dnsAuthorizations/${resourceId("auth", host)}`,
  ]);

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
