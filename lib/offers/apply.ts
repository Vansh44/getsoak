// ---------------------------------------------------------------------------
// The offer engine — pure. `docs/offers-plan.md` §9, §10.
//
// ★ ONE IMPLEMENTATION, CALLED BY EVERY SURFACE: `placeOrder` (the charge),
// `placePosSale` (the charge at the till), `posTotals` (what the cashier
// quotes), the cart/checkout summary (what the shopper sees), and the offer
// editor's historical replay. This is not a style preference — it is the
// `posTotals` incident, where the till screen quoted ₹238 and the server
// charged ₹249.90, so ₹300 cash came back ₹50.10 instead of the promised ₹62
// while the same panel said "Paid in full ₹238". An engine reachable only from
// `placeOrder` guarantees a second implementation appears for the till.
//
// The server still re-reads prices, stock and rates from the database and
// re-resolves which offers are live. This file is ARITHMETIC, not
// authorisation: nothing a client sends about an offer is trusted beyond a
// code string.
//
// ── BEST OFFER WINS (owner, 2026-09-02) ───────────────────────────────────
// Exclusive selection BY VALUE. One offer per line, one order-level offer.
// `priority` is a tie-break, not a selector.
//
// ★ IT IS A BOUNDED SCENARIO COMPARISON, NOT A SEARCH. Optimal assignment over
// N overlapping offers is exponential and its cost would scale with how many
// offers a merchant happens to create; a till cannot spend 200ms on it. So we
// evaluate a bounded set of scenario SHAPES and take the best-scoring one:
//
//   line_and_order   line offers claim their lines; the order offer claims the rest
//   order_only       the order offer claims every line; no line offers
//   line_only        line offers only (also the base case when no order offer exists)
//
// The first two are evaluated once per order-level candidate, so the total is
// `2 × |orderCandidates| + 1`, each O(lines × lineCandidates), with every term
// bounded by MAX_EVALUATED_OFFERS.
//
// ★ WHY `order_only` IS NOT DOMINATED BY `line_and_order`, which is the thing
// that makes this comparison worth doing at all. Because a line carries at
// most ONE offer, a line claimed by a line-level offer is REMOVED from the
// order offer's base. So: 5% off Shakes (a ₹100 line → ₹5) plus 20% off order,
// on a cart of ₹100 shakes + ₹900 other —
//     line_and_order = ₹5 + 20% × ₹900 = ₹185
//     order_only     =      20% × ₹1,000 = ₹200   ← wins
// A merchant's small category discount must not cost the shopper the bigger
// order discount. If exclusivity ever changes so that both can touch one line,
// this comparison becomes redundant and should be deleted, not left running.
//
// ★ `line_only` IS PROVABLY DOMINATED BY `line_and_order` (the order offer
// contributes ≥ 0 to the same line set) and is evaluated anyway, because it is
// the only scenario available when there are no order-level candidates. Do not
// "optimise" it away as dead — it is the base case.
// ---------------------------------------------------------------------------

import { allocateProportional, toPaise, toRupees } from "@/lib/money/allocate";
import {
  isContentsTrigger,
  isFixedPriceReward,
  isGroupReward,
  sortedTiers,
  sortedBreaks,
  isPercentReward,
  normalizeOfferCode,
  rewardLevel,
  type Offer,
  type OfferChannel,
  type OfferRewardType,
  type OnSalePriceMode,
} from "./types";

/** At most this many live offers enter evaluation, ordered by priority then
 *  age. ★ A merchant with 200 active offers must not make the register slow,
 *  and an unbounded candidate set makes the engine's cost a function of
 *  merchant behaviour, which cannot be tested. */
export const MAX_EVALUATED_OFFERS = 20;

/** Near-miss nudges are dropped once the gap exceeds the cart itself (with a
 *  floor for small carts). Telling somebody they are ₹4,000 short is not
 *  encouragement; it is a reminder that they cannot afford it. */
export const NEAR_MISS_FLOOR = 500;
export const NEAR_MISS_LIMIT = 3;

// --- Inputs -----------------------------------------------------------------

export interface OfferLine {
  /** Stable line key — `lineKey(productId, variantId)` in the cart, or the
   *  `order_items.id` when replaying a stored order. */
  id: string;
  productId: string;
  variantId?: string | null;
  categoryId?: string | null;
  quantity: number;
  /** The unit price that WILL be charged before any offer. Already reflects
   *  `product_variants.special_price` when one is in effect. */
  unitPrice: number;
  /** The non-sale unit price, when `unitPrice` is a special price. Absent or
   *  equal ⇒ the line is not on sale, and every `onSalePrice` mode collapses
   *  to the same arithmetic. */
  regularUnitPrice?: number | null;
  /** Manual per-line markdown (a damaged tin at the till). Offers work on the
   *  amount left AFTER it — a markdown is a human decision about this specific
   *  item and an offer must not undo or double it. */
  lineDiscount?: number;
}

export interface OfferContext {
  channel: OfferChannel;
  /** The register's own location for a POS sale, or the fulfilment location
   *  online. ★ Never a client-supplied value. */
  locationId?: string | null;
  customerId?: string | null;
  groupIds?: readonly string[];
  /** Injected, never `new Date()` inside — a pure function that reads the
   *  clock cannot be tested at a boundary. */
  now: Date;
  /** The code the shopper or cashier entered, if any. */
  code?: string | null;
  /** `offers.onSalePrice` (plan §14). */
  onSalePrice: OnSalePriceMode;
  /** `offers.maxTotalDiscountPercent` (plan §11) — the per-order depth
   *  ceiling that best-offer-wins makes load-bearing. */
  maxTotalDiscountPercent: number;
  /** `offers.autoApply`. Off ⇒ only code/link offers can apply, which is the
   *  backfill state for every existing store. */
  autoApply: boolean;
}

// --- Outputs ----------------------------------------------------------------

export type ScenarioId = "line_and_order" | "order_only" | "line_only";

export type SkipReason =
  | "disabled"
  | "not_started"
  | "expired"
  | "wrong_channel"
  | "wrong_location"
  | "not_in_group"
  | "code_required"
  | "auto_apply_off"
  | "exhausted"
  | "no_budget"
  | "trigger_unmet"
  | "no_eligible_lines"
  | "beyond_candidate_cap"
  | "outscored";

