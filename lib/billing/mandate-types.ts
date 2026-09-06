// ---------------------------------------------------------------------------
// Client-safe vocabulary for the rail a subscription mandate is authorised on.
//
// ★★ WHY ITS OWN FILE. `lib/billing/enrol.ts` is `server-only` — it imports the
// db client, so a client component importing anything from it, a type included,
// drags `pg` and therefore `fs` into the browser bundle. `tsc` and `eslint`
// both pass and the BUILD fails. Same split as `lib/logs/failure-types.ts`
// (client half, runtime metadata included) versus `failures.ts` (server half),
// and the same trap `lib/billing/invoice-types.ts` was created for.
//
// Keep this module free of imports.
// ---------------------------------------------------------------------------

/**
 * The rails a merchant may authorise a mandate on.
 *
 * ★ Card and UPI only. `emandate` and `nach` are enabled on the Razorpay
 * account but are bank-mandate flows with a different UX and settlement story;
 * offering them untested would promise something nobody has verified.
 */
export const MANDATE_METHODS = ["card", "upi"] as const;
export type MandateMethod = (typeof MANDATE_METHODS)[number];

/**
 * Coerce a browser-supplied rail.
 *
 * ★ Safe to accept from the client in a way an amount would not be: it selects
 * a payment RAIL, every figure is still computed server-side, and anything
 * unrecognised becomes "card" rather than being trusted. Card is the fallback
 * because it is what every mandate created before this existed used, so an
 * absent value reproduces the old behaviour exactly.
 */
export function normalizeMandateMethod(value: unknown): MandateMethod {
  return value === "upi" ? "upi" : "card";
}

/**
 * What the review step shows. Derived from `MANDATE_METHODS` so the labels and
 * the accepted values cannot drift apart.
 */
export const MANDATE_METHOD_CHOICES: {
  id: MandateMethod;
  label: string;
  detail: string;
}[] = [
  {
    id: "card",
    label: "Card",
    detail: "Credit or debit card, saved under RBI e-mandate rules.",
  },
  {
    id: "upi",
    label: "UPI Autopay",
    detail: "Approve a mandate in your UPI app; no card details needed.",
  },
];
