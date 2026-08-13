// ---------------------------------------------------------------------------
// "Renews" or "Expires"? — the billing card's date label.
//
// One date sits under that label and it means opposite things depending on
// what is behind the plan. A comp grant runs OUT on its date; a subscription
// RENEWS on its date. Labelling both "Renews / expires" made the merchant do
// that reasoning themselves, every time, from a card that already knows the
// answer.
//
// The rule: a date is a RENEWAL only if something will actually charge for it.
// Everything else with a date is a deadline. That keeps the failure safe — an
// unknown or half-known state reads as "Expires", which prompts a merchant to
// look rather than assuring them of a renewal that may not come.
// ---------------------------------------------------------------------------

export type RenewalTerm =
  /** The date has passed and the plan already lapsed. */
  | "expired"
  /** Autopay will charge on this date and the plan continues. */
  | "renews"
  /** Access ends on this date unless the merchant acts. */
  | "expires"
  /** Nothing to say — an indefinite plan with no date at all. */
  | "none";

export interface RenewalInput {
  /** stores.plan_expires_at (or the subscription cycle end), ISO or null. */
  expiresAt: string | null;
  /** True once the plan itself has lapsed — the card's existing signal. */
  expired: boolean;
  /** A live, authorised mandate exists (SubscriptionView.autopay). */
  hasMandate: boolean;
  /** The merchant cancelled: it runs to the cycle end, then stops. */
  cancelAtPeriodEnd: boolean;
  /** Raw gateway status, for the states where "will it charge?" is subtler. */
  status: string | null;
}

export function renewalTerm(input: RenewalInput): RenewalTerm {
  // Checked first: a lapsed plan is a fact about the past, and no mandate
  // state changes what that date meant.
  if (input.expired) return "expired";
  if (!input.expiresAt) return "none";

  if (!input.hasMandate) return "expires";

  // Cancelled-but-running. The card says "Expires" because that is what the
  // date now marks — the last day of service, not the next charge.
  if (input.cancelAtPeriodEnd) return "expires";

  // A subscription whose payment has failed will not renew itself, so the date
  // is a deadline rather than a renewal.
  //
  // `halted` is the OLD system's word for "the gateway exhausted its retries".
  // `past_due` and `grace` are the NEW system's (§34) — the cycle turned unpaid
  // and the 48-hour clock is running. All three mean the same thing to a
  // merchant reading the card, so they map to the same term; a `pending` retry
  // can still succeed and stays a renewal.
  if (
    ["halted", "past_due", "grace"].includes((input.status ?? "").toLowerCase())
  )
    return "expires";

  return "renews";
}

/** The heading shown above the date. */
export function renewalLabel(term: RenewalTerm): string {
  switch (term) {
    case "expired":
      return "Expired on";
    case "renews":
      return "Renews";
    case "expires":
      return "Expires";
    case "none":
      // No date to qualify, so the heading stays neutral rather than promising
      // a renewal or threatening an expiry that isn't scheduled.
      return "Renews / expires";
  }
}