export interface OfferAllocation {
  lineId: string;
  offerId: string;
  /** Snapshotted so a rename or delete cannot change an issued invoice. */
  offerName: string;
  amount: number;
}

export interface AppliedOffer {
  offerId: string;
  offerName: string;
  code: string | null;
  rewardType: OfferRewardType;
  level: "order" | "line";
  amount: number;
}

export interface NearMissOffer {
  offerId: string;
  offerName: string;
  /**
   * What is missing. `spend` is rupees short of a threshold; `units` is items
   * short of completing a buy-X-get-Y set.
   *
   * ★ TWO SHAPES, NOT ONE NUMBER. "Add ₹200 more" and "add 1 more shake" are
   * different sentences, and a single `gap` field would force the UI to guess
   * which it was holding — the exact ambiguity that makes a nudge say
   * something false.
   */
  kind: "spend" | "units";
  gap: number;
  rewardType: OfferRewardType;
  percent?: number;
  amount?: number;
  /** `units` only: how many the offer gives once the set completes. */
  getQuantity?: number;
  /**
   * What the cart earns from this offer RIGHT NOW, when the gap buys an
   * upgrade rather than the offer itself. Absent means the offer does not
   * apply yet.
   *
   * ★ THIS IS WHAT MAKES A LADDER WORTH BUILDING. "Spend ₹200 more for 15%
   * off" is a different and far stronger sentence than "spend ₹200 more for
   * 15% off" when the shopper already has 10% — the second needs "instead of
   * 10%" to mean anything, and without these fields the UI cannot tell the two
   * situations apart. It would then either omit the comparison (making the
   * nudge look like an offer they do not have) or invent one.
   */
  currentPercent?: number;
  currentAmount?: number;
}

export interface OfferResult {
  /** Merchandise subtotal after manual markdowns, before any offer. */
  subtotal: number;
  /** Per-line allocated offer discount, in input order. Feeds
   *  `order_items.offer_discount` and `computeTax`'s per-line discount. */
  lines: { id: string; offerDiscount: number }[];
  /** Σ of the per-line allocations. */
  discount: number;
  applied: AppliedOffer[];
  /** One row per (line, offer) — feeds `order_item_offers`. */
  allocations: OfferAllocation[];
  /** Offers the cart ALMOST qualifies for. Sorted nearest-first; the UI shows
   *  one (plan §14b). */
  nearMiss: NearMissOffer[];
  /** ★ What the engine chose AND what it rejected. This is what makes "why
   *  did this customer get X and not Y" answerable at a counter, and what
   *  lets a test assert the DECISION rather than only the final number. */
  scenario: {
    chosen: ScenarioId | null;
    scores: { id: ScenarioId; offerId: string | null; discount: number }[];
  };
  skipped: { offerId: string; reason: SkipReason }[];
  /** True when the per-order depth ceiling bit. Surfaced so the merchant can
   *  be told their ceiling is shaping what customers actually get. */
  cappedByCeiling: boolean;
}

// --- Internals --------------------------------------------------------------

interface PricedLine {
  index: number;
  id: string;
  /** Charged amount for the line, after any manual markdown, in paise. */
  netPaise: number;
  /** The same line valued at the REGULAR (non-sale) price, in paise. Equal to
   *  `netPaise` when the line is not on a special price. */
  regularPaise: number;
  onSale: boolean;
  line: OfferLine;
}

function priceLines(lines: readonly OfferLine[]): PricedLine[] {
  return lines.map((line, index) => {
    const qty = Math.max(0, Math.trunc(Number(line.quantity) || 0));
    const unit = Math.max(0, Number(line.unitPrice) || 0);
    const grossPaise = toPaise(unit) * qty;
    const markdownPaise = Math.min(
      Math.max(0, toPaise(Number(line.lineDiscount) || 0)),
      grossPaise,
    );
    const netPaise = grossPaise - markdownPaise;

    const regularUnit = Number(line.regularUnitPrice);
    const hasRegular = Number.isFinite(regularUnit) && regularUnit > unit;
    const regularPaise = hasRegular
      ? Math.max(toPaise(regularUnit) * qty - markdownPaise, netPaise)
      : netPaise;

    return {
      index,
      id: line.id,
      netPaise,
      regularPaise,
      onSale: hasRegular,
      line,
    };
  });
}

/** Does a line-level offer's scoping cover this line? All three lists empty =
 *  every line, which is what makes "20% off everything" one row. */
function offerCoversLine(offer: Offer, pl: PricedLine): boolean {
  const { productIds, variantIds, categoryIds } = offer;
  if (
    productIds.length === 0 &&
    variantIds.length === 0 &&
    categoryIds.length === 0
  ) {
    return true;
  }
  if (pl.line.variantId && variantIds.includes(pl.line.variantId)) return true;
  if (productIds.includes(pl.line.productId)) return true;
  if (pl.line.categoryId && categoryIds.includes(pl.line.categoryId)) {
    return true;
  }
  return false;
}

/**
 * The highest rung of a `tiered` reward the cart has reached, or null.
 *
 * ★ HIGHEST QUALIFYING, NEVER CUMULATIVE. A ₹2,500 cart on a 5/10/15 ladder
 * gets 15%, not 30%. Summing the rungs is the mistake this function exists to
 * make impossible, and it is the reading every merchant means.
 *
 * ★ MEASURED ON THE UNDISCOUNTED SUBTOTAL, like `min_subtotal` — for the same
 * anti-circularity reason: a rung that lowered the subtotal below its own
 * threshold would deselect itself, and the answer would depend on evaluation
 * order rather than on the cart.
 */
function activeTier(
  offer: Offer,
  subtotalPaise: number,
): { minSubtotal: number; value: number } | null {
  let chosen: { minSubtotal: number; value: number } | null = null;
  for (const tier of sortedTiers(offer.reward.tiers)) {
    if (subtotalPaise >= toPaise(tier.minSubtotal)) chosen = tier;
    else break;
  }
  return chosen;
}

