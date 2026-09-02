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
