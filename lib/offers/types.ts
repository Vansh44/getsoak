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

/**
 * Extra requirements layered ON TOP of the trigger. Every one must hold.
 *
 * ★★ A LIST, NOT MORE TRIGGER TYPES, and the reason is the offer merchants
 * actually want. "₹50 off prepaid orders over ₹500" is the commonest form of a
 * payment-method offer, and as alternative trigger types it is inexpressible —
 * you would have to pick between the threshold and the payment rule. The
 * primary trigger stays the shape the merchant chose from the preset list; a
 * condition refines it.
 *
 * ★ EVERY ONE MUST HOLD (AND, never OR). An OR would need grouping and
 * precedence, and a merchant reading their own offer back could not tell which
 * they had built. Two alternatives are two offers, which best-offer-wins
 * already resolves correctly.
 *
 * ★ CONDITIONS ARE CHECKED IN `disqualify`, alongside channel and location —
 * not in the claim pass. They answer "may this offer be considered", so a
 * failing one must produce a NAMED skip reason an operator can read, rather
 * than an offer that silently claims nothing.
 */
export const OFFER_CONDITIONS = [
  "payment_method",
  "fulfilment_type",
  "first_order",
  "time_window",
] as const;
export type OfferConditionType = (typeof OFFER_CONDITIONS)[number];

/** The methods a shopper can actually CHOOSE at checkout. */
export const OFFER_PAYMENT_METHODS = [
  "cod",
  "razorpay",
  "pay_at_store",
] as const;
export type OfferPaymentMethod = (typeof OFFER_PAYMENT_METHODS)[number];

export const OFFER_FULFILMENT_TYPES = ["delivery", "pickup"] as const;
export type OfferFulfilmentType = (typeof OFFER_FULFILMENT_TYPES)[number];

export type OfferCondition =
  | { type: "payment_method"; methods: OfferPaymentMethod[] }
  | { type: "fulfilment_type"; fulfilment: OfferFulfilmentType[] }
  | { type: "first_order" }
  | {
      type: "time_window";
      /** 0 = Sunday … 6 = Saturday, in the STORE's timezone. */
      days: number[];
      /** Minutes from midnight, store-local. `start > end` wraps past
       *  midnight, and the window is attributed to the day it BEGINS on. */
      startMinute: number;
      endMinute: number;
    };

export const MINUTES_PER_DAY = 24 * 60;

/**
 * Is this condition one only the website can answer?
 *
 * ★★ THE TILL CANNOT PRICE A TENDER-DEPENDENT DISCOUNT, and that is a hard
 * constraint rather than unfinished work. `lib/pos/totals.ts` exists because
 * the register screen and `placePosSale` must agree on one total (CODEBASE
 * §22) — and the till's flow is total-THEN-tender: the cashier reads the total,
 * then stages payment against it. A discount that depended on the tender would
 * change the total after it had been quoted to the customer, so the screen and
 * the sale would disagree by construction. Inverting that flow is a checkout
 * redesign, not a condition.
 *
 * `fulfilment_type` is website-only for a plainer reason: a register sale is
 * neither a delivery nor a collection. `orders.fulfilment_type` carries the
 * legacy `delivery` default for POS rows, which never meant a courier promise
 * (CODEBASE §22), so matching on it at a till would be matching on a
 * placeholder.
 *
 * Offers carrying one of these are REFUSED at save for a POS-inclusive
 * channel, rather than saved and silently never matching — §23's rule that a
 * control which always fails is worse than no control.
 */
export function isWebsiteOnlyCondition(type: OfferConditionType): boolean {
  return type === "payment_method" || type === "fulfilment_type";
}

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
  "tiered",
  "volume_break",
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
  /**
   * `tiered`: spend-more-save-more, as an ordered ladder. The HIGHEST
   * qualifying rung applies — never several at once.
   *
   * ★ ONE OFFER, NOT ONE PER RUNG. Three separate offers would compete under
   * best-offer-wins and the deepest would simply always win, which is the
   * opposite of a ladder. Holding the rungs together is what makes "spend
   * ₹2,000 for 15%" mean anything.
   */
  tiers?: { minSubtotal: number; value: number }[];
  /** `volume_break`: quantity ladder over the scoped set, highest rung wins. */
  breaks?: { minQuantity: number; percent: number }[];
  /** `tiered` only: whether each rung's `value` is a percentage or rupees. */
  tierMode?: "percent" | "amount";
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
    type === "buy_x_get_y" ||
    type === "volume_break"
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
  return type === "buy_x_get_y" || type === "volume_break";
}