/** Units of the offer's scope present in the cart and still available to it. */
function scopedUnits(
  offer: Offer,
  priced: readonly PricedLine[],
  mode: OnSalePriceMode,
  excluded?: readonly (string | null)[],
): number {
  let units = 0;
  for (const pl of priced) {
    if (!lineEligible(pl, mode)) continue;
    if (excluded && excluded[pl.index] !== null) continue;
    if (!offerCoversLine(offer, pl)) continue;
    units += Math.max(0, Math.trunc(Number(pl.line.quantity) || 0));
  }
  return units;
}

/** The highest quantity rung `units` has reached, or null. */
function activeBreak(
  offer: Offer,
  units: number,
): { minQuantity: number; percent: number } | null {
  let chosen: { minQuantity: number; percent: number } | null = null;
  for (const b of sortedBreaks(offer.reward.breaks)) {
    if (units >= b.minQuantity) chosen = b;
    else break;
  }
  return chosen;
}

/**
 * What a PERCENTAGE reward is worth on one line, in paise, honouring
 * `onSalePrice`.
 *
 * ★ `best` IS THE ONLY MODE THAT NEEDS THE REGULAR PRICE. It asks "would this
 * item be cheaper at the special price, or at the offer price off the regular
 * price?" and charges the lower — so the offer's contribution is whatever it
 * beats the special price BY, and zero when it does not. `stack` discounts the
 * special price again; `skip` declines the line entirely.
 */
function percentRewardPaise(
  percent: number,
  pl: PricedLine,
  mode: OnSalePriceMode,
): number {
  const pct = Math.min(Math.max(0, percent), 100);
  if (pct <= 0) return 0;

  if (!pl.onSale) return Math.round((pl.netPaise * pct) / 100);

  switch (mode) {
    case "skip":
      return 0;
    case "stack":
      return Math.round((pl.netPaise * pct) / 100);
    case "best": {
      const offerPricePaise =
        pl.regularPaise - Math.round((pl.regularPaise * pct) / 100);
      // Only the amount by which the offer beats the special price is a
      // discount; if the special price is already lower, the offer adds nothing.
      return Math.max(0, pl.netPaise - offerPricePaise);
    }
  }
}

/**
 * What a FIXED PRICE reward is worth on one line, in paise.
 *
 * "Any tee ₹499" names the price each UNIT is charged, so the discount is the
 * gap between what the line costs now and `unitPrice × quantity` — and it is
 * ZERO on a line already at or below that price. ★ It never goes negative: a
 * fixed price makes things cheaper or does nothing, it does not mark an item
 * UP to meet the offer.
 *
 * `onSalePrice` reads naturally here because the reward produces a price:
 * `best` charges whichever of the special price and the fixed price is lower
 * (so the offer contributes only what it beats the special price by), `stack`
 * is meaningless for a target price and behaves as `best` — discounting a
 * fixed price again would produce a number the merchant never named — and
 * `skip` declines the line.
 */
function fixedPriceRewardPaise(
  unitPrice: number,
  pl: PricedLine,
  mode: OnSalePriceMode,
): number {
  const target = toPaise(unitPrice);
  if (!Number.isFinite(target) || target <= 0) return 0;
  const qty = Math.max(0, Math.trunc(Number(pl.line.quantity) || 0));
  if (qty <= 0) return 0;
  if (pl.onSale && mode === "skip") return 0;
  // The line's charge at the offer's price. Compared against what is actually
  // being charged now, which already reflects any special price.
  const offerLinePaise = target * qty;
  return Math.max(0, pl.netPaise - offerLinePaise);
}

/** Is this line available to an offer at all under the current mode? */
function lineEligible(pl: PricedLine, mode: OnSalePriceMode): boolean {
  if (pl.netPaise <= 0) return false;
  if (pl.onSale && mode === "skip") return false;
  return true;
}

/**
 * Value a BUY-X-GET-Y offer across its whole scoped set.
 *
 * ★ IT WORKS IN UNITS, NOT LINES, and that is the whole reason it cannot live
 * in the per-line loop. "Buy 2 get 1" over three separate lines of one unit
 * each is ONE set spanning three lines; a line of quantity 4 is two sets inside
 * one line. So every eligible line is flattened into its units, and the sets
 * are counted over that flat list.
 *
 * ★ THE CHEAPEST UNITS ARE THE DISCOUNTED ONES. That is the universal retail
 * convention ("3 for the price of 2" charges you for the dearest two), it is
 * the customer-favourable reading of an ambiguous promise, and — because ties
 * break on line index — it is deterministic, so the same basket always produces
 * the same receipt.
 */
function claimGroupOffer(
  priced: readonly PricedLine[],
  offer: Offer,
  mode: OnSalePriceMode,
  excluded: readonly (string | null)[],
): Claim {
  if (offer.reward.type === "volume_break") {
    return claimVolumeOffer(priced, offer, mode, excluded);
  }
  const claim = emptyClaim(priced.length);
  const buy = Math.trunc(offer.reward.buyQuantity ?? 0);
  const get = Math.trunc(offer.reward.getQuantity ?? 0);
  if (buy < 1 || get < 1) return claim;

  const pct = Math.min(Math.max(0, offer.reward.getPercent ?? 100), 100);
  if (pct <= 0) return claim;

  // One entry per UNIT of every line the offer may touch, carrying that unit's
  // own price so the cheapest can be found across lines.
  const units: { index: number; unitPaise: number }[] = [];
  for (const pl of priced) {
    if (!lineEligible(pl, mode)) continue;
    if (excluded[pl.index] !== null) continue;
    if (!offerCoversLine(offer, pl)) continue;
    const qty = Math.max(0, Math.trunc(Number(pl.line.quantity) || 0));
    if (qty <= 0) continue;
    // Integer division leaves the remainder unallocated rather than rounding a
    // unit up: a unit must never be valued above its share of the line.
    const unitPaise = Math.floor(pl.netPaise / qty);
    for (let i = 0; i < qty; i += 1) units.push({ index: pl.index, unitPaise });
  }

  const setSize = buy + get;
  if (units.length < setSize) return claim;

  let sets = Math.floor(units.length / setSize);
  const cap = offer.reward.maxSets;
  if (typeof cap === "number" && Number.isFinite(cap)) {
    sets = Math.min(sets, Math.max(0, Math.trunc(cap)));
  }
  if (sets < 1) return claim;

  // Cheapest first, ties by line index so the outcome is reproducible.
  const order = [...units].sort(
    (a, b) => a.unitPaise - b.unitPaise || a.index - b.index,
  );
  const freeUnits = order.slice(0, sets * get);

  const budget = budgetCapPaise(offer);
  let spent = 0;
  for (const u of freeUnits) {
    const value = Math.round((u.unitPaise * pct) / 100);
    const room = Math.min(
      value,
      Math.max(0, budget - spent),
      // Never take a line below zero, even if rounding pushed a unit's share
      // slightly above what the line has left.
      Math.max(0, priced[u.index].netPaise - claim.byLine[u.index]),
    );
    if (room <= 0) continue;
    claim.byLine[u.index] += room;
    claim.offerByLine[u.index] = offer.id;
    claim.total += room;
    spent += room;
  }

  return claim;
}

