// The audience of a platform announcement — PURE. No server imports, so the
// composer's live "this reaches N people" preview and the server's resolve run
// the same rules.
//
// ── ★ CONSENT IS DECIDED HERE, ONCE ────────────────────────────────────────
// `admins.marketing_opt_in` is an unticked box at signup (§25) — a preference
// on the PERSON, deliberately kept apart from `legal_acceptances` because
// conflating a contract with a mailing preference is what makes a consent
// record arguable later. This module is where that preference turns into a
// send-or-skip, and there is exactly one implementation of the rule.

/** Who an announcement is aimed at. Stored verbatim on the announcement row. */
export interface AudienceFilter {
  /** Empty = every plan. */
  plans?: string[];
  /** Empty = every status. */
  statuses?: string[];
  /** Which kinds of person: store owners, delegated dashboard staff, till staff. */
  include?: AudienceRole[];
  /** Only stores created within this many days. 0/undefined = no limit. */
  newerThanDays?: number;
  /** Only stores that have published something (lib/store/launch.ts). */
  launchedOnly?: boolean;
  /** Demo stores are excluded unless this is explicitly true. */
  includeDemo?: boolean;
}

export type AudienceRole = "owner" | "staff" | "pos";

export const AUDIENCE_ROLES: {
  id: AudienceRole;
  label: string;
  hint: string;
}[] = [
  {
    id: "owner",
    label: "Store owners",
    hint: "The superadmin who created the store.",
  },
  {
    id: "staff",
    label: "Dashboard staff",
    hint: "Anyone the owner delegated dashboard access to.",
  },
  {
    id: "pos",
    label: "Till staff",
    hint: "Cashiers and managers with a POS login.",
  },
];

/**
 * `feature` is marketing; `operational` is service correspondence about an
 * account somebody already has.
 *
 * ★ THE DISTINCTION IS NOT COSMETIC — it decides whether `marketing_opt_in`
 * applies, which is why it is a stored column rather than a checkbox on a
 * form. Somebody has to be able to answer "why did this person get this after
 * opting out?" and "because it was a billing deadline" only holds if the
 * category was recorded at the time.
 */
export type AnnouncementCategory = "feature" | "operational";

export const CATEGORY_META: Record<
  AnnouncementCategory,
  { label: string; hint: string; honoursOptIn: boolean }
> = {
  feature: {
    label: "Feature or product news",
    hint: "Marketing. Only goes to people who opted in to product updates.",
    honoursOptIn: true,
  },
  operational: {
    label: "Operational notice",
    hint: "Service correspondence about an account they already have — an outage, a policy change, a billing deadline. Reaches everyone, including people who opted out of marketing.",
    honoursOptIn: false,
  },
};

/** A person the audience query returned, before consent and suppression. */
export interface AudienceCandidate {
  kind: AudienceRole;
  name: string;
  email: string | null;
  phone: string | null;
  storeId: string;
  role: string;
  /** Only meaningful for `owner`/`staff` — till staff have no such column. */
  marketingOptIn: boolean;
}

export type SkipReason =
  | "no_email"
  | "no_phone"
  | "suppressed"
  | "no_consent"
  | "duplicate";

export type Decision =
  | { send: true }
  | { send: false; reason: SkipReason; detail: string };

/**
 * Should this candidate be told, on this channel?
 *
 * ★ EVERY "no" CARRIES A REASON, and the reason is stored on the recipient
 * row. "412 sent, 38 skipped" with no breakdown is a number nobody can act on;
 * "38 skipped: 31 not opted in, 7 suppressed" tells an operator whether their
 * audience is wrong or their list is dirty.
 */
