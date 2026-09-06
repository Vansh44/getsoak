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
 * ★★ RBI'S AFA-EXEMPT LIMIT — the most that can be debited on a registered
 * mandate WITHOUT the customer authenticating that specific debit.
 *
 * Quoted from Razorpay's own documentation, checked 2026-09-06, because the
 * intuition that a card is somehow more permissive than UPI is wrong and
 * expensive:
 *
 *   Cards — "You can register mandates up to a maximum of ₹15,000 without any
 *   intervention from customers… For others to register and process mandates
 *   of amounts greater than ₹15,000, an Additional Factor Authentication (AFA)
 *   is required from customers for every subsequent debit."
 *
 *   UPI — "The maximum transaction amount allowed is ₹15,000… Any auto debit
 *   above ₹15,000 undergoes an additional authorisation from the customer."
 *
 * ⚠ The ₹1,00,000 exemption is real and reaches only mutual funds (MCC 6211),
 * insurance (6300, 6529, 5960) and credit-card bills (6012, 5413). A SaaS
 * subscription is none of those.
 *
 * ⚠ This duplicates `AFA_EXEMPT_LIMIT_PAISE` in `cycle.ts` DELIBERATELY: this
 * module must stay import-free so a client component can read it, and cycle.ts
 * is where the collection path reads it. `mandate-types.test.ts` asserts the
 * two agree, so they cannot drift.
 */
export const AFA_EXEMPT_PAISE = 15_000 * 100;

/**
 * Can this recurring charge be collected automatically, and on which rail?
 *
 * ★★ THE AMOUNT DECIDES, NOT THE MERCHANT. A rail is fixed on the
 * authorisation order and cannot be edited afterwards, so a merchant who picks
 * one that cannot carry their renewal has chosen a mandate that will never
 * fire — and nothing tells them. They are not well placed to make that call;
 * the charge is.
 *
 * ★ `null` is not "no autopay for now". It means autopay is IMPOSSIBLE for
 * this amount on the rails we support, so no mandate should be requested at
 * all: asking a merchant to authorise a ceiling that can never be exercised is
 * how ₹43,000 got requested for a ₹24,000 charge that was always going to be
 * invoiced by hand.
 *
 * ⚠ Phase 2 turns the null branch into `"emandate"` (NPCI eNACH, ₹1 crore, no
 * per-debit AFA). That is the ONLY change this function needs, which is why it
 * returns a rail rather than a boolean.
 */
export function autopayRailFor(chargePaise: number): MandateMethod | null {
  if (!Number.isFinite(chargePaise) || chargePaise <= 0) return null;
  return chargePaise > AFA_EXEMPT_PAISE ? null : "upi";
}

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
