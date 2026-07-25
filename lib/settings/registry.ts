// ---------------------------------------------------------------------------
// Feature-settings registry — the single source of truth for every per-store
// configurable feature flag on the platform.
//
// StoreMink is settings-based by design: features ship with per-store toggles
// instead of hardcoded behavior. Add a new setting by appending to SETTING_KEYS
// and SETTINGS below — validation in the save action and plan gating derive
// from this catalog. Settings render on their OWNING FEATURE's settings page
// (e.g. the Blogs group lives at /dashboard/blogs/settings), gated by that
// feature's dashboard `section` permission.
//
// Values are stored per store under stores.settings.features (jsonb), e.g.
//   { "blogs.customerSubmissions": false }
// Anything not overridden falls back to the default here, so a brand-new store
// behaves sensibly with an empty settings object.
//
// Pure module (no server imports) so it can be shared by server components,
// server actions, client editors, and tests alike — mirrors permissions.ts.
// ---------------------------------------------------------------------------

// Plans live in lib/plans.ts (the plan catalog: ids, pricing, limits).
// Re-exported here so existing consumers of the registry keep working.
import { type Plan, normalizePlan, planAllows } from "@/lib/plans";

export { type Plan, normalizePlan, planAllows } from "@/lib/plans";

/** Where per-store overrides live inside stores.settings (jsonb). */
export const FEATURES_KEY = "features";

export const SETTING_KEYS = [
  "blogs.customerSubmissions",
  "blogs.requireApproval",
  "pages.customCode",
  "marketing.showAllCoupons",
  "inventory.simpleTrackDefault",
  "inventory.lowStockThreshold",
  "pos.enabled",
  "pos.idleLockMinutes",
] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];

export interface SettingDef {
  key: SettingKey;
  label: string;
  description: string;
  /** Display group in the settings editor (e.g. "Blogs"). */
  group: string;
  /** Dashboard permission section that governs this setting (permissions.ts).
   *  Viewing/saving it requires view/manage on this section. */
  section: string;
  type: "boolean" | "number";
  defaultValue: boolean | number;
  /** Minimum plan required to change this setting (locked to default below). */
  minPlan?: Plan;
  /** Another boolean setting this one only applies under (UI dims it when the
   *  parent is off; consumers must check the parent themselves). */
  dependsOn?: SettingKey;
  /** For number types: minimum allowed value */
  min?: number;
  /** For number types: maximum allowed value */
  max?: number;
  /** Not shown in the generic settings editor — driven by a dedicated control
   *  (e.g. pos.enabled is toggled by the Enable POS button, not a raw switch). */
  hidden?: boolean;
}

export const SETTINGS: readonly SettingDef[] = [
  {
    key: "blogs.customerSubmissions",
    label: "Customer blog submissions",
    description:
      "Let signed-in customers write and submit their own blog posts on your storefront.",
    group: "Blogs",
    section: "blogs",
    type: "boolean",
    defaultValue: true,
  },
  {
    key: "blogs.requireApproval",
    label: "Require approval before publishing",
    description:
      "Customer submissions wait in a review queue until an admin approves them. Turn off to let customer blogs go live immediately.",
    group: "Blogs",
    section: "blogs",
    type: "boolean",
    defaultValue: true,
    dependsOn: "blogs.customerSubmissions",
  },
  {
    key: "pages.customCode",
    label: "Allow custom code",
    description:
      "Let admins add custom HTML/CSS/JavaScript sections to pages. Code runs in a secure sandbox. Turn off to disable custom-code sections store-wide.",
    group: "Website",
    section: "builder",
    type: "boolean",
    defaultValue: true,
    // minPlan intentionally unset for now — gate to a paid plan when billing ships.
  },
  {
    key: "marketing.showAllCoupons",
    label: "Show all active coupons on storefront",
    description:
      "If enabled, all active coupons will be displayed to shoppers in the cart, overriding individual coupon visibility settings.",
    group: "Marketing",
    section: "marketing",
    type: "boolean",
    defaultValue: false,
  },
  {
    key: "inventory.simpleTrackDefault",
    label: "Track inventory for new simple products",
    description:
      "By default, new simple products (without variants) will have inventory tracking enabled.",
    group: "Inventory",
    section: "inventory",
    type: "boolean",
    defaultValue: false,
  },
  {
    key: "inventory.lowStockThreshold",
    label: "Store-wide low stock threshold",
    description:
      "When an item's stock falls to or below this number, it will be marked as 'Low Stock' unless overridden at the product level.",
    group: "Inventory",
    section: "inventory",
    type: "number",
    defaultValue: 5,
    min: 0,
    max: 1000,
  },
  {
    key: "pos.enabled",
    label: "Point of Sale",
    description:
      "Enable the in-store register at /pos for this store. Available on the Pro plan.",
    group: "Point of Sale",
    section: "pos",
    type: "boolean",
    defaultValue: false,
    minPlan: "pro",
    // Toggled via the Enable POS control on /dashboard/pos, not the raw editor.
    hidden: true,
  },
  {
    key: "pos.idleLockMinutes",
    label: "Auto-lock the register after",
    description:
      "Minutes of inactivity before the register locks and asks for the cashier's PIN again. Stops the next person selling as whoever walked away.",
    group: "Point of Sale",
    section: "pos",
    type: "number",
    defaultValue: 10,
    min: 1,
    max: 240,
    minPlan: "pro",
  },
];

const SETTING_BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]));

export function getSettingDef(key: string): SettingDef | undefined {
  return SETTING_BY_KEY.get(key as SettingKey);
}

/** Resolved values for every setting in the catalog. */
export type StoreSettingValues = Record<SettingKey, boolean | number>;

/**
 * Resolve a store's feature settings from its raw settings jsonb + plan:
 * defaults ← overridden by settings.features, except plan-locked settings,
 * which always resolve to their default. Unknown/non-boolean overrides are
 * ignored, so junk in the column can never break a storefront.
 */
export function resolveStoreSettings(
  settings: Record<string, unknown> | null | undefined,
  plan: unknown,
): StoreSettingValues {
  const p = normalizePlan(plan);
  const overrides = (settings?.[FEATURES_KEY] ?? {}) as Record<string, unknown>;
  const out = {} as StoreSettingValues;
  for (const def of SETTINGS) {
    const stored = overrides[def.key];
    if (planAllows(p, def.minPlan)) {
      if (def.type === "boolean" && typeof stored === "boolean") {
        out[def.key] = stored;
        continue;
      }
      if (def.type === "number" && typeof stored === "number") {
        out[def.key] = Math.max(
          def.min ?? -Infinity,
          Math.min(def.max ?? Infinity, stored),
        );
        continue;
      }
    }
    out[def.key] = def.defaultValue;
  }
  return out;
}
