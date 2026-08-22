// Client-safe half of the Failures log: the shapes and the source catalog.
//
// ★ WHY THIS IS A SEPARATE FILE. `failures.ts` imports `withService`, which
// pulls in `pg`, which needs `fs` — so a client component importing the source
// catalog from there drags the entire database driver into the browser bundle
// and the build fails on `Module not found: Can't resolve 'fs'`. Same split,
// for the same reason, as lib/themes/meta.ts vs lib/themes/definitions/:
// client surfaces import the metadata, never the implementation.

export type FailureSourceKey =
  | "email"
  | "sms"
  | "notification"
  | "refund"
  | "import"
  | "indexing"
  | "payment"
  | "subscription";

/**
 * Which store's failures to read.
 *
 * A discriminated union rather than an optional `storeId`, because the queries
 * behind it run under `withService` (RLS bypassed): an optional field would
 * make "every store on the platform" the value you get by forgetting an
 * argument. `{ kind: "platform" }` cannot be produced by omission.
 */
export type FailureScope =
  | { kind: "store"; storeId: string }
  | { kind: "platform" };

export interface FailureRow {
  /** Unique across sources — a row id alone collides between tables. */
  id: string;
  source: FailureSourceKey;
  /** What failed, in the reader's language. Never a stack trace. */
  title: string;
  /** Why, when the source recorded a reason. */
  detail: string | null;
  occurredAt: string;
  storeId: string | null;
  /** Where to go to do something about it, when there is such a place. */
  href: string | null;
}

export interface FailureSourceMeta {
  key: FailureSourceKey;
  label: string;
  /** One line explaining what lands here, shown as the filter's tooltip. */
  blurb: string;
}

/** The filter chips. Kept in step with FAILURE_SOURCES by a test. */
export const FAILURE_SOURCE_META: FailureSourceMeta[] = [
  {
    key: "email",
    label: "Email",
    blurb: "Messages the provider rejected or that bounced.",
  },
  {
    // ★ SEPARATE FROM `email`, and not only for tidiness: an SMS failure has a
    // cause email never has — a body that drifted from its DLT-registered
    // template, or a header the merchant's registration doesn't cover. Folding
    // it into Email would put two different remedies behind one chip.
    key: "sms",
    label: "SMS",
    blurb: "Texts the provider rejected, or never confirmed.",
  },
  {
    key: "notification",
    label: "Notification",
    blurb: "Queued notification mail that ran out of retries.",
  },
  {
    key: "refund",
    label: "Refund",
    blurb: "Money that was meant to go back and didn't.",
  },
  {
    key: "import",
    label: "Import / export",
    blurb: "Jobs that errored, and ones that only partly landed.",
  },
  {
    key: "indexing",
    label: "Google Search",
    blurb: "Store verification or sitemap updates that Google rejected.",
  },
  {
    key: "payment",
    label: "Payment",
    blurb: "Checkouts where the money never arrived.",
  },
  {
    // ★ A SEPARATE SOURCE FROM `payment`, deliberately. That one is a SHOPPER's
    // checkout failing — the merchant's own revenue. This is the MERCHANT's
    // subscription payment to StoreMink failing, which costs them their plan.
    // Different audience, different consequence; folding them together would
    // bury one in the other.
    key: "subscription",
    label: "Subscription",
    blurb:
      "Plan payments that failed — the merchant is heading for a downgrade.",
  },
];
