// ---------------------------------------------------------------------------
// Client-safe shapes for the §34 platform-billing invoices a merchant SEES.
//
// ★★ WHY ITS OWN FILE, and not `manual-pay.ts` or `subscribe-actions.ts`:
//
//   • `lib/billing/manual-pay.ts` is `server-only` — it imports the db client,
//     so a client component importing anything from it (a type included) drags
//     `pg`, and therefore `fs`, into the browser bundle.
//   • `app/actions/subscribe-actions.ts` is `"use server"`, where EVERY export
//     is registered as a server action. A `type` re-export looks free — `tsc`
//     and `eslint` both pass — and then the BUILD fails with "Export
//     PayableInvoice doesn't exist in target module", because Next emits an
//     action reference for it. Erasure happens too late to help.
//
// Same split as `lib/logs/failure-types.ts` (client half) vs `failures.ts`
// (server half), and the same trap as `EXTRA_LOCATION_KEY` living in
// `lib/plans.ts` rather than the `server-only` `lib/plans/pricing.ts`.
//
// Keep this module free of imports. It is types only.
// ---------------------------------------------------------------------------

/**
 * One row of the "invoices you still owe" list.
 *
 * Stated explicitly rather than inferred from a Drizzle select, so the client
 * component that renders it does not depend on the query's shape.
 */
export interface PayableInvoice {
  id: string;
  /** The document number, once finalized. Null on a draft. */
  invoiceRef: string | null;
  status: string;
  totalPaise: number;
  /** The service period this invoice covers. */
  periodStart: string | null;
  periodEnd: string | null;
  dueAt: string | null;
  createdAt: string;
}

/**
 * What the Locations page renders for metered extra locations (§34, POS 7).
 *
 * Here for the same reason `PayableInvoice` is: the card is a CLIENT component,
 * `lib/billing/locations.ts` is `server-only`, and a `type` re-export from the
 * `"use server"` action file fails the build.
 */
export interface LocationBillingState {
  /** Locations the plan includes at no extra cost. */
  included: number;
  /** Extra locations currently paid for. */
  billed: number;
  /** Locations that exist right now. */
  existing: number;
  /** included + billed — the ceiling createLocation enforces. */
  allowance: number;
  /** Extra locations that MUST stay paid for, given what exists. */
  required: number;
  /** Paid slots sitting unused, which could be released. */
  releasable: number;
  /** Set when a release is already booked for the end of this cycle. */
  scheduled: number | null;
  pricePerPeriodInr: number;
  period: "monthly" | "yearly";
  /** What buying ONE more costs right now, part-period. */
  nextPurchaseInr: number;
  canBuy: boolean;
  blockedReason?: string;
}