/**
 * The rungs of a ladder reward, ordered lowest first and de-duplicated.
 *
 * ★ NORMALISED IN ONE PLACE because three consumers must agree on it: the
 * engine picking a rung, the validator refusing a bad ladder, and the near-miss
 * naming the NEXT rung. A ladder sorted differently in any of them would apply
 * one discount and advertise another.
 */
/**
 * `offers.reward_config` (jsonb) → a typed `OfferReward`.
 *
 * ★★ THE ONE DECODER, BECAUSE THE HAND-WRITTEN ONE SILENTLY DISABLED TWO WHOLE
 * REWARD TYPES. `loadLiveOffers` listed the fields it wanted — `percent` and
 * `amount` — and was never extended when `fixed_price` and `buy_x_get_y`
 * arrived. So a correctly configured "buy 1 get 1 free" reached the engine with
 * `buyQuantity` undefined, `claimGroupOffer` returned an empty claim, and the
 * cart discounted NOTHING. Nothing failed: the offers list showed it active,
 * the form read it back correctly (a SECOND, complete decoder), the live
 * summary sentence described it perfectly, and no error appeared anywhere. The
 * only symptom was a customer not getting their free item.
 *
 * A field-by-field copy is an invitation to forget one, and the thing you
 * forget is invisible. This decoder is exhaustive over the reward union, so the
 * compiler is what notices next time — and `types.test.ts` asserts every field
 * the editor can write survives the round trip.
 */
