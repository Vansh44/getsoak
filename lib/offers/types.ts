// ---------------------------------------------------------------------------
// The offer registry — pure, client-safe, no imports with a runtime.
//
// `docs/offers-plan.md` §3: an offer is TRIGGER × REWARD × SCOPE, and the
// merchant-facing "types" (§7) are presets over that. So the catalogue of
// trigger and reward types lives HERE, in code, exhaustive and validated — the
// same trade `lib/settings/registry.ts` and `lib/notifications/events.ts` make.
//
// ★ THE TYPE IS A COLUMN; ITS PAYLOAD IS JSON. Every query filters on the type
// and every validation switches on it, so burying it in jsonb means no index
// and no constraint. The payload varies per type and is checked here.
//
// ★ CLIENT-SAFE ON PURPOSE. The offer editor, the storefront badge and the
// engine all need this vocabulary; `lib/offers/apply.ts` is pure too, but the
// DB-touching resolver is not, and it must never end up imported by a client
// component. Same split as `lib/logs/failure-types.ts` and `lib/themes/meta.ts`.
// ---------------------------------------------------------------------------

export const OFFER_CHANNELS = ["storefront", "pos"] as const;
export type OfferChannel = (typeof OFFER_CHANNELS)[number];

/** How the offer reaches a customer. A code is a DELIVERY METHOD, not a kind
 *  of offer (plan §2) — the same rule applies automatically or on a code. */
export const OFFER_DELIVERIES = ["automatic", "code", "link"] as const;
export type OfferDelivery = (typeof OFFER_DELIVERIES)[number];

export const OFFER_STATUSES = ["active", "disabled"] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

// --- Triggers --------------------------------------------------------------

export const OFFER_TRIGGERS = [
  "always",
  "min_subtotal",
  "contains_product",
  "contains_category",
] as const;
export type OfferTriggerType = (typeof OFFER_TRIGGERS)[number];

export interface OfferTrigger {
  type: OfferTriggerType;
  /** `min_subtotal` only: rupees. ★ Tested against the UNDISCOUNTED
   *  merchandise subtotal — see `apply.ts` for why that is not negotiable. */
  minSubtotal?: number;
}

/**
 * Does this trigger qualify on the CART's CONTENTS rather than its value?
 *
 * ★ A CONTENTS TRIGGER NEEDS NO PAYLOAD OF ITS OWN, and that is the whole
 * reason it is a separate predicate rather than a `productIds` field on the
 * trigger. `contains_product` / `contains_category` qualify when the offer's
 * EXISTING scope (`offer_products`) matches a line — so the merchant answers
 * "which products?" exactly once and it drives both what qualifies and what
 * gets discounted. Two lists would be a way for them to disagree.
 */
export function isContentsTrigger(type: OfferTriggerType): boolean {
  return type === "contains_product" || type === "contains_category";
}

// --- Rewards ---------------------------------------------------------------

export const OFFER_REWARDS = [
  "percent_off",
  "amount_off",
  "percent_off_items",
  "fixed_price",
  "buy_x_get_y",
] as const;
export type OfferRewardType = (typeof OFFER_REWARDS)[number];

export interface OfferReward {
  type: OfferRewardType;
  /** `percent_off` / `percent_off_items`: 0–100. */
  percent?: number;
  /** `amount_off`: rupees. */
  amount?: number;
  /** `fixed_price`: the per-UNIT price every matching line is charged, in
   *  rupees. "Any tee ₹499" — not ₹499 off, and not ₹499 for the line. */
  unitPrice?: number;
  /**
   * `buy_x_get_y`: how many units must be bought before the reward triggers,
   * and how many are then discounted.
   *
   * ★ THE SET IS `buyQuantity + getQuantity` UNITS, which is what makes "buy 1
   * get 1" mean two items rather than three. Four units are two complete sets,
   * three are one set plus one ordinary paid unit.
   */
  buyQuantity?: number;
  getQuantity?: number;
  /** How much off the "get" units: 100 is free, 50 is half price. Default 100. */
  getPercent?: number;
  /** Most sets one order may earn. `undefined` = unlimited. ★ A cart of 100
   *  units on buy-1-get-1 otherwise gives away 50 items, which merchants
   *  reliably do not mean the first time they build one. */
  maxSets?: number;
}

/**
 * Which level a reward acts on.
 *
 * ★ THE LEVEL IS DERIVED FROM THE TYPE, never stored. Storing both invites a
 * row where they disagree, and the engine's exclusivity rule (one offer per
 * line) is expressed in terms of the level — so a wrong level silently changes
 * which offers can coexist.
 */
