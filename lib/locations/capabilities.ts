// What a location is allowed to DO — the registry behind the multi-location
// model (docs/inventory-fulfilment-roadmap.md §1.1, docs/locations-ia.md).
//
// A warehouse is a location with POS switched off; a dark store is one that
// fulfils online but nobody walks into. Rather than encoding those as types
// with hardcoded behaviour, a location carries a set of CAPABILITIES and the
// type only decides what gets ticked when it is created.
//
// Stored as `store_locations.capabilities` (jsonb), NOT as one boolean column
// per capability. A seventh capability is then a single entry here — no
// migration, and no new check to forget in a consumer. This mirrors
// lib/settings/registry.ts, which already works this way.
//
// PURE module: no DB, no server imports, fully testable.

import { planAllows, type Plan } from "@/lib/plans";

export const LOCATION_TYPES = ["shop", "warehouse", "dark_store"] as const;
export type LocationType = (typeof LOCATION_TYPES)[number];

export const LOCATION_TYPE_LABEL: Record<LocationType, string> = {
  shop: "Shop",
  warehouse: "Warehouse",
  dark_store: "Dark store",
};

export const LOCATION_CAPABILITIES = [
  "pos",
  "online_fulfil",
  "pickup",
  "returns",
  "receive_stock",
  "transfer_stock",
] as const;
export type LocationCapability = (typeof LOCATION_CAPABILITIES)[number];

export interface CapabilityDef {
  label: string;
  /** Shown under the checkbox — says what turning it on actually causes. */
  description: string;
  /** Must also be enabled. Someone has to physically hand goods over, so
   *  pickup and returns are meaningless without staff selling at the counter. */
  requires?: LocationCapability[];
  minPlan?: Plan;
  /** Ticked when a location of this type is CREATED. Not a runtime default —
   *  a stored `false` always wins (see resolveCapabilities). */
  defaultFor: Record<LocationType, boolean>;
}

const ALL_TYPES = (v: boolean): Record<LocationType, boolean> => ({
  shop: v,
  warehouse: v,
  dark_store: v,
});

export const CAPABILITY_REGISTRY: Record<LocationCapability, CapabilityDef> = {
  pos: {
    label: "Sell here",
    description: "Staff can ring up sales at this location.",
    // Nobody walks into a warehouse or a dark store.
    defaultFor: { shop: true, warehouse: false, dark_store: false },
  },
  online_fulfil: {
    label: "Fulfil online orders",
    description: "Website orders can be picked and shipped from here.",
    // A new SHOP does not silently start absorbing website orders — that is a
    // fulfilment decision the merchant makes deliberately.
    defaultFor: { shop: false, warehouse: true, dark_store: true },
  },
  pickup: {
    label: "Customer pickup",
    description: "Shoppers can collect online orders from here.",
    requires: ["pos"],
    minPlan: "pro",
    defaultFor: ALL_TYPES(false),
  },
  returns: {
    label: "Accept returns",
    description: "Online purchases can be handed back here.",
    requires: ["pos"],
    minPlan: "pro",
    defaultFor: ALL_TYPES(false),
  },
  receive_stock: {
    label: "Receive stock",
    description: "Deliveries can be booked in against this location.",
    defaultFor: ALL_TYPES(true),
  },
  transfer_stock: {
    label: "Stock transfers",
    description: "Stock can be sent to and received from other locations.",
    defaultFor: ALL_TYPES(true),
  },
};

export type CapabilityMap = Record<LocationCapability, boolean>;

export function isLocationType(v: unknown): v is LocationType {
  return (
    typeof v === "string" && (LOCATION_TYPES as readonly string[]).includes(v)
  );
}

export function isLocationCapability(v: unknown): v is LocationCapability {
  return (
    typeof v === "string" &&
    (LOCATION_CAPABILITIES as readonly string[]).includes(v)
  );
}

/** What gets ticked when a location of this type is created. */
export function defaultCapabilitiesFor(type: LocationType): CapabilityMap {
  const out = {} as CapabilityMap;
  for (const cap of LOCATION_CAPABILITIES) {
    out[cap] = CAPABILITY_REGISTRY[cap].defaultFor[type];
  }
  return out;
}

/**
 * Coerce whatever is in the jsonb column into a complete, valid map.
 *
 * Unknown keys are dropped and missing ones fall back to the type default, so
 * adding a capability to the registry gives every existing location a sensible
 * value without a migration — which is the point of storing this as jsonb.
 */
export function normalizeCapabilities(
  raw: unknown,
  type: LocationType,
): CapabilityMap {
  const out = defaultCapabilitiesFor(type);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (isLocationCapability(k) && typeof v === "boolean") out[k] = v;
  }
  return out;
}

export interface CapabilityContext {
  /** The store's EFFECTIVE plan (expired grants already resolved to free). */
  plan?: Plan;
}

/**
 * Can this location do `cap` right now?
 *
 * Three gates, all of which must pass: the stored flag, every capability in
 * `requires`, and the plan. Enforce this SERVER-side — a hidden checkbox is
 * not a permission (roadmap invariant 4).
 */
export function locationCan(
  caps: CapabilityMap,
  cap: LocationCapability,
  ctx: CapabilityContext = {},
): boolean {
  if (!caps[cap]) return false;

  const def = CAPABILITY_REGISTRY[cap];
  if (def.minPlan && ctx.plan && !planAllows(ctx.plan, def.minPlan)) {
    return false;
  }
  // A dependency that is off makes this one inert regardless of its own flag —
  // otherwise a store that turns POS off keeps offering collection at a
  // counter with nobody behind it.
  for (const dep of def.requires ?? []) {
    if (!caps[dep]) return false;
  }
  return true;
}

/**
 * Turning a capability OFF must also turn off whatever depends on it, or the
 * stored state disagrees with what locationCan reports. The editor applies
 * this so the checkboxes never lie.
 */
export function applyCapability(
  caps: CapabilityMap,
  cap: LocationCapability,
  next: boolean,
): CapabilityMap {
  const out = { ...caps, [cap]: next };
  if (!next) {
    for (const other of LOCATION_CAPABILITIES) {
      if (CAPABILITY_REGISTRY[other].requires?.includes(cap))
        out[other] = false;
    }
  }
  return out;
}

/** Capabilities stored ON that cannot currently take effect, and why. */
export function capabilityIssues(
  caps: CapabilityMap,
  ctx: CapabilityContext = {},
): Array<{ capability: LocationCapability; reason: string }> {
  const issues: Array<{ capability: LocationCapability; reason: string }> = [];
  for (const cap of LOCATION_CAPABILITIES) {
    if (!caps[cap]) continue;
    const def = CAPABILITY_REGISTRY[cap];
    const missing = (def.requires ?? []).filter((d) => !caps[d]);
    if (missing.length > 0) {
      issues.push({
        capability: cap,
        reason: `Needs ${missing.map((m) => CAPABILITY_REGISTRY[m].label).join(" and ")}.`,
      });
      continue;
    }
    if (def.minPlan && ctx.plan && !planAllows(ctx.plan, def.minPlan)) {
      issues.push({
        capability: cap,
        reason: `Available on the ${def.minPlan} plan.`,
      });
    }
  }
  return issues;
}

/** Capability labels to show as chips on the locations list. */
export function enabledCapabilityLabels(
  caps: CapabilityMap,
  ctx: CapabilityContext = {},
): string[] {
  return LOCATION_CAPABILITIES.filter((c) => locationCan(caps, c, ctx)).map(
    (c) => CAPABILITY_REGISTRY[c].label,
  );
}
