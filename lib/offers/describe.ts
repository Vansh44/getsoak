// ---------------------------------------------------------------------------
// One plain-English description of what an offer gives — `docs/offers-plan.md`.
//
// ★★ EXTRACTED BECAUSE THE TWO COPIES HAD ALREADY DIVERGED, and silently. The
// offer FORM built a full sentence covering all eleven reward types; the offers
// LIST had a three-branch stub written when there were three reward types, and
// it was never extended. Everything Phases C–H added therefore rendered in the
// list as `${percent ?? 0}% off` — so a working "buy 1, get 1 free" was listed
// as **"0% off"**, and a bundle, a gift, cashback and free delivery all read as
// "0% off" too. Nothing failed; the merchant was simply told their offer gives
// nothing.
//
// ★ CLIENT-SAFE. Both callers are `"use client"`, so this must never import the
// db client — the `lib/logs/failure-types.ts` split. It is pure formatting over
// values the caller already holds.
//
// ★ STRUCTURAL, NOT TIED TO EITHER CALLER'S TYPE. `OfferRow` (the list) and
// `OfferFormData` (the editor) both satisfy `RewardDescriptor` by having the
// same field names, so neither has to be reshaped and a new reward type is one
// branch here rather than one branch in each.
// ---------------------------------------------------------------------------

import type { OfferReward, OfferRewardType, OfferTriggerType } from "./types";

const inr = (n: unknown) =>
  `₹${Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

const int = (n: unknown) => Math.trunc(Number(n) || 0);

export interface RewardDescriptor {
  rewardType: OfferRewardType;
  percent?: number | null;
  amount?: number | null;
  unitPrice?: number | null;
  buyQuantity?: number | null;
  getQuantity?: number | null;
  getPercent?: number | null;
  tierMode?: "percent" | "amount";
  tiers?: readonly { minSubtotal: number; value: number }[];
  breaks?: readonly { minQuantity: number; percent: number }[];
  giftQuantity?: number | null;
  bundleQuantity?: number | null;
  bundlePrice?: number | null;
  creditAmount?: number | null;
}

export interface DescribeOptions {
  /** How many products/categories the offer is scoped to, for "(3 selected)".
   *  Omit where the caller does not know — the phrase simply drops. */
  scopeCount?: number;
  /** The gift product's name, when the caller can resolve it. */
  giftName?: string;
}

/** "over ₹1,000 → 10% off, over ₹2,000 → 15% off" */
function ladderPhrase(r: RewardDescriptor): string {
  if (r.rewardType === "tiered") {
    return (r.tiers ?? [])
      .map(
        (t) =>
          `over ${inr(t.minSubtotal)} → ${
            r.tierMode === "amount"
              ? `${inr(t.value)} off`
              : `${Number(t.value || 0)}% off`
          }`,
      )
      .join(", ");
  }
  return (r.breaks ?? [])
    .map((b) => `${int(b.minQuantity)}+ → ${Number(b.percent || 0)}% off`)
    .join(", ");
}

/**
 * What the customer gets, as one phrase a merchant recognises.
 *
 * ★ EXHAUSTIVE OVER `OFFER_REWARDS`. A `switch` rather than the nested
 * ternaries this replaced, so TypeScript's exhaustiveness check catches the
 * next reward type at compile time instead of letting it fall through to the
 * percentage branch and read as "0% off" — which is exactly how the list bug
 * survived five phases.
 */
export function describeReward(
  r: RewardDescriptor,
  opts: DescribeOptions = {},
): string {
  const scoped =
    typeof opts.scopeCount === "number" && opts.scopeCount > 0
      ? ` (${opts.scopeCount} selected)`
      : "";
  const gift = opts.giftName ?? "a gift";

  switch (r.rewardType) {
    case "percent_off":
      return `${Number(r.percent || 0)}% off the order`;
    case "amount_off":
      return `${inr(r.amount)} off the order`;
    case "percent_off_items":
      return `${Number(r.percent || 0)}% off chosen items${scoped}`;
    case "fixed_price":
      return `Chosen items${scoped} at ${inr(r.unitPrice)} each`;
    case "buy_x_get_y":
      return `Buy ${int(r.buyQuantity)}, get ${int(r.getQuantity)}${
        r.getPercent && r.getPercent < 100
          ? ` at ${r.getPercent}% off`
          : " free"
      }${scoped}`;
    case "tiered":
      return `Order discount by level: ${ladderPhrase(r) || "no levels yet"}`;
    case "volume_break":
      return `Chosen items${scoped} by quantity: ${
        ladderPhrase(r) || "no levels yet"
      }`;
    case "bundle_price":
      return `Any ${int(r.bundleQuantity)} chosen items${scoped} for ${inr(
        r.bundlePrice,
      )}`;
    case "free_item":
      return `Free ${gift}${
        int(r.giftQuantity) > 1 ? ` × ${int(r.giftQuantity)}` : ""
      }`;
    case "free_shipping":
      return "Free delivery";
    case "credit_back":
      return `${inr(r.creditAmount)} store credit back`;
    default: {
      // ★ A NEW REWARD TYPE FAILS HERE AT COMPILE TIME rather than rendering
      // as a wrong phrase at runtime.
      const exhaustive: never = r.rewardType;
      return exhaustive;
    }
  }
}

/** When it applies — the counterpart phrase, same contract. */
export function describeTrigger(
  triggerType: OfferTriggerType,
  minSubtotal?: number | null,
  opts: DescribeOptions = {},
): string {
  const scoped =
    typeof opts.scopeCount === "number" && opts.scopeCount > 0
      ? ` (${opts.scopeCount} selected)`
      : "";
  switch (triggerType) {
    case "min_subtotal":
      return `on orders over ${inr(minSubtotal)}`;
    case "contains_product":
    case "contains_category":
      return `when the basket includes them${scoped}`;
    case "always":
      return "on any order";
    default: {
      const exhaustive: never = triggerType;
      return exhaustive;
    }
  }
}

/**
 * Adapt an engine `OfferReward` (whose discriminant is `type`) to the shape
 * this module describes (`rewardType`).
 *
 * ★ ONE ADAPTER, in the module that owns the vocabulary. The two names exist
 * because `OfferReward` is a discriminated union the engine switches on, while
 * `OfferRow`/`OfferFormData` are flat records with a `rewardType` column — and
 * every OTHER field is already named identically, so this is the whole of the
 * difference.
 */
export function rewardDescriptor(r: OfferReward): RewardDescriptor {
  const { type, ...rest } = r;
  return { ...rest, rewardType: type };
}