export function rewardLevel(type: OfferRewardType): "order" | "line" {
  return type === "percent_off_items" ||
    type === "fixed_price" ||
    type === "buy_x_get_y"
    ? "line"
    : "order";
}

/**
 * Must this reward be valued across the WHOLE scoped set at once, rather than
 * line by line?
 *
 * ★ THIS IS THE DISTINCTION THE ENGINE'S CLAIM LOOP TURNS ON. Every earlier
 * reward is separable: a percentage or a target price on one line depends only
 * on that line, so the best offer per line can be chosen independently and the
 * result is exact. Buy-X-get-Y is not — "buy 2 get 1" over three lines of one
 * unit each is one set spanning three lines, and no per-line view can see it.
 * A group reward therefore gets its own claim pass (`claimGroupOffer`) which
 * competes against the per-line winners on the lines it wants.
 */
export function isGroupReward(type: OfferRewardType): boolean {
  return type === "buy_x_get_y";
}

/** Is this reward a percentage of the line, rather than a lump sum? Percentage
 *  rewards are per-line separable, which is what lets `onSalePrice: "best"`
 *  compare an offer price against a special price (see `apply.ts`). */
export function isPercentReward(type: OfferRewardType): boolean {
  return type === "percent_off" || type === "percent_off_items";
}

/**
 * Does this reward name a TARGET PRICE rather than a reduction?
 *
 * ★ IT IS NOT A PERCENTAGE AND NOT A LUMP SUM, so it belongs to neither
 * existing branch. A fixed price is worth *whatever the gap is* on each line —
 * ₹0 on a line already cheaper — which also means it is the one reward whose
 * value can be zero on a qualifying line without being a bug.
 */
export function isFixedPriceReward(type: OfferRewardType): boolean {
  return type === "fixed_price";
}

// --- How an offer treats a line already on a special price ------------------
// `offers.onSalePrice`, plan §14. The option list IS the validation.

export const ON_SALE_PRICE_MODES = ["best", "skip", "stack"] as const;
export type OnSalePriceMode = (typeof ON_SALE_PRICE_MODES)[number];

export function normalizeOnSalePriceMode(v: unknown): OnSalePriceMode {
  return (ON_SALE_PRICE_MODES as readonly string[]).includes(v as string)
    ? (v as OnSalePriceMode)
    : "best";
}

// --- The offer, as the engine receives it -----------------------------------

export interface Offer {
  id: string;
  /** Internal name. Snapshotted onto the order line when it applies, so a
   *  later rename cannot change what an issued invoice says (plan §8). */
  name: string;
  status: OfferStatus;
  delivery: OfferDelivery;
  /** Uppercased, for `code` and `link` delivery. */
  code: string | null;
  /** Higher wins ties. ★ Under best-offer-wins this is a TIE-BREAK only — it
   *  no longer selects (plan §10). */
  priority: number;
  /** ISO. The second tie-break, so equal savings at equal priority still
   *  resolve to one deterministic answer. */
  createdAt: string;
  validFrom: string | null;
  validUntil: string | null;
  /** Empty = every channel. */
  channels: readonly OfferChannel[];
  /** Empty = every location. */
  locationIds: readonly string[];
  /** Empty = every customer. Non-empty = members of these groups only. */
  groupIds: readonly string[];
  trigger: OfferTrigger;
  reward: OfferReward;
  /** Line scoping for a line-level reward. All three empty = every line. */
  productIds: readonly string[];
  variantIds: readonly string[];
  categoryIds: readonly string[];
  /** A redemption cap has been reached — resolved by the caller against the
   *  database, because the engine is pure. */
  exhausted?: boolean;
  /** Rupees left in this offer's budget cap; `null`/undefined = uncapped.
   *  ★ The engine CAPS an offer's contribution at this, rather than treating
   *  it as a yes/no. An offer with ₹40 left must give ₹40, not ₹200 — the
   *  alternative is a cap that overshoots by up to one order every time. */
  remainingBudget?: number | null;
}

// --- Validation -------------------------------------------------------------

export interface OfferValidationIssue {
  field: string;
  message: string;
}

const MAX_PERCENT = 100;
const MAX_AMOUNT = 10_000_000; // ₹1 crore — a sanity bound, not a business rule

/**
 * Validate a trigger/reward pair before it is stored.
 *
 * Pure and exhaustive: adding a type to `OFFER_TRIGGERS`/`OFFER_REWARDS`
 * without handling it here is a compile error, which is the point of the
 * switch being on a union rather than a string.
 */
