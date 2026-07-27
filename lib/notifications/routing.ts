// ---------------------------------------------------------------------------
// Recipient routing — which of a store's eligible staff actually get an event.
//
// A superadmin shapes this per event on /dashboard/settings/notifications
// ("Store default" → Recipients):
//
//   permission  Everyone who can view the section (the default, and what every
//               store gets until it says otherwise).
//   roles       Only staff holding one of the named roles.
//   admins      Only the named people.
//
// ══ THE RULE THAT MATTERS ══════════════════════════════════════════════════
// Targeting only ever NARROWS. `eligible` is the permission-derived set and is
// a hard floor: naming someone who cannot `view` the event's section does not
// start sending it to them.
//
// Why: a notification is a PREVIEW OF THE THING ITSELF — "New order
// ORD10010004 · ₹1,240 · from Priya S." is order data, and it goes to an inbox
// and an inbox to an email. If routing could widen the set, a superadmin could
// (without meaning to) pipe order totals and customer names to a blog editor
// the Orders page won't even render for. Permission stays the one gate; routing
// chooses among those already allowed. Where a merchant genuinely wants someone
// notified, the honest fix is their ROLE — which the picker says out loud
// instead of silently dropping them.
//
// Pure module: no DB, no server imports, fully testable.
// ---------------------------------------------------------------------------

export const ROUTING_MODES = ["permission", "roles", "admins"] as const;
export type RoutingMode = (typeof ROUTING_MODES)[number];

export interface RoutingRule {
  mode: RoutingMode;
  /** Role slugs, for mode "roles". */
  roles: string[];
  /** Admin uids, for mode "admins". */
  admins: string[];
}

export const DEFAULT_ROUTING: RoutingRule = {
  mode: "permission",
  roles: [],
  admins: [],
};

/** Anything routable has an id and the role slug it holds. */
export interface RoutableRecipient {
  id: string;
  roleSlug: string;
}

export function isRoutingMode(value: unknown): value is RoutingMode {
  return (
    typeof value === "string" &&
    (ROUTING_MODES as readonly string[]).includes(value)
  );
}

/**
 * Normalise a stored/submitted rule. Junk in the column can never break a
 * fan-out: anything unrecognised falls back to "permission", and a targeted
 * mode with nothing selected does too — an empty target list means "the
 * merchant hasn't finished choosing", not "tell nobody", which would silently
 * black-hole a store's order alerts.
 */
export function normalizeRouting(input: {
  routing?: unknown;
  target_roles?: unknown;
  target_admins?: unknown;
}): RoutingRule {
  const mode = isRoutingMode(input.routing) ? input.routing : "permission";
  const roles = toStringArray(input.target_roles);
  const admins = toStringArray(input.target_admins);

  if (mode === "roles" && roles.length === 0) return DEFAULT_ROUTING;
  if (mode === "admins" && admins.length === 0) return DEFAULT_ROUTING;
  if (mode === "permission") return DEFAULT_ROUTING;

  return { mode, roles, admins };
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const clean = item.trim();
    // Cap the list: a routing rule is a handful of people, not a mailing list.
    if (clean && !out.includes(clean) && out.length < 100) out.push(clean);
  }
  return out;
}

/**
 * Apply a routing rule to the permission-derived recipients.
 *
 * `eligible` has already passed the permission gate; this only ever returns a
 * subset of it. Never widens — see the header.
 */
export function selectRecipients<T extends RoutableRecipient>(
  eligible: readonly T[],
  rule: RoutingRule = DEFAULT_ROUTING,
): T[] {
  if (rule.mode === "permission") return [...eligible];

  if (rule.mode === "roles") {
    const wanted = new Set(rule.roles);
    return eligible.filter((r) => wanted.has(r.roleSlug));
  }

  const wanted = new Set(rule.admins);
  return eligible.filter((r) => wanted.has(r.id));
}

/**
 * The named targets that will NOT receive the event because they lack the
 * section permission. The settings UI shows these as a warning rather than
 * dropping them silently — the merchant asked for something the permission
 * model won't honour, and should be told why (and how to fix it: their role).
 */
export function ineligibleTargets<T extends RoutableRecipient>(
  eligible: readonly T[],
  rule: RoutingRule,
): string[] {
  if (rule.mode !== "admins") return [];
  const allowed = new Set(eligible.map((r) => r.id));
  return rule.admins.filter((id) => !allowed.has(id));
}
