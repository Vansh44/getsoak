// ---------------------------------------------------------------------------
// Watching a domain that is ALREADY live, and deciding when to give up on it.
//
// ★ WHY. Nothing used to re-check a verified domain: the sweep skipped anything
// with `custom_domain_verified === true`. That was survivable while the subdomain
// stayed reachable — but once `{slug}.storemink.com` REDIRECTS to the custom
// domain, a merchant whose DNS later breaks (nameservers moved, registrar
// lapsed, A record deleted) has no route into their own dashboard at all. The
// redirect turns a cosmetic problem into a lock-out.
//
// So a live domain is re-checked, and after sustained failure the store reverts
// to its subdomain — which un-does the redirect by the same rule that created it
// (storeOrigin reads custom_domain_verified), restoring access automatically.
//
// ★ HYSTERESIS IS THE WHOLE DESIGN. Reverting on ONE failed check would flap the
// store's canonical URL on any transient DNS hiccup, and the canonical URL is
// what Google indexes — a domain that oscillates is worse for the merchant than
// one that is briefly down. Hence: consecutive failures, not a single verdict.
// ---------------------------------------------------------------------------

/** A healthy domain is re-checked at this cadence — cheap, and rarely urgent. */
export const HEALTHY_RECHECK_MS = 6 * 60 * 60 * 1000;

/**
 * Once it has failed once, look again sooner.
 *
 * The asymmetry is deliberate: confirming a suspected failure is time-critical
 * (the merchant may be locked out), whereas re-confirming health is not.
 */
export const FAILING_RECHECK_MS = 60 * 60 * 1000;

/**
 * Consecutive failures before reverting to the subdomain.
 *
 * Three at the failing cadence is ~3 hours — long enough to ride out DNS
 * propagation, a registrar glitch or a Certificate Manager blip, short enough
 * that a genuinely broken domain does not strand the merchant for a day.
 */
export const REVERT_AFTER_FAILURES = 3;

export interface HealthState {
  /** ISO of the last health check, absent if never checked. */
  checkedAt?: string;
  /** Consecutive failures so far. */
  failures?: number;
}

/**
 * Is it time to re-check a live domain?
 *
 * Called BEFORE any work, because the checks cost Certificate Manager calls and
 * DNS lookups per domain — an unthrottled hourly sweep over every live domain
 * would be pure waste for something that changes maybe once a year.
 */
export function shouldHealthCheck(state: HealthState, nowMs: number): boolean {
  // Never checked: do it now, so a domain verified before this existed gets a
  // baseline rather than waiting a full interval.
  if (!state.checkedAt) return true;
  const at = Date.parse(state.checkedAt);
  if (Number.isNaN(at)) return true;
  const due =
    (state.failures ?? 0) > 0 ? FAILING_RECHECK_MS : HEALTHY_RECHECK_MS;
  return nowMs - at >= due;
}

export interface HealthOutcome {
  /** Value to persist as the new consecutive-failure count. */
  failures: number;
  /** Un-verify the domain: the store goes back to its subdomain. */
  revert: boolean;
}

/**
 * Fold one check result into the running state.
 *
 * `healthy` is the AND of everything serving requires — certificate active and
 * attached, and DNS still pointing at the load balancer — so this function does
 * not need to know which part failed, only that the domain is not currently
 * usable end to end.
 */
export function recordHealthResult(
  state: HealthState,
  healthy: boolean,
): HealthOutcome {
  // Any single success clears the count. A domain that works is not "two
  // failures away from working"; carrying history forward would revert a
  // healthy domain on an unlucky sequence of unrelated blips.
  if (healthy) return { failures: 0, revert: false };
  const failures = (state.failures ?? 0) + 1;
  return { failures, revert: failures >= REVERT_AFTER_FAILURES };
}
