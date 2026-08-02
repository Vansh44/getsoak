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
  "pos.allowPriceOverride",
  "pos.ownerOnlyDiscounts",
  "pos.requireManagerForDiscount",
  "pos.maxDiscountPercent",
  "pos.requireOpenShift",
  "pos.cashVarianceTolerance",
  "fulfilment.offerPickup",
  "fulfilment.pickupReadyDays",
  "fulfilment.pickupHoldDays",
  "orders.allowCustomerCancellation",
  "orders.cancellationWindowHours",
  "returns.enabled",
  "returns.windowDays",
  "returns.selfServe",
  "returns.autoApprove",
  "returns.allowExchanges",
  "returns.restockingFeePercent",
  "returns.returnShippingFee",
  "returns.requireReason",
  "returns.requirePhotoForDamage",
  "returns.allowInStore",
  "returns.ownerOnlyRefunds",
  "returns.maxRefundWithoutApproval",
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
  {
    key: "pos.allowPriceOverride",
    label: "Allow price overrides at the register",
    description:
      "Let the till change an item's price during a sale. Turn off to make listed prices final. Who may do it is governed by the setting below.",
    group: "Point of Sale",
    section: "pos",
    type: "boolean",
    defaultValue: true,
    minPlan: "pro",
  },
  {
    key: "pos.ownerOnlyDiscounts",
    label: "Only the owner can give discounts",
    description:
      "Cashiers and managers cannot discount a sale, mark a line down, or override a price — not even with a manager's PIN. A price override is a discount by another name, so it is covered here too. Turn this off to let cashiers discount up to the limit below, with a manager approving anything larger.",
    group: "Point of Sale",
    section: "pos",
    type: "boolean",
    defaultValue: true,
    minPlan: "pro",
  },
  {
    key: "pos.requireManagerForDiscount",
    label: "Require a manager's PIN for large discounts",
    description:
      "Only applies when 'Only the owner can give discounts' is off. Cashiers must then get a manager's PIN to discount beyond the limit below (managers and owners are never prompted).",
    group: "Point of Sale",
    section: "pos",
    type: "boolean",
    defaultValue: true,
    minPlan: "pro",
  },
  {
    key: "pos.maxDiscountPercent",
    label: "Discount a cashier can give without approval",
    description:
      "Percent of the sale a cashier may discount before a manager's PIN is required. Only applies when 'Only the owner can give discounts' is off.",
    group: "Point of Sale",
    section: "pos",
    type: "number",
    defaultValue: 10,
    min: 0,
    max: 100,
    minPlan: "pro",
    dependsOn: "pos.requireManagerForDiscount",
  },
  {
    key: "pos.requireOpenShift",
    label: "Require an open shift to sell",
    description:
      "Cashiers must open the drawer with a counted float before ringing a sale. Off by default — turning it on can stop a till, so it is the merchant's call.",
    group: "Point of Sale",
    section: "pos",
    type: "boolean",
    defaultValue: false,
    minPlan: "pro",
  },
  {
    key: "pos.cashVarianceTolerance",
    label: "Cash variance tolerance",
    description:
      "Rupees a closing count may differ from expected before it is flagged as over or short. A drawer counted by hand is rarely exact.",
    group: "Point of Sale",
    section: "pos",
    type: "number",
    defaultValue: 0,
    min: 0,
    max: 10000,
    minPlan: "pro",
  },
  {
    key: "fulfilment.offerPickup",
    label: "Offer pickup at checkout",
    description:
      "Shoppers can collect from a shop instead of having it delivered. Only locations with the Customer pickup capability are offered.",
    group: "Checkout",
    section: "locations",
    type: "boolean",
    defaultValue: false,
    minPlan: "pro",
  },
  {
    key: "fulfilment.pickupReadyDays",
    label: "Orders are ready for collection in",
    description:
      "0 means same-day collection. Shown at checkout and in the confirmation email, and the hold window starts from this date.",
    group: "Checkout",
    section: "locations",
    type: "number",
    defaultValue: 0,
    min: 0,
    max: 30,
    minPlan: "pro",
    dependsOn: "fulfilment.offerPickup",
  },
  {
    key: "fulfilment.pickupHoldDays",
    label: "Hold uncollected orders for",
    description:
      "Counted from the day it's ready. After this, an uncollected order is cancelled and its stock returns to the shelf.",
    group: "Checkout",
    section: "locations",
    type: "number",
    defaultValue: 5,
    min: 1,
    max: 60,
    minPlan: "pro",
    dependsOn: "fulfilment.offerPickup",
  },
  {
    key: "orders.allowCustomerCancellation",
    label: "Let customers cancel their own orders",
    description:
      "A shopper can cancel from their order page while it hasn't shipped and is inside the window below. Stock returns automatically; the refund is still yours to approve.",
    group: "Orders",
    section: "orders",
    type: "boolean",
    // OFF: new behaviour on a live store, so it is the merchant's decision to
    // switch on (roadmap invariant 1). A store that has been handling
    // cancellations by phone must not silently start accepting them online.
    defaultValue: false,
  },
  {
    key: "orders.cancellationWindowHours",
    label: "Customers can cancel within",
    description:
      "Hours from when the order was placed. BOTH conditions must hold: past this window, or once it has shipped, the button becomes a request the store reviews rather than an instant cancellation.",
    group: "Orders",
    section: "orders",
    type: "number",
    defaultValue: 24,
    min: 1,
    max: 720,
    dependsOn: "orders.allowCustomerCancellation",
  },

  // ── Returns (docs/returns-exchanges-plan.md §2.2) ────────────────────────
  // Everything below hangs off `returns.enabled`, so a store that hasn't
  // switched returns on sees ONE switch rather than a wall of config for a
  // feature it doesn't use.
  {
    key: "returns.enabled",
    label: "Accept returns",
    description:
      "The master switch. Off, nothing here applies and no return can be started anywhere.",
    group: "Returns",
    section: "orders",
    type: "boolean",
    // ★ OFF. New behaviour on a live store is the merchant's decision
    // (roadmap invariant 1) — a shop that has never taken a return must not
    // wake up advertising one.
    defaultValue: false,
  },
  {
    key: "returns.windowDays",
    label: "Returns accepted within",
    description:
      "Days from DELIVERY, not from the order date — a window counted from checkout can expire before a slow parcel even arrives. Individual products can override this.",
    group: "Returns",
    section: "orders",
    type: "number",
    defaultValue: 7,
    min: 0,
    max: 365,
    dependsOn: "returns.enabled",
  },
  {
    key: "returns.selfServe",
    label: "Customers can start a return themselves",
    description:
      "Off, they have to contact you and you record the return yourself.",
    group: "Returns",
    section: "orders",
    type: "boolean",
    defaultValue: true,
    dependsOn: "returns.enabled",
  },
  {
    key: "returns.autoApprove",
    label: "Approve straightforward returns automatically",
    description:
      "Only ever applies to no-fault reasons. A claim that the item was damaged or wrong always goes to a person — otherwise anyone could waive your fees by picking that reason.",
    group: "Returns",
    section: "orders",
    type: "boolean",
    defaultValue: false,
    dependsOn: "returns.enabled",
  },
  {
    key: "returns.allowExchanges",
    label: "Offer exchanges as well as refunds",
    description:
      "An exchange keeps the sale — it costs you less than a refund, so it's on by default.",
    group: "Returns",
    section: "orders",
    type: "boolean",
    defaultValue: true,
    dependsOn: "returns.enabled",
  },
  {
    key: "returns.restockingFeePercent",
    label: "Restocking fee",
    description:
      "Percent of the returned goods value. NEVER charged when the return is your fault — damaged, faulty, wrong item, not as described, or late.",
    group: "Returns",
    section: "orders",
    type: "number",
    defaultValue: 0,
    min: 0,
    max: 50,
    dependsOn: "returns.enabled",
  },
  {
    key: "returns.returnShippingFee",
    label: "Return postage charged to the customer",
    description:
      "A flat amount deducted when they post it back. Waived on the same fault reasons as the restocking fee.",
    group: "Returns",
    section: "orders",
    type: "number",
    defaultValue: 0,
    min: 0,
    max: 10000,
    dependsOn: "returns.enabled",
  },
  {
    key: "returns.requireReason",
    label: "Ask why it's coming back",
    description:
      "The reason decides whether fees apply, so leaving it optional means fees rarely do.",
    group: "Returns",
    section: "orders",
    type: "boolean",
    defaultValue: true,
    dependsOn: "returns.enabled",
  },
  {
    key: "returns.requirePhotoForDamage",
    label: "Ask for a photo when something arrived damaged",
    description:
      "Only for claims a picture can actually settle — never for a change of mind.",
    group: "Returns",
    section: "orders",
    type: "boolean",
    defaultValue: true,
    dependsOn: "returns.requireReason",
  },
  {
    key: "returns.allowInStore",
    label: "Accept online returns in your shops",
    description:
      "Customers can bring an online order back to a counter. Each location still needs the Accept returns capability.",
    group: "Returns",
    section: "orders",
    type: "boolean",
    defaultValue: false,
    // Needs POS, which is Pro.
    minPlan: "pro",
    dependsOn: "returns.enabled",
  },
  {
    key: "returns.ownerOnlyRefunds",
    label: "Only the owner can refund",
    description:
      "Staff who manage orders can do everything else, but not send money back.",
    group: "Returns",
    section: "orders",
    type: "boolean",
    // Weaker than the POS discount rule ON PURPOSE: a refund leaves a physical
    // trace (the goods come back and can be counted), a discount leaves none.
    defaultValue: false,
  },
  {
    key: "returns.maxRefundWithoutApproval",
    label: "Refunds above this need the owner",
    description:
      "0 means no limit. Below it, anyone who manages orders can refund; above it, only the owner can.",
    group: "Returns",
    section: "orders",
    type: "number",
    defaultValue: 0,
    min: 0,
    max: 1000000,
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
