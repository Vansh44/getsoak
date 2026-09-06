// ---------------------------------------------------------------------------
// "20% off" on a product card — pure. `docs/offers-plan.md` §4 (Phase B).
//
// ★ THE BADGE IS THE ENGINE'S OWN ANSWER, not a second calculation that
// happens to look like it. It prices a ONE-LINE cart through `applyOffers` and
// reports what came back, so a badge can never promise a discount the cart
// then declines. Re-deriving "the offer says 20%, so show 20%" would be wrong
// in three ordinary cases the engine already handles:
//
//   · `offers.onSalePrice: "skip"` — the product is on a special price, so the
//     offer declines the line and the saving is zero.
//   · `"best"` — a 10% offer against a deeper special price adds nothing.
//   · `fixed_price` — "any tee ₹499" is worth a different amount on every
//     product it covers, and nothing on one already cheaper.
//
// ★ LINE-LEVEL REWARDS ONLY. An order-level offer ("10% off your order") is not
// a fact about this product: whether it applies depends on the whole basket, so
// a per-product badge for one would be a promise the card cannot keep. Those
// belong in the cart's near-miss nudge, which is scoped to say exactly that.
// ---------------------------------------------------------------------------

import { applyOffers, type OfferContext } from "./apply";
import { rewardLevel, type Offer } from "./types";
import { describeReward, rewardDescriptor } from "./describe";

export interface BadgeProduct {
  productId: string;
  variantId?: string | null;
  categoryId?: string | null;
  /** The price a shopper would be charged today, before offers. */
  unitPrice: number;
  /** The non-sale price, when `unitPrice` is a special price. */
  regularUnitPrice?: number | null;
}

export interface OfferBadge {
  /** Ready to render: "20% off" or "Save ₹300". */
  label: string;
  /** What one unit actually saves, so a caller can show a struck-through price. */
  saving: number;
  offerId: string;
  offerName: string;
}

/**
 * The badge for one product, or null when no line-level offer improves it.
 *
 * `policy` and `offers` come from `loadOffersForStorefront`, so the card sees
 * exactly the offers the cart will.
 */
export function offerBadgeFor(
  product: BadgeProduct,
  offers: readonly Offer[],
  policy: Pick<
    OfferContext,
    "onSalePrice" | "maxTotalDiscountPercent" | "autoApply"
  >,
  now: Date = new Date(),
): OfferBadge | null {
  // ★ A QUANTITY LADDER CORRECTLY BADGES NOTHING, and that is not a gap to
  // close later. The cart priced below holds ONE unit, so a `volume_break`
  // whose first rung is 10 reaches no rung and contributes nothing — which is
  // the honest answer, because "15% off when you buy 10" is not a claim about
  // buying one. Advertising the rung price on a product card would put a price
  // on screen that the cart then declines, which is the exact failure this
  // whole function exists to prevent. (`buy_x_get_y` behaves identically for
  // the same reason.) A ladder starting at 1 unit is a plain per-item discount
  // and badges normally, with no special case.
  const lineOffers = offers.filter(
    (o) => rewardLevel(o.reward.type) === "line",
  );
  if (lineOffers.length === 0) return null;
  if (!Number.isFinite(product.unitPrice) || product.unitPrice <= 0)
    return null;

  const result = applyOffers({
    lines: [
      {
        id: "b",
        productId: product.productId,
        variantId: product.variantId ?? null,
        categoryId: product.categoryId ?? null,
        quantity: 1,
        unitPrice: product.unitPrice,
        regularUnitPrice: product.regularUnitPrice ?? null,
      },
    ],
    offers: lineOffers,
    context: {
      ...policy,
      // ★ The per-order ceiling is deliberately NOT applied to a badge. It
      // caps a whole ORDER, and a one-line probe is not an order — letting it
      // bite here would understate a genuine per-item saving on a cheap item.
      maxTotalDiscountPercent: 100,
      channel: "storefront",
      locationId: null,
      customerId: null,
      groupIds: [],
      now,
      code: null,
    },
  });

  const applied = result.applied[0];
  if (!applied || result.discount <= 0) return null;

  // A percentage reads better as a percentage; anything else as money saved,
  // because "₹499 each" on a card next to the price is easy to misread as the
  // price itself.
  const pct = Math.round((result.discount / product.unitPrice) * 100);
  const label =
    applied.rewardType === "percent_off_items" && pct > 0
      ? `${pct}% off`
      : `Save ₹${Math.round(result.discount).toLocaleString("en-IN")}`;

  return {
    label,
    saving: result.discount,
    offerId: applied.offerId,
    offerName: applied.offerName,
  };
}