export function validateOfferRule(
  trigger: OfferTrigger,
  reward: OfferReward,
  /** Whether the offer scopes any product, variant or category. Only a
   *  contents trigger cares; `undefined` skips that check for callers that
   *  validate the rule alone. */
  hasScope?: boolean,
): OfferValidationIssue[] {
  const issues: OfferValidationIssue[] = [];

  switch (trigger.type) {
    case "always":
      break;
    case "contains_product":
    case "contains_category":
      // ★ NO PAYLOAD, BUT IT DOES NEED A SCOPE. A contents trigger qualifies
      // off `offer_products`, so without scoping it means "contains anything"
      // — silently identical to `always`, on an offer the merchant built
      // expressly to be selective. `hasScope` is passed by the caller because
      // scoping lives in join tables, not in the rule.
      if (hasScope === false) {
        issues.push({
          field: "scope",
          message:
            "Choose the products or categories this offer applies to, or set the condition to “Any order”.",
        });
      }
      break;
    case "min_subtotal": {
      const v = trigger.minSubtotal;
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
        issues.push({
          field: "trigger.minSubtotal",
          message: "Enter the minimum order value.",
        });
      } else if (v > MAX_AMOUNT) {
        issues.push({
          field: "trigger.minSubtotal",
          message: "That minimum is too large.",
        });
      }
      break;
    }
    default: {
      const never: never = trigger.type;
      issues.push({
        field: "trigger.type",
        message: `Unknown trigger ${never}`,
      });
    }
  }

  switch (reward.type) {
    case "percent_off":
    case "percent_off_items": {
      const p = reward.percent;
      if (typeof p !== "number" || !Number.isFinite(p) || p <= 0) {
        issues.push({
          field: "reward.percent",
          message: "Enter a discount percentage above zero.",
        });
      } else if (p > MAX_PERCENT) {
        issues.push({
          field: "reward.percent",
          message: "A discount cannot exceed 100%.",
        });
      }
      break;
    }
    case "fixed_price": {
      const u = reward.unitPrice;
      // ★ STRICTLY ABOVE ZERO. A ₹0 target price hands goods over for nothing
      // and would do it WITHOUT reserving stock — which is the whole reason
      // gift-with-purchase is its own phase (plan §12). A free item must go
      // through that path, not through a price of zero here.
      if (typeof u !== "number" || !Number.isFinite(u) || u <= 0) {
        issues.push({
          field: "reward.unitPrice",
          message: "Enter the price each item should be, above zero.",
        });
      } else if (u > MAX_AMOUNT) {
        issues.push({
          field: "reward.unitPrice",
          message: "That price is too large.",
        });
      }
      break;
    }
    case "buy_x_get_y": {
      const buy = reward.buyQuantity;
      const get = reward.getQuantity;
      const pct = reward.getPercent ?? 100;
      const cap = reward.maxSets;
      const whole = (n: unknown) =>
        typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 100;
      if (!whole(buy) || !whole(get)) {
        issues.push({
          field: "reward.buyQuantity",
          message: "Enter how many to buy and how many to get, from 1 to 100.",
        });
      }
      if (
        typeof pct !== "number" ||
        !Number.isFinite(pct) ||
        pct <= 0 ||
        pct > 100
      ) {
        issues.push({
          field: "reward.getPercent",
          message:
            "The discount on the free items must be between 1% and 100%.",
        });
      }
      if (cap !== undefined && !whole(cap)) {
        issues.push({
          field: "reward.maxSets",
          message: "Leave the limit blank for no limit, or enter 1 or more.",
        });
      }
      break;
    }
    case "amount_off": {
      const a = reward.amount;
      if (typeof a !== "number" || !Number.isFinite(a) || a <= 0) {
        issues.push({
          field: "reward.amount",
          message: "Enter a discount amount above zero.",
        });
      } else if (a > MAX_AMOUNT) {
        issues.push({
          field: "reward.amount",
          message: "That discount is too large.",
        });
      }
      break;
    }
    default: {
      const never: never = reward.type;
      issues.push({ field: "reward.type", message: `Unknown reward ${never}` });
    }
  }

  return issues;
}

/** Offer codes are matched case-insensitively, stored uppercase with no
 *  spaces — the exact `normalizeCode` contract coupons already use, so a
 *  migrated coupon code keeps working verbatim. */
export function normalizeOfferCode(code: string): string {
  return code.trim().toUpperCase().replace(/\s+/g, "");
}