interface Claim {
  /** paise of discount, per line index. */
  byLine: number[];
  /** offer id per line index, or null. */
  offerByLine: (string | null)[];
  total: number;
}

function emptyClaim(n: number): Claim {
  return {
    byLine: new Array<number>(n).fill(0),
    offerByLine: new Array<string | null>(n).fill(null),
    total: 0,
  };
}

/** An offer's contribution, capped at whatever budget it has left. */
function budgetCapPaise(offer: Offer): number {
  const b = offer.remainingBudget;
  if (b === null || b === undefined) return Number.POSITIVE_INFINITY;
  return Math.max(0, toPaise(b));
}

/**
 * Best line-level offer for each line, evaluated independently.
 *
 * Independent per line is exact rather than approximate here: a percentage
 * reward's value on a line depends only on that line. ★ The budget cap is the
 * one thing that couples them — an offer with ₹40 left cannot fund every line —
 * so a claimed offer's running spend is tracked and later lines see the
 * remainder. Lines are visited in cart order, which makes the outcome
 * reproducible; visiting in value order would be "fairer" and would mean the
 * same cart re-ordered produces a different receipt.
 */
function claimLineOffers(
  priced: PricedLine[],
  candidates: readonly Offer[],
  mode: OnSalePriceMode,
): Claim {
  const claim = emptyClaim(priced.length);
  if (candidates.length === 0) return claim;

  // Separable rewards resolve per line and exactly; group rewards need the
  // whole set and are folded in afterwards.
  const perLine = candidates.filter((o) => !isGroupReward(o.reward.type));
  const groups = candidates.filter((o) => isGroupReward(o.reward.type));

  const spent = new Map<string, number>();

  for (const pl of priced) {
    if (!lineEligible(pl, mode)) continue;

    let bestOffer: Offer | null = null;
    let bestValue = 0;

    for (const offer of perLine) {
      if (!offerCoversLine(offer, pl)) continue;
      const raw = isFixedPriceReward(offer.reward.type)
        ? fixedPriceRewardPaise(offer.reward.unitPrice ?? 0, pl, mode)
        : percentRewardPaise(offer.reward.percent ?? 0, pl, mode);
      if (raw <= 0) continue;
      const left = budgetCapPaise(offer) - (spent.get(offer.id) ?? 0);
      const value = Math.min(raw, Math.max(0, left), pl.netPaise);
      if (value <= 0) continue;
      // Strictly greater: the first candidate wins a tie, and candidates are
      // already sorted priority-then-age, so ties resolve deterministically.
      if (value > bestValue) {
        bestValue = value;
        bestOffer = offer;
      }
    }

    if (bestOffer && bestValue > 0) {
      claim.byLine[pl.index] = bestValue;
      claim.offerByLine[pl.index] = bestOffer.id;
      claim.total += bestValue;
      spent.set(bestOffer.id, (spent.get(bestOffer.id) ?? 0) + bestValue);
    }
  }

  // ★ A GROUP OFFER COMPETES ON THE LINES IT WANTS, and only takes them if it
  // beats what those same lines already had. Otherwise "buy 2 get 1" would
  // override a deeper 50%-off on the same products purely by being evaluated
  // later — best-offer-wins has to hold across reward SHAPES, not just within
  // one shape.
  //
  // ★ EVALUATED IN CANDIDATE ORDER (priority, then age), and a line claimed by
  // an earlier group is off limits to a later one, so each line still carries
  // exactly one offer and the outcome does not depend on array order.
  for (const group of groups) {
    const taken = claim.offerByLine.map((id) =>
      id !== null && groups.some((g) => g.id === id) ? id : null,
    );
    const candidate = claimGroupOffer(priced, group, mode, taken);
    if (candidate.total <= 0) continue;

    // What the per-line winners are currently worth on exactly those lines.
    let displaced = 0;
    candidate.byLine.forEach((amount, i) => {
      if (amount > 0) displaced += claim.byLine[i];
    });
    if (candidate.total <= displaced) continue;

    candidate.byLine.forEach((amount, i) => {
      if (amount <= 0) return;
      claim.byLine[i] = amount;
      claim.offerByLine[i] = group.id;
    });
    claim.total = claim.byLine.reduce((sum, v) => sum + v, 0);
  }

  return claim;
}

/**
 * "Buy 10 or more, save 15% on each" — a quantity ladder over the offer's
 * scope.
 *
 * ★ IT IS A GROUP REWARD FOR ONE REASON: the QUANTITY is counted across every
 * line in scope, so six of one flavour and six of another earn the twelve-unit
 * rung together. Evaluated per line it would find six and six and award
 * nothing, which is the opposite of what a merchant setting a case-price
 * means. That shared counting is exactly what `isGroupReward` marks.
 *
 * ★ ONCE A RUNG IS REACHED, EVERY SCOPED UNIT GETS IT — not only the units
 * above the threshold. "Buy 10+, 15% off" universally means all ten are
 * discounted, and charging full price for the first nine would make the
 * headline false.
 *
 * ★ AND IT STILL COMPETES. It returns an ordinary `Claim`, so the group loop
 * in `claimLineOffers` takes it only where it beats what those lines already
 * had — a 20%-off-shakes offer is not displaced by a 15% case price merely
 * because one is a ladder.
 */
