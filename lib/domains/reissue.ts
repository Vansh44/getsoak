// ---------------------------------------------------------------------------
// Escaping Google's retry backoff — the one step that still needed a human.
//
// ★ THE PROBLEM, OBSERVED IN PRODUCTION (2026-08-06). A managed certificate
// records the result of its LAST authorization attempt and then retries on its
// own schedule, backing off as failures accumulate. So a merchant who fixes
// their DNS does NOT get a prompt re-check: wholesip.com's certificate sat
// reading `CONFIG / CNAME_MISMATCH` from an attempt made 59 minutes BEFORE the
// correct records were published, with the apex fully down the whole time.
// Nothing in the system was wrong, and nothing in the system was going to fix
// it either — it was waiting on Google to look again.
//
// Deleting just the CERTIFICATE and letting provisioning recreate it forces a
// fresh attempt immediately. The DnsAuthorization is left alone, so the
// challenge CNAME the merchant published stays valid and they never touch DNS
// again. Done by hand, the certificate went ACTIVE in 80 SECONDS.
//
// This module is the decision to do that, automatically. Pure, so every guard
// is testable without GCP: the action deletes a real certificate, and the rules
// about when NOT to do it matter more than the rule about when to.
// ---------------------------------------------------------------------------

/** An attempt older than this, with DNS already correct, is a stale verdict. */
export const STALE_ATTEMPT_MS = 20 * 60 * 1000;

/**
 * Never reissue the same host more often than this.
 *
 * ★ THE ANTI-THRASH GUARD, and the reason this is not just "retry when stuck".
 * Certificate Manager rate-limits per top-level private domain, and a loop that
 * recreated a certificate every hour would spend that budget and land the
 * merchant in RATE_LIMITED — turning a slow success into a hard failure, for
 * every domain on that registrable domain rather than just this one.
 */
export const REISSUE_COOLDOWN_MS = 6 * 60 * 60 * 1000;

export interface ReissueInput {
  /** This host is already serving — nothing to fix. */
  ready: boolean;
  /** Google's cause for the last failed attempt (CONFIG / CAA / RATE_LIMITED). */
  failureReason?: string;
  /** When Google last looked. ISO. Absent = we cannot judge staleness. */
  attemptTime?: string;
  /** OUR live check: is the challenge CNAME correct right now? */
  cnameCorrect: boolean;
  /** When we last forced a reissue for this host. ISO. */
  lastReissueAt?: string;
  nowMs: number;
}

export interface ReissueDecision {
  reissue: boolean;
  /** Why, for the log line. Always set, including on "no". */
  reason: string;
}

/**
 * Should we delete this host's certificate to force a fresh attempt?
 *
 * Deliberately conservative. Every "no" below is a case where recreating the
 * certificate either cannot help or makes things actively worse.
 */
export function decideReissue(input: ReissueInput): ReissueDecision {
  const no = (reason: string): ReissueDecision => ({ reissue: false, reason });

  if (input.ready) return no("already serving");

  // ★ NEVER ON RATE_LIMITED. This is the most important guard in the file:
  // the failure IS that we have asked too often, so asking again is the one
  // action guaranteed to prolong it. It clears by itself.
  if (input.failureReason === "RATE_LIMITED") {
    return no("rate limited — a new certificate would deepen it");
  }

  // A CAA record forbidding Google applies to every certificate for the domain,
  // so a fresh one hits the identical wall. Only the merchant can fix this.
  if (input.failureReason === "CAA") {
    return no("CAA record forbids issuance — reissuing changes nothing");
  }

  // No recorded failure means Google is either working on it right now
  // (AUTHORIZING) or has never tried. Either way, leave it alone.
  if (!input.failureReason) return no("no failed attempt to escape");

  // ★ OUR OWN DNS CHECK IS THE PRECONDITION. Without it we would recreate
  // certificates for a domain whose records are genuinely missing — spending
  // the rate-limit budget to relearn the same answer. A reissue is only ever
  // justified because we can see that the cause is already gone.
  if (!input.cnameCorrect) {
    return no(
      "challenge CNAME still wrong — the failure is current, not stale",
    );
  }

  // Cannot judge staleness without a timestamp, and acting blind here means
  // recreating a certificate Google may be authorizing this second.
  if (!input.attemptTime) return no("no attemptTime — cannot judge staleness");

  const attemptMs = Date.parse(input.attemptTime);
  if (Number.isNaN(attemptMs)) return no("unparseable attemptTime");

  const age = input.nowMs - attemptMs;
  if (age < STALE_ATTEMPT_MS) {
    return no(`last attempt only ${Math.round(age / 60000)}m ago`);
  }

  if (input.lastReissueAt) {
    const lastMs = Date.parse(input.lastReissueAt);
    if (!Number.isNaN(lastMs) && input.nowMs - lastMs < REISSUE_COOLDOWN_MS) {
      return no("within the reissue cooldown");
    }
  }

  return {
    reissue: true,
    reason: `stale ${input.failureReason} verdict from ${Math.round(age / 60000)}m ago, DNS now correct`,
  };
}

/**
 * How long a domain has been waiting, and whether that is worth shouting about.
 *
 * The sweep answers 200 even while domains wait (a merchant who hasn't added
 * their records is not an outage), which means a domain stuck for a WEEK looks
 * exactly like one stuck for a minute. This is the line between the two.
 */
export const STUCK_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

export function pendingDuration(
  pendingSince: string | undefined,
  nowMs: number,
): { days: number; stuck: boolean } {
  if (!pendingSince) return { days: 0, stuck: false };
  const sinceMs = Date.parse(pendingSince);
  if (Number.isNaN(sinceMs)) return { days: 0, stuck: false };
  const elapsed = Math.max(0, nowMs - sinceMs);
  return {
    days: Math.floor(elapsed / (24 * 60 * 60 * 1000)),
    stuck: elapsed >= STUCK_AFTER_MS,
  };
}
