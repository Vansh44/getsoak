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
  | "notification"
  | "refund"
  | "import"
  | "payment";

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
    key: "payment",
    label: "Payment",
    blurb: "Checkouts where the money never arrived.",
  },
];