/**
 * The offer's TERMS for one product — "Buy 1 get 1 free", "Any 3 for ₹999".
 *
 * ★★ A DIFFERENT CLAIM FROM `offerBadgeFor`, WHICH IS WHY IT IS A SECOND
 * FUNCTION RATHER THAN A LOOSENED FIRST ONE. That one answers "what does ONE
 * of these cost right now?" and must never overstate it, so it prices a
 * one-unit cart — and a buy-1-get-1, a bundle and a quantity break all
 * correctly score ZERO there, because none of them is a claim about buying
 * one. Right, and the reason a merchant's B1G1 showed nothing at all on the
 * shop: the only marker in the product grid was a PRICE badge, and this whole
 * family of offers has no price to put on it.
 *
 * This answers the other question — "is there an offer on this product, and
 * what is it?" — which is honest at any quantity because it quotes the terms
 * instead of a saving.
 *
 * ★ IT STILL PROVES THE OFFER WOULD APPLY, and that is what stops it becoming
 * the "the offer says 20%" badge this module exists to prevent. The probe
 * prices the SMALLEST CART THAT COULD EARN the reward, so every gate the cart
 * will apply — channel, dates, auto-apply, conditions, sale-price mode,
 * scope — has already been passed by anything that returns a tag. An offer
 * that would be refused shows nothing.
 *
 * ⚠ ONE MARKER PER CARD, and the caller prefers `offerBadgeFor`: where a real
 * per-unit saving exists, "20% off" beats "there is an offer on this".
 */
export function offerTagFor(
  product: BadgeProduct,
  offers: readonly Offer[],
  policy: Pick<
    OfferContext,
    "onSalePrice" | "maxTotalDiscountPercent" | "autoApply"
  >,
  now: Date = new Date(),
): { label: string; offerId: string; offerName: string } | null {
  if (!Number.isFinite(product.unitPrice) || product.unitPrice <= 0) {
    return null;
  }

  const lineOffers = offers.filter(
    (o) => rewardLevel(o.reward.type) === "line",
  );

  for (const offer of lineOffers) {
    // The fewest units at which this reward pays anything at all.
    const need = qualifyingQuantity(offer);
    if (need < 1) continue;

    const probe = applyOffers({
      lines: [
        {
          id: "t",
          productId: product.productId,
          variantId: product.variantId ?? null,
          categoryId: product.categoryId ?? null,
          quantity: need,
          unitPrice: product.unitPrice,
          regularUnitPrice: product.regularUnitPrice ?? null,
        },
      ],
      // ★ ONE OFFER AT A TIME. Together they compete under best-offer-wins and
      // only the winner would ever be tagged — but the caller wants to know
      // whether THIS product carries an offer at all, and a shopper looking at
      // one product is not choosing between them.
      offers: [offer],
      context: {
        ...policy,
        // Not an order, so the per-ORDER ceiling must not bite (see above).
        maxTotalDiscountPercent: 100,
        channel: "storefront",
        locationId: null,
        customerId: null,
        groupIds: [],
        now,
        code: null,
      },
    });
    if (probe.discount <= 0) continue;

    return {
      label: describeReward(rewardDescriptor(offer.reward)),
      offerId: offer.id,
      offerName: offer.name,
    };
  }

  return null;
}

/**
 * How many of one product it takes before a reward is worth anything.
 *
 * ★ WITHOUT THIS THE PROBE IS THE ONE-UNIT CART AGAIN and every group reward
 * scores zero — which is exactly the gap this function exists to close.
 */
function qualifyingQuantity(offer: Offer): number {
  const r = offer.reward;
  switch (r.type) {
    case "buy_x_get_y":
      return (
        Math.max(1, Math.trunc(r.buyQuantity ?? 0)) +
        Math.max(1, Math.trunc(r.getQuantity ?? 0))
      );
    case "bundle_price":
      return Math.max(1, Math.trunc(r.bundleQuantity ?? 0));
    case "volume_break": {
      const rungs = (r.breaks ?? []).map((b) => Math.trunc(b.minQuantity));
      const lowest = rungs.filter((n) => n > 0).sort((a, b) => a - b)[0];
      return lowest ?? 1;
    }
    default:
      return 1;
  }
}