function claimVolumeOffer(
  priced: readonly PricedLine[],
  offer: Offer,
  mode: OnSalePriceMode,
  excluded: readonly (string | null)[],
): Claim {
  const claim = emptyClaim(priced.length);

  const units = scopedUnits(offer, priced, mode, excluded);
  const rung = activeBreak(offer, units);
  if (!rung) return claim;

  const budget = budgetCapPaise(offer);
  let spent = 0;
  for (const pl of priced) {
    if (!lineEligible(pl, mode)) continue;
    if (excluded[pl.index] !== null) continue;
    if (!offerCoversLine(offer, pl)) continue;
    const raw = percentRewardPaise(rung.percent, pl, mode);
    const value = Math.min(raw, Math.max(0, budget - spent), pl.netPaise);
    if (value <= 0) continue;
    claim.byLine[pl.index] = value;
    claim.offerByLine[pl.index] = offer.id;
    claim.total += value;
    spent += value;
  }

  return claim;
}

/**
 * An order-level offer claiming a set of lines.
 *
 * A percentage is applied per line (separable). A fixed amount is NOT
 * separable, so it is allocated proportionally across the claimed lines with
 * the shared paise allocator — the same one `refundBreakdown` uses to undo it.
 *
 * ★ `onSalePrice` AND FIXED AMOUNTS. `best` is a question about two candidate
 * prices for one item, which only makes sense when the offer itself produces a
 * price — so for `amount_off` only `skip` is meaningful (it removes on-sale
 * lines from the base) and `best` behaves as `stack`. Documented rather than
 * silently different.
 */
function claimOrderOffer(
  priced: PricedLine[],
  offer: Offer,
  mode: OnSalePriceMode,
  excluded: readonly (string | null)[],
  subtotalPaise: number,
): Claim {
  const claim = emptyClaim(priced.length);

  // ★ A LADDER RESOLVES TO A PLAIN REWARD BEFORE ANYTHING ELSE HAPPENS, so
  // every rule below — the budget cap, `onSalePrice`, the proportional
  // allocation, the per-line ceiling — applies to a tier exactly as it does to
  // a flat percentage. A second code path per reward shape is how a ladder ends
  // up ignoring a cap that a flat offer honours.
  let percentValue = offer.reward.percent ?? 0;
  let amountValue = offer.reward.amount ?? 0;
  let asPercent = isPercentReward(offer.reward.type);

  if (offer.reward.type === "tiered") {
    const rung = activeTier(offer, subtotalPaise);
    if (!rung) return claim;
    asPercent = (offer.reward.tierMode ?? "percent") === "percent";
    if (asPercent) percentValue = rung.value;
    else amountValue = rung.value;
  }
  // ★ AN ORDER-LEVEL REWARD IS NOT NARROWED BY THE OFFER'S SCOPE, and the
  // distinction is the merchant's mental model rather than a technicality.
  // The REWARD TYPE already says which they meant:
  //
  //   percent_off_items / fixed_price  →  "20% off shakes"          (line-level:
  //                                        scope decides what is discounted)
  //   percent_off / amount_off         →  "10% off your order when it
  //                                        contains a shake"        (order-level:
  //                                        scope decides what QUALIFIES, via a
  //                                        contents trigger, and the discount
  //                                        applies to the whole order)
  //
  // Filtering here would collapse the two into the same thing and quietly make
  // the second impossible to express — a merchant who set "contains a shake"
  // would find only the shake discounted.
  //
  // ⚠ This is a no-op for every offer Phase A could create: `offerCoversLine`
  // returns true when all three scope lists are empty, and there was no UI to
  // set them. So nothing already live changes behaviour.
  const eligible = priced.filter(
    (pl) => lineEligible(pl, mode) && excluded[pl.index] === null,
  );
  if (eligible.length === 0) return claim;

  const cap = budgetCapPaise(offer);

  if (asPercent) {
    let spent = 0;
    for (const pl of eligible) {
      const raw = percentRewardPaise(percentValue, pl, mode);
      const value = Math.min(raw, Math.max(0, cap - spent), pl.netPaise);
      if (value <= 0) continue;
      claim.byLine[pl.index] = value;
      claim.offerByLine[pl.index] = offer.id;
      claim.total += value;
      spent += value;
    }
    return claim;
  }

  // amount_off — a lump sum spread across the lines it may touch.
  const basePaise = eligible.reduce((s, pl) => s + pl.netPaise, 0);
  const wanted = Math.min(
    toPaise(amountValue),
    basePaise,
    cap === Number.POSITIVE_INFINITY ? basePaise : cap,
  );
  if (wanted <= 0) return claim;

  const shares = allocateProportional(
    eligible.map((pl) => pl.netPaise),
    wanted,
  );
  eligible.forEach((pl, i) => {
    if (shares[i] <= 0) return;
    claim.byLine[pl.index] = shares[i];
    claim.offerByLine[pl.index] = offer.id;
    claim.total += shares[i];
  });

  return claim;
}

function mergeClaims(a: Claim, b: Claim): Claim {
  const byLine = a.byLine.map((v, i) => v + b.byLine[i]);
  return {
    byLine,
    offerByLine: a.offerByLine.map((v, i) => v ?? b.offerByLine[i]),
    total: byLine.reduce((s, v) => s + v, 0),
  };
}

/** Sort candidates into the one order the engine evaluates them in: priority
 *  desc, then oldest first, then id. ★ Deterministic to the last field —
 *  without it two identical carts can get different receipts and the merchant
 *  cannot reproduce either. */
