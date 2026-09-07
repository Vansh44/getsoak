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
  "fulfilment.pickupPayment",
  "orders.allowCustomerCancellation",
  "orders.cancellationWindow",
  "orders.cancellationWindowHours",
  "orders.cancellationApproval",
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
  "offers.autoApply",
  "offers.showBadges",
  "offers.showNearMiss",
  "offers.onSalePrice",
  "offers.maxTotalDiscountPercent",
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
  type: "boolean" | "number" | "select";
  defaultValue: boolean | number | string;
  /** Minimum plan required to change this setting. */
  minPlan?: Plan;
  /** Runtime value while the plan is below minPlan. The stored override is
   *  deliberately untouched, so it is restored verbatim after an upgrade. */
  lockedValue?: boolean | number | string;
  /** Another boolean setting this one only applies under (UI dims it when the
   *  parent is off; consumers must check the parent themselves). */
  dependsOn?: SettingKey;
  /** For number types: minimum allowed value */
  min?: number;
  /** For number types: maximum allowed value */
  max?: number;
  /**
   * For select types: the allowed values, in the order they should render.
   *
   * ★ THIS IS THE VALIDATION, not a UI hint. `resolveStoreSettings` refuses a
   * stored value that is not in this list and falls back to the default — so a
   * value removed here stops applying the moment it is removed, rather than
   * lingering in a jsonb blob nobody reads. Choose ids that read as data
   * (`prepaid`), never as prose, because they are what ends up in the database.
   */
  options?: readonly { value: string; label: string; description?: string }[];
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
    minPlan: "basic",
    lockedValue: false,
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
    minPlan: "basic",
    lockedValue: false,
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
    key: "fulfilment.pickupPayment",
    label: "Payment for collection orders",
    description:
      "Whether a shopper collecting from a shop pays online when they order, or at the counter when they collect.",
    group: "Checkout",
    section: "locations",
    type: "select",
    // ★ `customer_choice` IS TODAY'S BEHAVIOUR, so it is the default: a
    // migration may not change what a live store does (roadmap invariant 1).
    defaultValue: "customer_choice",
    options: [
      {
        value: "customer_choice",
        label: "Let the customer choose",
        description: "Both options are offered at checkout.",
      },
      {
        value: "prepaid",
        label: "Pay online only",
        description:
          "Collection orders must be paid for when they are placed. Needs a connected payment gateway.",
      },
      {
        value: "at_store",
        label: "Pay at the counter only",
        description:
          "Nothing is charged online; the shop takes payment on collection.",
      },
    ],
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
    key: "orders.cancellationWindow",
    label: "Cancellation window",
    description:
      "How long after ordering a customer may ask to cancel. 'Until fulfilled' is the usual choice — it tracks your own packing rather than a guess at how long it takes.",
    group: "Orders",
    section: "orders",
    type: "select",
    // ★ A FIXED LIST, not just a number of hours. "Before you've packed it" is
    // the rule most merchants actually mean, and it cannot be expressed as a
    // duration — a shop that packs in 20 minutes and one that takes three days
    // both want the same rule, not two different numbers.
    defaultValue: "until_fulfilled",
    options: [
      {
        value: "none",
        label: "No cancellations",
        description: "Customers cannot cancel; they contact you instead.",
      },
      {
        value: "until_fulfilled",
        label: "Until fulfilled",
        description: "Any time before the order is marked fulfilled.",
      },
      {
        value: "1h",
        label: "1 hour",
        description: "Within an hour of ordering.",
      },
      {
        value: "24h",
        label: "24 hours",
        description: "Within a day of ordering.",
      },
      {
        value: "custom",
        label: "Custom hours",
        description: "Use the number of hours set below.",
      },
    ],
    dependsOn: "orders.allowCustomerCancellation",
  },
  {
    key: "orders.cancellationWindowHours",
    label: "Customers can cancel within",
    description:
      "Used only when the cancellation window above is set to Custom hours.",
    group: "Orders",
    section: "orders",
    type: "number",
    defaultValue: 24,
    min: 1,
    max: 720,
    dependsOn: "orders.allowCustomerCancellation",
  },
  {
    key: "orders.cancellationApproval",
    label: "Cancellation approval",
    description:
      "Whether a customer's cancellation request waits for you, or cancels the order straight away.",
    group: "Orders",
    section: "orders",
    type: "select",
    // ★ APPROVAL IS THE DEFAULT because automatic approval can move money with
    // nobody reviewing the request — the same argument owner-only discounts
    // make at the till (CODEBASE §22).
    defaultValue: "require_approval",
    options: [
      {
        value: "require_approval",
        label: "Require my approval",
        description: "Requests wait in Orders until you approve or decline.",
      },
      {
        value: "auto",
        label: "Approve automatically",
        description:
          "An eligible request cancels the order immediately. Restocks, and refunds per your choice below.",
      },
    ],
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
  // --- Offers (docs/offers-plan.md §15) -------------------------------------
  {
    key: "offers.autoApply",
    label: "Apply offers automatically",
    description:
      "Let offers apply themselves at checkout without a code. Offers set to use a discount code always work, whatever this is set to.",
    group: "Offers",
    section: "promotions",
    type: "boolean",
    // ★★ ON. It shipped OFF, and that was the wrong call twice over.
    //
    // The reasoning was invariant 1 — a live store that had only ever run
    // discount CODES must not wake up discounting by itself — and it was
    // sound in the abstract. In practice NOTHING ever wrote it true, so every
    // store on the platform had it off, and `disqualify` refused every
    // automatic offer with `auto_apply_off`: silently, with no error at
    // checkout or at the till, and with the Offers list still reporting the
    // offer as Active. The whole automatic half of the feature was inert from
    // the day it shipped.
    //
    // ⚠ THE COST OF FLIPPING IT, STATED PLAINLY. Any existing store that has
    // never touched this setting stores nothing, so it now resolves to ON —
    // and any automatic offer that store has ACTIVE begins applying. That is
    // exactly what invariant 1 warns about. It is accepted deliberately
    // (owner's call, 2026-09-06): an automatic offer is not something a
    // merchant creates by accident, the dashboard has to be able to promise
    // that an Active offer runs, and a store that genuinely wants codes only
    // switches this off once. A store that has already set it either way
    // keeps its stored value — an explicit `false` still wins.
    defaultValue: true,
  },
  {
    key: "offers.showBadges",
    label: "Show offer badges on your storefront",
    description:
      "Display a small “20% off” badge on product cards and product pages when an offer applies.",
    group: "Offers",
    section: "promotions",
    type: "boolean",
    defaultValue: true,
  },
  {
    key: "offers.showNearMiss",
    label: "Tell shoppers when they are close to an offer",
    description:
      "Show “add ₹200 more to get free delivery” in the cart. Never shown for offers that need a code or are limited to a customer group.",
    group: "Offers",
    section: "promotions",
    type: "boolean",
    defaultValue: true,
  },
  {
    key: "offers.onSalePrice",
    label: "Products already on a sale price",
    description: "What an offer does when a product already has a sale price.",
    group: "Offers",
    section: "promotions",
    type: "select",
    // ★ `best` IS THE MARGIN-SAFE DEFAULT, and that matters more here than
    // elsewhere: under best-offer-wins the engine actively seeks out the most
    // generous rule, so `stack` compounds two markdowns on the products
    // already sold cheapest. A merchant who wants "extra 20% off sale" picks
    // it deliberately; nobody arrives at it by accident.
    defaultValue: "best",
    options: [
      {
        value: "best",
        label: "Charge whichever is lower",
        description:
          "The customer pays the sale price or the offer price, whichever is cheaper. They are never combined.",
      },
      {
        value: "skip",
        label: "Skip products on a sale price",
        description: "Offers do not apply to anything already discounted.",
      },
      {
        value: "stack",
        label: "Apply the offer on top of the sale price",
        description:
          "Discounts twice. This is what an “extra 20% off sale” promotion needs.",
      },
    ],
  },
  {
    key: "offers.maxTotalDiscountPercent",
    label: "Most an offer may take off one order",
    description:
      "A ceiling on how deep any single order can be discounted, whatever combination of offers applies. Set to 0 to stop offers discounting anything.",
    group: "Offers",
    section: "promotions",
    type: "number",
    defaultValue: 50,
    min: 0,
    max: 100,
  },
];