export function decideRecipient(
  candidate: AudienceCandidate,
  opts: {
    channel: "email" | "sms";
    category: AnnouncementCategory;
    /** Lowercased addresses on the global bounce/complaint list. */
    suppressed: ReadonlySet<string>;
    /** Already-claimed contact points, for the duplicate check. */
    seen: ReadonlySet<string>;
  },
): Decision {
  const honoursOptIn = CATEGORY_META[opts.category].honoursOptIn;

  // ★ TILL STAFF ARE NEVER MARKETED TO. `pos_staff` has no `marketing_opt_in`
  // column — nobody ever asked them — and absence of a preference is not
  // consent. They still receive operational notices, because those are about
  // a system they are standing in front of.
  if (honoursOptIn && candidate.kind === "pos") {
    return {
      send: false,
      reason: "no_consent",
      detail: "Till staff were never asked about product updates.",
    };
  }

  if (honoursOptIn && !candidate.marketingOptIn) {
    return {
      send: false,
      reason: "no_consent",
      detail: "Not opted in to product updates.",
    };
  }

  if (opts.channel === "email") {
    const email = (candidate.email ?? "").trim().toLowerCase();
    if (!email) {
      return { send: false, reason: "no_email", detail: "No email address." };
    }
    if (opts.suppressed.has(email)) {
      // A hard bounce bounces for everyone — the suppression list is global by
      // design, because the sending domain's reputation is the platform's.
      return {
        send: false,
        reason: "suppressed",
        detail: "Address previously bounced or complained.",
      };
    }
    if (opts.seen.has(email)) {
      // One person, one message. Somebody who owns two stores is still one
      // inbox, and telling them twice reads as a bug in our system.
      return {
        send: false,
        reason: "duplicate",
        detail: "Already included via another store.",
      };
    }
    return { send: true };
  }

  const phone = (candidate.phone ?? "").trim();
  if (!phone) {
    return { send: false, reason: "no_phone", detail: "No phone number." };
  }
  if (opts.seen.has(phone)) {
    return {
      send: false,
      reason: "duplicate",
      detail: "Already included via another store.",
    };
  }
  return { send: true };
}

/** The contact point `decideRecipient` de-duplicates on, or null. */
export function contactKey(
  candidate: AudienceCandidate,
  channel: "email" | "sms",
): string | null {
  if (channel === "email") {
    const email = (candidate.email ?? "").trim().toLowerCase();
    return email || null;
  }
  const phone = (candidate.phone ?? "").trim();
  return phone || null;
}

/** Human summary of an audience filter, for the composer and the log. */
export function describeAudience(filter: AudienceFilter): string {
  const parts: string[] = [];

  const roles = filter.include?.length ? filter.include : ["owner"];
  parts.push(
    roles
      .map((r) => AUDIENCE_ROLES.find((x) => x.id === r)?.label ?? r)
      .join(" + "),
  );

  if (filter.plans?.length) parts.push(`on ${filter.plans.join("/")}`);
  if (filter.statuses?.length) parts.push(`(${filter.statuses.join("/")})`);
  if (filter.newerThanDays) parts.push(`joined in ${filter.newerThanDays}d`);
  if (filter.launchedOnly) parts.push("launched stores only");
  if (filter.includeDemo) parts.push("including demo stores");

  return parts.join(", ");
}

/**
 * Normalise a filter arriving from the composer.
 *
 * ★ UNKNOWN VALUES ARE DROPPED, NOT PASSED THROUGH. The filter reaches a SQL
 * predicate, so plans/statuses/roles are allowlisted here rather than escaped
 * later — and a filter that silently kept a bad value would widen the audience
 * rather than narrow it, which is the wrong direction to fail in.
 */
export function normalizeAudience(input: unknown): AudienceFilter {
  const raw = (input ?? {}) as Record<string, unknown>;
  const list = (value: unknown, allowed: readonly string[]): string[] =>
    Array.isArray(value)
      ? [
          ...new Set(
            value.filter((v): v is string => allowed.includes(v as string)),
          ),
        ]
      : [];

  const include = list(raw.include, [
    "owner",
    "staff",
    "pos",
  ]) as AudienceRole[];
  const days = Number(raw.newerThanDays);

  return {
    plans: list(raw.plans, ["free", "basic", "pro"]),
    statuses: list(raw.statuses, ["active", "suspended"]),
    // Default to owners: the narrowest useful audience. Defaulting to everyone
    // would make a mis-saved filter mail the whole platform.
    include: include.length ? include : ["owner"],
    newerThanDays:
      Number.isFinite(days) && days > 0 ? Math.min(Math.floor(days), 3650) : 0,
    launchedOnly: raw.launchedOnly === true,
    includeDemo: raw.includeDemo === true,
  };
}
