// ---------------------------------------------------------------------------
// Names for the Certificate Manager resources a merchant domain needs, and the
// guard that decides what this app is allowed to delete.
//
// Two jobs, deliberately in one small file because they depend on each other:
// the guard is only safe if every name we create is guaranteed to match it.
//
// WHY THE GUARD EXISTS. The runtime service account holds
// roles/certificatemanager.editor on the project, and the certificate map it
// writes into is the SAME map holding `prod-apex` and `prod-wildcard`. Deleting
// one of those would take TLS down for storemink.com and every store subdomain
// at once. IAM cannot express "only the entries you made", so the boundary is
// here: nothing is deleted unless its name carries our prefix.
//
// WHY NAMES ARE DETERMINISTIC. Provisioning must be idempotent — a retried
// background job, a redeployed revision, or a merchant double-clicking Verify
// must converge on the same resources rather than creating duplicates (which
// cost money) or failing. The name is derived purely from (environment,
// domain), so the second run computes the identical name, gets ALREADY_EXISTS,
// and adopts the existing resource.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";

/**
 * Every resource this app creates starts with this. The delete guard is a
 * prefix test against it, so changing this string orphans existing resources
 * rather than breaking anything — but it also means they can no longer be
 * cleaned up automatically. Don't change it casually.
 */
export const MANAGED_PREFIX = "sm-domain-";

/** Certificate Manager resource ids: lowercase alphanumeric and hyphens, ≤63. */
const MAX_ID = 63;

/**
 * Environment segment of the name.
 *
 * Staging and production share one certificate map (one HTTPS proxy can hold
 * only one map, and a single load balancer fronts both). So the environment
 * has to live in the NAME instead — it is what lets the guard below refuse to
 * let staging delete a production entry, which is the only isolation available
 * without a second load balancer.
 */
export function domainEnv(): string {
  const raw =
    process.env.DOMAIN_ENV ?? process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? "";
  // Anything that isn't clearly production is treated as non-production: the
  // safe direction, since a mislabelled staging deploy then cannot produce a
  // name that the production guard accepts as its own.
  return raw === "prod" || raw === "storemink.com" ? "prod" : "stg";
}

/**
 * Deterministic resource id for one (environment, domain, kind).
 *
 * The domain is carried in readable form so an operator scanning the GCP
 * console can tell what a resource is for, and a hash of the FULL domain is
 * appended so that truncation can never collide two different domains onto one
 * name — "a-very-long-domain…" and a different equally long one would
 * otherwise share an id and silently reuse each other's certificate.
 */
export function resourceId(
  kind: "auth" | "cert" | "entry",
  domain: string,
): string {
  const env = domainEnv();
  const hash = createHash("sha256").update(domain).digest("hex").slice(0, 10);
  const prefix = `${MANAGED_PREFIX}${env}-${kind}-`;
  const suffix = `-${hash}`;

  const readable = domain
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  const room = MAX_ID - prefix.length - suffix.length;
  const trimmed = readable.slice(0, Math.max(0, room)).replace(/-+$/, "");
  return `${prefix}${trimmed}${suffix}`;
}

/**
 * May this app delete the named resource?
 *
 * Requires BOTH the managed prefix and this environment's segment. The second
 * half is what stops a staging deploy — pointed at the same shared certificate
 * map — from removing a production merchant's entry.
 *
 * Accepts a bare id or a full resource path; callers have both, and a guard
 * that silently returns false for the path form would be a guard that never
 * fires when it matters.
 */
export function isManagedResource(name: string | null | undefined): boolean {
  if (typeof name !== "string" || !name) return false;
  const id = name.split("/").pop() ?? "";
  return id.startsWith(`${MANAGED_PREFIX}${domainEnv()}-`);
}

/**
 * Throwing form, for use immediately before a destructive call.
 *
 * Deliberately a throw rather than a silent no-op: a delete that quietly does
 * nothing leaves the caller believing it cleaned up, and the resource then bills
 * forever with nothing tracking it.
 */
export function assertManaged(name: string | null | undefined): void {
  if (!isManagedResource(name)) {
    throw new Error(
      `Refusing to delete unmanaged certificate resource: ${name ?? "(none)"}`,
    );
  }
}
