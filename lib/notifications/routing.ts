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

/**
 * Where the recipients may be.
 *
 *   store          everyone in the store — today's behaviour, and the default
 *   event_location only staff assigned to the location the event happened at
 *
 * NOT a fourth mode. Location COMPOSES with all three: "people with the orders
 * permission, at this order's location" is a mode AND a scope, and making it a
 * mode would multiply the list every time another axis appears.
 */
export const ROUTING_SCOPES = ["store", "event_location"] as const;
export type RoutingScope = (typeof ROUTING_SCOPES)[number];

export interface RoutingRule {
  mode: RoutingMode;
  scope: RoutingScope;
  /** Role slugs, for mode "roles". */
  roles: string[];
  /** Admin uids, for mode "admins". */
  admins: string[];
}

export const DEFAULT_ROUTING: RoutingRule = {
  mode: "permission",
  scope: "store",
  roles: [],
  admins: [],
};

/** Anything routable has an id and the role slug it holds. */
export interface RoutableRecipient {
  id: string;
  roleSlug: string;
  /**
   * Locations this person is restricted to, or null for unrestricted — the
   * same contract as lib/locations/scope.ts. Absence is not restriction: an
   * admin nobody has assigned anywhere hears about everything, which is
   * exactly what happened before locations existed.
   */
  locationIds?: string[] | null;
}

export function isRoutingMode(value: unknown): value is RoutingMode {
  return (
    typeof value === "string" &&
    (ROUTING_MODES as readonly string[]).includes(value)
  );
}

export function isRoutingScope(value: unknown): value is RoutingScope {
  return (
    typeof value === "string" &&
    (ROUTING_SCOPES as readonly string[]).includes(value)
  );
}

/**
 * Normalise a stored/submitted rule. Junk in the column can never break a
 * fan-out: anything unrecognised falls back to "permission", and a targeted
 * mode with nothing selected does too — an empty target list means "the
 * merchant hasn't finished choosing", not "tell nobody", which would silently
 * black-hole a store's order alerts.
 */
export function normalizeRouting(
  input: {
    routing?: unknown;
    routing_scope?: unknown;
    target_roles?: unknown;
    target_admins?: unknown;
  },
  /** What to use when the merchant has chosen nothing. Per-event, because a
   *  collection is inherently about one shop while an ordinary order is not
   *  (EventDef.defaultScope). */
  fallbackScope: RoutingScope = "store",
): RoutingRule {
  const mode = isRoutingMode(input.routing) ? input.routing : "permission";
  // Scope is independent of mode, so it survives a mode that falls back.
  const scope = isRoutingScope(input.routing_scope)
    ? input.routing_scope
    : fallbackScope;
  const roles = toStringArray(input.target_roles);
  const admins = toStringArray(input.target_admins);

  if (mode === "roles" && roles.length === 0)
    return { ...DEFAULT_ROUTING, scope };
  if (mode === "admins" && admins.length === 0)
    return { ...DEFAULT_ROUTING, scope };
  if (mode === "permission") return { ...DEFAULT_ROUTING, scope };

  return { mode, scope, roles, admins };
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
  /** Where the event happened. Null for anything with no location — an online
   *  order before fulfilment routing, a blog comment, a plan change. */
  eventLocationId?: string | null,
): T[] {
  let out: T[];
  if (rule.mode === "permission") {
    out = [...eligible];
  } else if (rule.mode === "roles") {
    const wanted = new Set(rule.roles);
    out = eligible.filter((r) => wanted.has(r.roleSlug));
  } else {
    const wanted = new Set(rule.admins);
    out = eligible.filter((r) => wanted.has(r.id));
  }

  // Scope narrows what the mode selected — it never widens it.
  if (rule.scope !== "event_location") return out;

  // An event that belongs to no location can't be narrowed by one. Dropping
  // everyone would silently black-hole every online order alert, which is the
  // failure this whole module is written to avoid.
  if (!eventLocationId) return out;

  return out.filter((r) => {
    // Unrestricted staff hear about every location (owners, and anyone nobody
    // has assigned) — same contract as lib/locations/scope.ts.
    const locs = r.locationIds;
    if (locs === null || locs === undefined) return true;
    return locs.includes(eventLocationId);
  });
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
