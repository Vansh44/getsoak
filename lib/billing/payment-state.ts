/**
 * The payment-attempt state machine — MONOTONIC, which is what makes
 * out-of-order webhooks safe without comparing anyone's clock.
 *
 * PURE. Design: docs/billing-architecture.md §4.
 *
 * Razorpay does not guarantee webhook order, so `payment.failed` can arrive
 * after `payment.captured` for the same payment. The usual fix — "latest valid
 * state wins" — needs a trustworthy timestamp and invites arguing about whose
 * clock is right. Instead: rank the states, make success terminal, and let the
 * machine reject the impossible transition itself. No timestamps involved.
 */

export type PaymentState =
  | "created"
  | "processing"
  | "authorized"
  | "captured"
  | "failed"
  | "cancelled"
  | "refunded"
  | "unknown";

/** Money has moved and will not un-move except by a refund. */
const TERMINAL_SUCCESS: ReadonlySet<PaymentState> = new Set([
  "captured",
  "refunded",
]);

/**
 * This attempt is over. A retry is a NEW attempt row, never a resurrection of
 * this one — which is what keeps "why was this merchant charged twice" answerable.
 */
const TERMINAL_FAILURE: ReadonlySet<PaymentState> = new Set([
  "failed",
  "cancelled",
]);

/**
 * Forward progress along the happy path. `unknown` is deliberately OUTSIDE this
 * ordering: it is not a stage, it is an absence of information, and it can be
 * entered from any in-flight state and left for either outcome.
 */
const PROGRESS: readonly PaymentState[] = [
  "created",
  "processing",
  "authorized",
  "captured",
];

export function isTerminal(state: PaymentState): boolean {
  return TERMINAL_SUCCESS.has(state) || TERMINAL_FAILURE.has(state);
}

export function isInFlight(state: PaymentState): boolean {
  return !isTerminal(state);
}

export interface StateResolution {
  /** The state to persist. */
  state: PaymentState;
  /** Did it move? False for a duplicate or a rejected out-of-order event. */
  changed: boolean;
  /**
   * True when the incoming event was REJECTED as regressive — a late `failed`
   * after a `captured`. Worth logging: it is normal, but a flood of them means
   * something upstream is replaying.
   */
  ignored: boolean;
}

/**
 * Fold an incoming observation into the current state.
 *
 * The rules, in order:
 *   • Same state ⇒ nothing changed (a duplicate webhook, spec §25).
 *   • From a terminal SUCCESS, only captured → refunded is legal. Everything
 *     else — including `failed` — is ignored. ★ This is the §26 guarantee: an
 *     invoice is never marked failed because an earlier webhook said so.
 *   • From a terminal FAILURE, nothing. The attempt is closed.
 *   • From in flight: forward along PROGRESS, or into `unknown`, or to a
 *     terminal outcome. Backwards along PROGRESS is ignored.
 */
export function resolvePaymentState(
  current: PaymentState,
  incoming: PaymentState,
): StateResolution {
  if (current === incoming) {
    return { state: current, changed: false, ignored: false };
  }

  if (TERMINAL_SUCCESS.has(current)) {
    if (current === "captured" && incoming === "refunded") {
      return { state: "refunded", changed: true, ignored: false };
    }
    return { state: current, changed: false, ignored: true };
  }

  if (TERMINAL_FAILURE.has(current)) {
    return { state: current, changed: false, ignored: true };
  }

  // In flight from here on.
  if (isTerminal(incoming)) {
    // `refunded` cannot be reached without first capturing — a refund event for
    // an attempt we never saw captured is a reconciliation question, not a
    // state transition.
    if (incoming === "refunded") {
      return { state: current, changed: false, ignored: true };
    }
    return { state: incoming, changed: true, ignored: false };
  }

  if (incoming === "unknown") {
    return { state: "unknown", changed: true, ignored: false };
  }

  // current is in PROGRESS or `unknown`; incoming is in PROGRESS.
  const from = PROGRESS.indexOf(current);
  const to = PROGRESS.indexOf(incoming);
  if (from === -1) {
    // Leaving `unknown` for a known in-flight stage is information gained.
    return { state: incoming, changed: true, ignored: false };
  }
  if (to > from) {
    return { state: incoming, changed: true, ignored: false };
  }
  return { state: current, changed: false, ignored: true };
}

/** Does this state mean money is confirmed to have been collected? */
export function isSettled(state: PaymentState): boolean {
  return state === "captured" || state === "refunded";
}

/**
 * Does this state require reconciliation rather than a verdict?
 *
 * ★ `unknown` is NOT a failure (Rule 6 / spec §44). A provider timeout means we
 * do not know whether money moved, so it must never start a grace clock and must
 * never trigger a second charge.
 */
export function needsReconciliation(state: PaymentState): boolean {
  return state === "unknown";
}

// ---------------------------------------------------------------------------
// Invoice status, derived
// ---------------------------------------------------------------------------

export type InvoiceStatus =
  | "draft"
  | "open"
  | "processing"
  | "paid"
  | "uncollectible"
  | "void"
  | "refunded"
  | "partially_refunded";

/**
 * The status an OPEN invoice should carry, given its attempts.
 *
 * ★ Derived, never a stored flag that someone has to remember to clear —
 * `refundOwed` in §26 is the same reasoning. Only ever called for invoices that
 * are still collectable: `void` and `uncollectible` are decisions, not
 * derivations, so they are set explicitly and this is not consulted for them.
 *
 * A failed attempt does NOT make the invoice failed — the invoice returns to
 * `open` and is retried with a new attempt. There is no `failed` invoice status
 * for exactly this reason.
 */
export function invoiceStatusForAttempts(
  attemptStates: readonly PaymentState[],
): Extract<InvoiceStatus, "open" | "processing" | "paid"> {
  if (attemptStates.some((s) => s === "captured")) return "paid";
  if (attemptStates.some(isInFlight)) return "processing";
  return "open";
}