export function decodeReward(rewardType: string, config: unknown): OfferReward {
  const c = (config ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | undefined => {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const ladder = <K extends string>(
    raw: unknown,
    key: K,
  ):
    | ({ [P in K]: number } & { value?: number; percent?: number })[]
    | undefined => {
    if (!Array.isArray(raw)) return undefined;
    const out = raw
      .map((entry) => {
        const e = (entry ?? {}) as Record<string, unknown>;
        const at = num(e[key]);
        const value = num(e.value);
        const percent = num(e.percent);
        if (at === undefined) return null;
        if (value === undefined && percent === undefined) return null;
        return {
          [key]: at,
          ...(value === undefined ? {} : { value }),
          ...(percent === undefined ? {} : { percent }),
        };
      })
      .filter((e): e is NonNullable<typeof e> => e !== null);
    return out.length > 0
      ? (out as ({ [P in K]: number } & { value?: number; percent?: number })[])
      : undefined;
  };

  const type = (
    (OFFER_REWARDS as readonly string[]).includes(rewardType)
      ? rewardType
      : "percent_off"
  ) as OfferRewardType;

  return {
    type,
    percent: num(c.percent),
    amount: num(c.amount),
    unitPrice: num(c.unitPrice),
    buyQuantity: num(c.buyQuantity),
    getQuantity: num(c.getQuantity),
    getPercent: num(c.getPercent),
    maxSets: num(c.maxSets),
    tierMode: c.tierMode === "amount" ? "amount" : undefined,
    tiers: ladder(c.tiers, "minSubtotal") as OfferReward["tiers"],
    breaks: ladder(c.breaks, "minQuantity") as OfferReward["breaks"],
  };
}

/**
 * `offers.conditions` (jsonb) → typed conditions, dropping anything malformed.
 *
 * ★ LENIENT ON READ, STRICT ON WRITE — the `resolveStoreSettings` posture. A
 * condition type retired in a later release must stop applying rather than
 * making its offer unloadable, and an unrecognised one must never be treated as
 * "no condition" on an offer that was saved WITH one, which would silently
 * widen the offer to everybody. So an unknown type is dropped and the offer is
 * flagged: `decodeConditions` returns what it understood plus whether anything
 * was discarded, and the caller refuses the offer rather than running it looser
 * than the merchant configured it.
 */
export function decodeConditions(raw: unknown): {
  conditions: OfferCondition[];
  dropped: boolean;
} {
  if (raw === null || raw === undefined)
    return { conditions: [], dropped: false };
  if (!Array.isArray(raw)) return { conditions: [], dropped: true };

  const out: OfferCondition[] = [];
  let dropped = false;

  for (const entry of raw) {
    const e = (entry ?? {}) as Record<string, unknown>;
    const type = e.type;
    if (type === "first_order") {
      out.push({ type: "first_order" });
      continue;
    }
    if (type === "payment_method") {
      const methods = (Array.isArray(e.methods) ? e.methods : []).filter(
        (m): m is OfferPaymentMethod =>
          (OFFER_PAYMENT_METHODS as readonly unknown[]).includes(m),
      );
      // An empty allowlist is not "every method" — it is a condition that can
      // never hold, which would make the offer dead rather than unrestricted.
      if (methods.length === 0) {
        dropped = true;
        continue;
      }
      out.push({ type: "payment_method", methods: [...new Set(methods)] });
      continue;
    }
    if (type === "fulfilment_type") {
      const fulfilment = (
        Array.isArray(e.fulfilment) ? e.fulfilment : []
      ).filter((f): f is OfferFulfilmentType =>
        (OFFER_FULFILMENT_TYPES as readonly unknown[]).includes(f),
      );
      if (fulfilment.length === 0) {
        dropped = true;
        continue;
      }
      out.push({
        type: "fulfilment_type",
        fulfilment: [...new Set(fulfilment)],
      });
      continue;
    }
    if (type === "time_window") {
      const days = (Array.isArray(e.days) ? e.days : [])
        .map((d) => Number(d))
        .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
      const startMinute = Number(e.startMinute);
      const endMinute = Number(e.endMinute);
      const validMinute = (m: number) =>
        Number.isInteger(m) && m >= 0 && m < MINUTES_PER_DAY;
      if (
        days.length === 0 ||
        !validMinute(startMinute) ||
        !validMinute(endMinute) ||
        startMinute === endMinute
      ) {
        dropped = true;
        continue;
      }
      out.push({
        type: "time_window",
        days: [...new Set(days)].sort((a, b) => a - b),
        startMinute,
        endMinute,
      });
      continue;
    }
    dropped = true;
  }

  return { conditions: out, dropped };
}

/** Validation issues for a set of conditions, for the editor and the action. */
export function validateOfferConditions(
  conditions: readonly OfferCondition[],
  channels: readonly string[],
): OfferValidationIssue[] {
  const issues: OfferValidationIssue[] = [];

  if (conditions.length > OFFER_CONDITIONS.length) {
    issues.push({
      field: "conditions",
      message: "That is more conditions than there are kinds of condition.",
    });
    return issues;
  }

  // ★ ONE OF EACH KIND. Two payment-method conditions would have to be ANDed,
  // and the intersection of two allowlists is either one of them or nothing —
  // so the second is at best redundant and at worst silently kills the offer.
  const seen = new Set<string>();
  for (const c of conditions) {
    if (seen.has(c.type)) {
      issues.push({
        field: "conditions",
        message: "Each kind of condition can only be added once.",
      });
      return issues;
    }
    seen.add(c.type);
  }

  // Empty channels means every channel, so it includes POS.
  const reachesPos = channels.length === 0 || channels.includes("pos");

  for (const c of conditions) {
    if (reachesPos && isWebsiteOnlyCondition(c.type)) {
      issues.push({
        field: "conditions",
        message:
          c.type === "payment_method"
            ? "A payment-method condition only works on your website. The register shows the total before payment is taken, so it cannot change once a method is chosen. Set the offer to your website only."
            : "A delivery or pickup condition only works on your website — a register sale is neither. Set the offer to your website only.",
      });
      continue;
    }

    if (c.type === "payment_method" && c.methods.length === 0) {
      issues.push({
        field: "conditions",
        message: "Choose at least one payment method.",
      });
    }
    if (c.type === "fulfilment_type" && c.fulfilment.length === 0) {
      issues.push({
        field: "conditions",
        message: "Choose delivery, pickup, or both.",
      });
    }
    if (c.type === "time_window") {
      if (c.days.length === 0) {
        issues.push({
          field: "conditions",
          message: "Choose at least one day.",
        });
      }
      if (c.startMinute === c.endMinute) {
        issues.push({
          field: "conditions",
          message:
            "The start and end times are the same, so the offer would never apply. For all day, leave the time condition off.",
        });
      }
      for (const m of [c.startMinute, c.endMinute]) {
        if (!Number.isInteger(m) || m < 0 || m >= MINUTES_PER_DAY) {
          issues.push({
            field: "conditions",
            message: "Enter a valid start and end time.",
          });
          break;
        }
      }
    }
  }

  return issues;
}

export function sortedTiers<T extends { minSubtotal: number }>(
  tiers: readonly T[] | undefined,
): T[] {
  return [...(tiers ?? [])]
    .filter((t) => Number.isFinite(t.minSubtotal) && t.minSubtotal >= 0)
    .sort((a, b) => a.minSubtotal - b.minSubtotal);
}

export function sortedBreaks<T extends { minQuantity: number }>(
  breaks: readonly T[] | undefined,
): T[] {
  return [...(breaks ?? [])]
    .filter((b) => Number.isInteger(b.minQuantity) && b.minQuantity >= 1)
    .sort((a, b) => a.minQuantity - b.minQuantity);
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
  /** Extra requirements, ALL of which must hold. Empty = none. */
  conditions?: readonly OfferCondition[];
  /**
   * A stored condition could not be understood — an unknown type, or a
   * malformed payload.
   *
   * ★★ THE OFFER IS THEN REFUSED, NOT RUN LOOSER. Dropping an unreadable
   * condition and applying the offer anyway would silently widen it to
   * everybody: an offer the merchant restricted to first orders would start
   * discounting every order, with nothing to see. Failing closed costs a
   * discount somebody expected; failing open gives away money nobody
   * authorised. The `resolveStoreSettings` rule is lenient on READ for values
   * that only affect display — a restriction is not one of those.
   */
  conditionsUnreadable?: boolean;
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
    case "tiered": {
      const tiers = sortedTiers(reward.tiers);
      const mode = reward.tierMode ?? "percent";
      if (tiers.length < 1 || tiers.length > 10) {
        issues.push({
          field: "reward.tiers",
          message: "Add between one and ten spending levels.",
        });
        break;
      }
      if (mode !== "percent" && mode !== "amount") {
        issues.push({
          field: "reward.tierMode",
          message: "Choose a discount type.",
        });
        break;
      }
      // ★ DUPLICATE THRESHOLDS ARE REFUSED, not silently collapsed. Two rungs
      // at ₹1,000 make "the highest qualifying rung" ambiguous, and whichever
      // the sort happened to put last would win — a rule nobody could predict
      // from the merchant's own screen.
      const seen = new Set<number>();
      for (const t of tiers) {
        if (seen.has(t.minSubtotal)) {
          issues.push({
            field: "reward.tiers",
            message: "Two levels cannot start at the same order value.",
          });
          break;
        }
        seen.add(t.minSubtotal);
        const bad =
          mode === "percent"
            ? !(t.value > 0 && t.value <= MAX_PERCENT)
            : !(t.value > 0 && t.value <= MAX_AMOUNT);
        if (bad) {
          issues.push({
            field: "reward.tiers",
            message:
              mode === "percent"
                ? "Every level needs a percentage between 1 and 100."
                : "Every level needs an amount above zero.",
          });
          break;
        }
      }
      // ★ A LADDER MUST GO UP. A higher spend earning LESS is always a mistake,
      // and it is invisible on a form that shows the rungs in entry order.
      for (let i = 1; i < tiers.length; i += 1) {
        if (tiers[i].value <= tiers[i - 1].value) {
          issues.push({
            field: "reward.tiers",
            message:
              "Each level has to give more than the one below it, or the higher level does nothing.",
          });
          break;
        }
      }
      break;
    }
    case "volume_break": {
      const breaks = sortedBreaks(reward.breaks);
      if (breaks.length < 1 || breaks.length > 10) {
        issues.push({
          field: "reward.breaks",
          message: "Add between one and ten quantity levels.",
        });
        break;
      }
      const seenQty = new Set<number>();
      for (const b of breaks) {
        if (seenQty.has(b.minQuantity)) {
          issues.push({
            field: "reward.breaks",
            message: "Two levels cannot start at the same quantity.",
          });
          break;
        }
        seenQty.add(b.minQuantity);
        if (!(b.percent > 0 && b.percent <= MAX_PERCENT)) {
          issues.push({
            field: "reward.breaks",
            message: "Every level needs a percentage between 1 and 100.",
          });
          break;
        }
      }
      for (let i = 1; i < breaks.length; i += 1) {
        if (breaks[i].percent <= breaks[i - 1].percent) {
          issues.push({
            field: "reward.breaks",
            message:
              "Each quantity level has to give more than the one below it.",
          });
          break;
        }
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