const SETTING_BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]));

export function getSettingDef(key: string): SettingDef | undefined {
  return SETTING_BY_KEY.get(key as SettingKey);
}

/**
 * A numeric setting read from a RAW stored value, bounded by its own definition.
 *
 * ★★ A REAL 0 IS NOT AN ABSENT VALUE. `offers.maxTotalDiscountPercent` is
 * declared `min: 0` and documented as "set to 0 to stop offers discounting
 * anything", so 0 is a deliberate choice — and two readers gated on
 * `value > 0`, which treats that choice as unset and substitutes the permissive
 * 50% default. The merchant who locked it down hardest silently got the loosest
 * behaviour. Exactly the trap CODEBASE.md §22 records for
 * `pos.maxDiscountPercent`, where `Number(x) || 10` ate a deliberate cap of
 * zero, and §28 for `products.return_window_days`.
 *
 * ★ THE BOUNDS COME FROM THE DEFINITION, not the call site. Every raw reader
 * had hardcoded its own default, floor and ceiling, so getting one wrong was a
 * local edit nobody else could see and repricing a default meant finding them
 * all.
 *
 * `resolveStoreSettings` below already validates and clamps everything it
 * returns; this is for the callers that read `stores.settings.features`
 * straight out of the jsonb column — inside a transaction, or where a resolved
 * read would cost a round trip — and therefore have nothing validating for them.
 */
export function resolveRawNumberSetting(key: SettingKey, raw: unknown): number {
  const def = getSettingDef(key);
  const fallback = typeof def?.defaultValue === "number" ? def.defaultValue : 0;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
  const min = typeof def?.min === "number" ? def.min : -Infinity;
  const max = typeof def?.max === "number" ? def.max : Infinity;
  return Math.min(Math.max(raw, min), max);
}

/** Resolved values for every setting in the catalog. */
export type StoreSettingValues = Record<SettingKey, boolean | number | string>;

/**
 * Resolve a store's feature settings from its raw settings jsonb + plan:
 * defaults ← overridden by settings.features, except plan-locked settings,
 * which resolve to their explicit locked value (or default). Stored overrides
 * are never changed by resolution. Unknown/non-boolean overrides are
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
      // ★ A STORED VALUE THAT IS NO LONGER AN OPTION FALLS BACK TO THE DEFAULT.
      // Options live in code; the stored value is a jsonb blob nobody migrates.
      // Accepting an unrecognised one would let a policy that was retired keep
      // applying for every store that had selected it, invisibly — the same
      // reason resolvePricing ignores a row for a plan id that no longer exists.
      if (
        def.type === "select" &&
        typeof stored === "string" &&
        def.options?.some((o) => o.value === stored)
      ) {
        out[def.key] = stored;
        continue;
      }
    }
    out[def.key] =
      !planAllows(p, def.minPlan) && def.lockedValue !== undefined
        ? def.lockedValue
        : def.defaultValue;
  }
  return out;
}