function candidateOrder(a: Offer, b: Offer): number {
  if (b.priority !== a.priority) return b.priority - a.priority;
  const at = Date.parse(a.createdAt) || 0;
  const bt = Date.parse(b.createdAt) || 0;
  if (at !== bt) return at - bt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// --- The engine -------------------------------------------------------------

export function applyOffers({
  lines,
  offers,
  context,
}: {
  lines: readonly OfferLine[];
  offers: readonly Offer[];
  context: OfferContext;
}): OfferResult {
  const priced = priceLines(Array.isArray(lines) ? lines : []);
  const subtotalPaise = priced.reduce((s, pl) => s + pl.netPaise, 0);
  const skipped: { offerId: string; reason: SkipReason }[] = [];
  const nearMiss: NearMissOffer[] = [];

  // ★ ONE FINALISER, because there are two return paths. The early "nothing
  // applied" exit is the COMMON one for a near miss — a cart that qualifies for
  // no offer is exactly the cart worth nudging — and it originally returned the
  // list unsorted, so the UI's "show the closest" took whichever offer the
  // merchant happened to create first.
  const finishNearMiss = (): NearMissOffer[] =>
    [...nearMiss]
      // ★ UNITS BEFORE SPEND. "Add 1 more" is a smaller ask than "spend ₹200
      // more" whatever the numbers say, and the two gaps are in different
      // units so comparing them numerically is meaningless.
      .sort((a, b) =>
        a.kind === b.kind ? a.gap - b.gap : a.kind === "units" ? -1 : 1,
      )
      .slice(0, NEAR_MISS_LIMIT);

  const empty = (): OfferResult => ({
    subtotal: toRupees(subtotalPaise),
    lines: priced.map((pl) => ({ id: pl.id, offerDiscount: 0 })),
    discount: 0,
    applied: [],
    allocations: [],
    nearMiss: finishNearMiss(),
    scenario: { chosen: null, scores: [] },
    skipped,
    cappedByCeiling: false,
  });

  if (priced.length === 0 || subtotalPaise <= 0) return empty();

  const enteredCode = context.code ? normalizeOfferCode(context.code) : null;
  const policyMode = context.onSalePrice;
  const now = context.now.getTime();

  // 1. Scope and eligibility. Every rejection is recorded with its reason.
  const eligible: Offer[] = [];
  for (const offer of Array.isArray(offers) ? offers : []) {
    const reason = disqualify(
      offer,
      context,
      enteredCode,
      now,
      subtotalPaise,
      priced,
      policyMode,
    );
    if (reason) {
      skipped.push({ offerId: offer.id, reason });
      // A near miss is an offer the shopper would GET if the cart were bigger,
      // so it is only ever an unmet trigger — never a scope or code refusal.
      if (reason === "trigger_unmet") {
        collectNearMiss(offer, subtotalPaise, priced, policyMode, nearMiss);
      }
      continue;
    }
    eligible.push(offer);
  }

  // A group offer with an incomplete set is ELIGIBLE (nothing disqualified it)
  // and simply claims nothing — so unlike a threshold, its near miss is found
  // among the candidates rather than among the refusals.
  for (const offer of eligible) {
    collectUnitNearMiss(offer, priced, policyMode, nearMiss);
    collectLadderUpgrade(offer, subtotalPaise, priced, policyMode, nearMiss);
  }

  eligible.sort(candidateOrder);
  const overflow = eligible.slice(MAX_EVALUATED_OFFERS);
  for (const o of overflow) {
    skipped.push({ offerId: o.id, reason: "beyond_candidate_cap" });
  }
  const candidates = eligible.slice(0, MAX_EVALUATED_OFFERS);

  const lineCandidates = candidates.filter(
    (o) => rewardLevel(o.reward.type) === "line",
  );
  const orderCandidates = candidates.filter(
    (o) => rewardLevel(o.reward.type) === "order",
  );

  // 2. The per-order depth ceiling. Applied INSIDE scoring, so scenarios are
  //    compared on what they can actually deliver rather than on a headline
  //    figure one of them would never be allowed to charge.
  const ceilingPct = Number.isFinite(context.maxTotalDiscountPercent)
    ? Math.min(Math.max(0, context.maxTotalDiscountPercent), 100)
    : 100;
  const ceilingPaise = Math.floor((subtotalPaise * ceilingPct) / 100);

  // 3. Scenarios.
  const lineOnly = claimLineOffers(priced, lineCandidates, context.onSalePrice);
  const scored: {
    id: ScenarioId;
    offerId: string | null;
    claim: Claim;
    discount: number;
  }[] = [
    {
      id: "line_only",
      offerId: null,
      claim: lineOnly,
      discount: Math.min(lineOnly.total, ceilingPaise),
    },
  ];

  for (const orderOffer of orderCandidates) {
    const withLines = mergeClaims(
      lineOnly,
      claimOrderOffer(
        priced,
        orderOffer,
        context.onSalePrice,
        lineOnly.offerByLine,
        subtotalPaise,
      ),
    );
    scored.push({
      id: "line_and_order",
      offerId: orderOffer.id,
      claim: withLines,
      discount: Math.min(withLines.total, ceilingPaise),
    });

    const alone = claimOrderOffer(
      priced,
      orderOffer,
      context.onSalePrice,
      new Array<string | null>(priced.length).fill(null),
      subtotalPaise,
    );
    scored.push({
      id: "order_only",
      offerId: orderOffer.id,
      claim: alone,
      discount: Math.min(alone.total, ceilingPaise),
    });
  }

  // 4. Best wins. Ties resolve by scenario declaration order, which is stable
  //    because `scored` is built in a fixed order from sorted candidates.
  let best = scored[0];
  for (const s of scored) if (s.discount > best.discount) best = s;

  if (best.discount <= 0) {
    for (const o of candidates) {
      skipped.push({ offerId: o.id, reason: "no_eligible_lines" });
    }
    return empty();
  }

  // 5. The ceiling scales the winning claim down proportionally, so no line
  //    ends up discounted below zero and the parts still sum to the whole.
  let byLine = best.claim.byLine;
  const cappedByCeiling = best.claim.total > ceilingPaise;
  if (cappedByCeiling) {
    byLine = allocateProportional(best.claim.byLine, ceilingPaise);
  }

  const byId = new Map(candidates.map((o) => [o.id, o]));
  const allocations: OfferAllocation[] = [];
  const perOffer = new Map<string, number>();

  priced.forEach((pl) => {
    const amountPaise = byLine[pl.index];
    if (amountPaise <= 0) return;
    const offerId = best.claim.offerByLine[pl.index];
    if (!offerId) return;
    const offer = byId.get(offerId);
    if (!offer) return;
    allocations.push({
      lineId: pl.id,
      offerId,
      offerName: offer.name,
      amount: toRupees(amountPaise),
    });
    perOffer.set(offerId, (perOffer.get(offerId) ?? 0) + amountPaise);
  });

  const applied: AppliedOffer[] = [...perOffer.entries()].map(([id, paise]) => {
    const offer = byId.get(id)!;
    return {
      offerId: id,
      offerName: offer.name,
      code: offer.code,
      rewardType: offer.reward.type,
      level: rewardLevel(offer.reward.type),
      amount: toRupees(paise),
    };
  });

  for (const o of candidates) {
    if (!perOffer.has(o.id))
      skipped.push({ offerId: o.id, reason: "outscored" });
  }

  const totalPaise = byLine.reduce((s, v) => s + v, 0);

  return {
    subtotal: toRupees(subtotalPaise),
    lines: priced.map((pl) => ({
      id: pl.id,
      offerDiscount: toRupees(byLine[pl.index]),
    })),
    discount: toRupees(totalPaise),
    applied,
    allocations,
    nearMiss: finishNearMiss(),
    scenario: {
      chosen: best.id,
      scores: scored.map((s) => ({
        id: s.id,
        offerId: s.offerId,
        discount: toRupees(s.discount),
      })),
    },
    skipped,
    cappedByCeiling,
  };
}

/** Why this offer cannot apply to this cart, or null if it can. */
function disqualify(
  offer: Offer,
  ctx: OfferContext,
  enteredCode: string | null,
  now: number,
  subtotalPaise: number,
  priced: readonly PricedLine[],
  mode: OnSalePriceMode,
): SkipReason | null {
  if (offer.status !== "active") return "disabled";
  if (offer.exhausted) return "exhausted";

  const budget = offer.remainingBudget;
  if (budget !== null && budget !== undefined && toPaise(budget) <= 0) {
    return "no_budget";
  }

  if (offer.validFrom) {
    const from = Date.parse(offer.validFrom);
    if (Number.isFinite(from) && now < from) return "not_started";
  }
  if (offer.validUntil) {
    const until = Date.parse(offer.validUntil);
    if (Number.isFinite(until) && now > until) return "expired";
  }

  if (offer.channels.length > 0 && !offer.channels.includes(ctx.channel)) {
    return "wrong_channel";
  }

  // ★ Location scope is checked against the TRUSTED context location, and an
  // offer scoped to locations refuses when we do not know where we are —
  // fail closed, the `lib/locations/scope.ts` posture.
  if (offer.locationIds.length > 0) {
    if (!ctx.locationId || !offer.locationIds.includes(ctx.locationId)) {
      return "wrong_location";
    }
  }

  if (offer.groupIds.length > 0) {
    const groups = ctx.groupIds ?? [];
    if (!offer.groupIds.some((g) => groups.includes(g))) return "not_in_group";
  }

  // Delivery. An `automatic` offer needs the store's auto-apply switch on;
  // `code`/`link` need the code, whatever the switch says — a shopper holding a
  // code the merchant sent them must not be refused by an unrelated setting.
  if (offer.delivery === "automatic") {
    if (!ctx.autoApply) return "auto_apply_off";
  } else {
    if (!offer.code) return "code_required";
    if (enteredCode !== normalizeOfferCode(offer.code)) return "code_required";
  }

  // ★ A CONTENTS TRIGGER QUALIFIES OFF THE OFFER'S OWN SCOPE, so the merchant
  // names the products once and that single list decides both what qualifies
  // and what gets discounted. Keeping a second list on the trigger would let
  // the two disagree — "10% off shakes, if the cart contains shoes" is a rule
  // nobody wants and everybody would eventually create by accident.
  //
  // ★ AND IT RESPECTS `onSalePrice`. Under `skip`, a cart holding only on-sale
  // matching lines does NOT qualify: every line the offer could act on has
  // been declined, so qualifying would apply the reward to nothing while the
  // storefront had already promised it.
  if (isContentsTrigger(offer.trigger.type)) {
    const matches = priced.some(
      (pl) => lineEligible(pl, mode) && offerCoversLine(offer, pl),
    );
    if (!matches) return "trigger_unmet";
  }

  // ★ A LADDER WHOSE LOWEST RUNG IS OUT OF REACH IS REFUSED HERE, not left to
  // claim nothing. Two things depend on it: `trigger_unmet` is what routes the
  // offer into the near-miss collector (so the shopper is told how close they
  // are), and the operator-facing skip list then names an actionable reason
  // rather than the catch-all `no_eligible_lines`.
  if (offer.reward.type === "tiered") {
    if (!activeTier(offer, subtotalPaise)) return "trigger_unmet";
  }
  if (offer.reward.type === "volume_break") {
    if (!activeBreak(offer, scopedUnits(offer, priced, mode))) {
      return "trigger_unmet";
    }
  }

  if (offer.trigger.type === "min_subtotal") {
    // ★ MEASURED AGAINST THE UNDISCOUNTED MERCHANDISE SUBTOTAL, always. Two
    // reasons, and the second is the load-bearing one: it is what the shopper
    // expects (their cart says ₹1,050, so they qualify), and testing it after
    // discounts would be CIRCULAR — applying an offer could disqualify the very
    // offer that made it applicable, and the answer would then depend on
    // evaluation order rather than on the cart.
    const threshold = toPaise(offer.trigger.minSubtotal ?? 0);
    if (subtotalPaise < threshold) return "trigger_unmet";
  }

  return null;
}

/** Record a near miss, if this offer is one the viewer would actually get. */
function collectNearMiss(
  offer: Offer,
  subtotalPaise: number,
  priced: readonly PricedLine[],
  mode: OnSalePriceMode,
  out: NearMissOffer[],
): void {
  if (!nudgeable(offer)) return;

  // A ladder's first rung is its threshold, so the gap comes from the rung
  // rather than from the trigger.
  if (offer.reward.type === "tiered") {
    const first = sortedTiers(offer.reward.tiers)[0];
    if (!first) return;
    const asPercent = (offer.reward.tierMode ?? "percent") === "percent";
    pushSpendGap(offer, toPaise(first.minSubtotal), subtotalPaise, out, {
      percent: asPercent ? first.value : undefined,
      amount: asPercent ? undefined : first.value,
    });
    return;
  }

  if (offer.reward.type === "volume_break") {
    const first = sortedBreaks(offer.reward.breaks)[0];
    if (!first) return;
    const units = scopedUnits(offer, priced, mode);
    // ★ ONLY WHEN THE CART ALREADY HOLDS ONE, the `collectUnitNearMiss`
    // restraint: a case-price nudge on a cart containing none of the products
    // is an advert that would fire on every basket in the store.
    if (units <= 0) return;
    out.push({
      offerId: offer.id,
      offerName: offer.name,
      kind: "units",
      gap: first.minQuantity - units,
      rewardType: offer.reward.type,
      percent: first.percent,
    });
    return;
  }

  if (offer.trigger.type !== "min_subtotal") return;
  pushSpendGap(
    offer,
    toPaise(offer.trigger.minSubtotal ?? 0),
    subtotalPaise,
    out,
    {
      percent: offer.reward.percent,
      amount: offer.reward.amount,
    },
  );
}

/**
 * ★ NEVER NUDGE A CODE OR GROUP-RESTRICTED OFFER. "You're ₹200 from 20% off
 * with WHOLESALE20" leaks a targeted code to every visitor, and the group
 * restriction was the whole point of setting it (plan §14b). Shared by every
 * collector, because the leak has nothing to do with which shape the gap takes.
 */
function nudgeable(offer: Offer): boolean {
  return offer.delivery !== "code" && offer.groupIds.length === 0;
}

/** A rupee gap, subject to the shared proximity floor. */
function pushSpendGap(
  offer: Offer,
  thresholdPaise: number,
  subtotalPaise: number,
  out: NearMissOffer[],
  reward: { percent?: number; amount?: number },
  current?: { percent?: number; amount?: number },
): void {
  const gap = thresholdPaise - subtotalPaise;
  if (gap <= 0) return;
  // Close enough to be worth saying: within the floor, or within the size of
  // the cart itself (so a big basket is nudged toward a big threshold).
  if (gap > Math.max(toPaise(NEAR_MISS_FLOOR), subtotalPaise)) return;

  out.push({
    offerId: offer.id,
    offerName: offer.name,
    kind: "spend",
    gap: toRupees(gap),
    rewardType: offer.reward.type,
    percent: reward.percent,
    amount: reward.amount,
    currentPercent: current?.percent,
    currentAmount: current?.amount,
  });
}

/**
 * "Spend ₹200 more for 15% off instead of 10%" — the next rung up a ladder the
 * cart is ALREADY earning from.
 *
 * ★ THIS IS THE COMMERCIALLY USEFUL HALF OF A LADDER, and it needs its own
 * collector because it fires on an ELIGIBLE offer rather than a refused one:
 * nothing disqualified it, the cart simply has not reached the rung above.
 * `collectNearMiss` only ever sees refusals, so an upgrade would be invisible
 * to it — which would leave a merchant paying for a three-rung ladder that
 * only ever advertises its bottom step.
 *
 * ★ IT REPORTS ONE RUNG UP, NEVER THE TOP. Nudging a ₹1,100 cart toward a
 * ₹5,000 rung is not a nudge, and the proximity floor would usually reject it
 * anyway; the next step is the one the shopper might actually take.
 */
function collectLadderUpgrade(
  offer: Offer,
  subtotalPaise: number,
  priced: readonly PricedLine[],
  mode: OnSalePriceMode,
  out: NearMissOffer[],
): void {
  if (!nudgeable(offer)) return;

  if (offer.reward.type === "tiered") {
    const tiers = sortedTiers(offer.reward.tiers);
    const at = activeTier(offer, subtotalPaise);
    if (!at) return; // Not earning yet — that is `collectNearMiss`'s case.
    const next = tiers.find((t) => toPaise(t.minSubtotal) > subtotalPaise);
    if (!next) return; // Already on the top rung.
    const asPercent = (offer.reward.tierMode ?? "percent") === "percent";
    pushSpendGap(
      offer,
      toPaise(next.minSubtotal),
      subtotalPaise,
      out,
      {
        percent: asPercent ? next.value : undefined,
        amount: asPercent ? undefined : next.value,
      },
      {
        percent: asPercent ? at.value : undefined,
        amount: asPercent ? undefined : at.value,
      },
    );
    return;
  }

  if (offer.reward.type === "volume_break") {
    const units = scopedUnits(offer, priced, mode);
    const at = activeBreak(offer, units);
    if (!at) return;
    const next = sortedBreaks(offer.reward.breaks).find(
      (b) => b.minQuantity > units,
    );
    if (!next) return;
    out.push({
      offerId: offer.id,
      offerName: offer.name,
      kind: "units",
      gap: next.minQuantity - units,
      rewardType: offer.reward.type,
      percent: next.percent,
      currentPercent: at.percent,
    });
  }
}

/**
 * "Add 1 more shake and one is free" — a buy-X-get-Y set the cart has started
 * but not completed.
 *
 * ★ ONLY WHEN THE CART ALREADY HOLDS A QUALIFYING ITEM. Suggesting a set to
 * somebody with none of the products is an advert, not a nudge, and it would
 * fire on every cart in the store. This is the same restraint the spend nudge
 * shows by capping its gap.
 *
 * ★ AND ONLY FOR AN OFFER THE VIEWER WOULD ACTUALLY GET — the code and
 * customer-group rules from `collectNearMiss` apply identically, because the
 * leak they prevent has nothing to do with which shape the gap takes.
 */
function collectUnitNearMiss(
  offer: Offer,
  priced: readonly PricedLine[],
  mode: OnSalePriceMode,
  out: NearMissOffer[],
): void {
  if (!isGroupReward(offer.reward.type)) return;
  if (offer.delivery === "code") return;
  if (offer.groupIds.length > 0) return;

  const buy = Math.trunc(offer.reward.buyQuantity ?? 0);
  const get = Math.trunc(offer.reward.getQuantity ?? 0);
  if (buy < 1 || get < 1) return;

  let have = 0;
  for (const pl of priced) {
    if (!lineEligible(pl, mode)) continue;
    if (!offerCoversLine(offer, pl)) continue;
    have += Math.max(0, Math.trunc(Number(pl.line.quantity) || 0));
  }
  if (have <= 0) return;

  const setSize = buy + get;
  const short = setSize - (have % setSize);
  // A complete set is not a near miss, and neither is a cart with none of the
  // products.
  if (short === setSize || short <= 0) return;

  out.push({
    offerId: offer.id,
    offerName: offer.name,
    kind: "units",
    gap: short,
    rewardType: offer.reward.type,
    getQuantity: get,
  });
}
