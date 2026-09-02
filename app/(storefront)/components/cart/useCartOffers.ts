"use client";

import { useEffect, useMemo, useState } from "react";
import { applyOffers, type OfferResult } from "@/lib/offers/apply";
import type { Offer, OnSalePriceMode } from "@/lib/offers/types";
import { getStorefrontOffers } from "@/app/actions/checkout-actions";
import { lineKey, type CartItem } from "./CartProvider";

// Live offer pricing for the cart — the same split `useCartTax` uses. The
// expensive part (resolving which offers are live for this store and viewer) is
// fetched ONCE and the pure engine recomputes LOCALLY on every quantity change,
// so editing a cart costs zero round trips.
//
// ★ DISPLAY ONLY. `placeOrder` re-resolves and re-prices authoritatively; this
// exists so the cart shows the same number the shopper will be charged, and so
// the near-miss nudge can be honest about what adding an item would earn.
//
// ★ THE ENGINE DECIDES, NOT THIS HOOK. Under best-offer-wins whether an offer
// applies depends on what it competes with, so a cart that computed
// "threshold − subtotal" itself would promise offers the server then declines.

interface Bundle {
  offers: Offer[];
  showNearMiss: boolean;
  policy: {
    onSalePrice: OnSalePriceMode;
    maxTotalDiscountPercent: number;
    autoApply: boolean;
  };
}

export function useCartOffers(
  items: CartItem[],
  hydrated: boolean,
  /**
   * Authoritative per-line data from `getCartTaxRates`, which the cart already
   * fetches once per product-set change.
   *
   * ★ THE CATEGORY COMES FROM HERE, NOT FROM THE CART ITEM. `CartItem` holds a
   * category NAME for display and no id, and adding one would be correct only
   * for lines added after the change — every persisted cart would mis-price a
   * category-scoped offer until the shopper re-added the item. Passing the
   * server's answer means a stale cart is priced correctly on its first render.
   */
  rates?:
    | {
        productId: string;
        variantId: string | null;
        categoryId: string | null;
      }[]
    | null,
): OfferResult | null {
  const [bundle, setBundle] = useState<Bundle | null>(null);

  useEffect(() => {
    if (!hydrated) return;
    let live = true;
    getStorefrontOffers()
      .then((b) => {
        if (live) setBundle(b);
      })
      .catch(() => {
        // A cart that cannot show a badge still sells.
      });
    return () => {
      live = false;
    };
    // Fetched once per mount: which offers are live does not depend on the
    // cart, and re-fetching per edit is the round trip this design avoids.
  }, [hydrated]);

  const categoryByLine = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const r of rates ?? []) {
      map.set(lineKey(r.productId, r.variantId), r.categoryId);
    }
    return map;
  }, [rates]);

  return useMemo(() => {
    if (!bundle || items.length === 0) return null;
    const result = applyOffers({
      lines: items.map((i) => ({
        id: lineKey(i.productId, i.variantId),
        productId: i.productId,
        variantId: i.variantId ?? null,
        categoryId:
          categoryByLine.get(lineKey(i.productId, i.variantId ?? null)) ?? null,
        quantity: i.quantity,
        unitPrice: i.price,
      })),
      offers: bundle.offers,
      context: {
        channel: "storefront",
        // ★ Null, exactly as `placeOrder` passes: an online order's fulfilment
        // location is an internal routing outcome, so a location-scoped offer
        // does not apply online. Anything else here would quote a discount the
        // server refuses.
        locationId: null,
        customerId: null,
        groupIds: [],
        now: new Date(),
        code: null,
        ...bundle.policy,
      },
    });
    // The merchant's switch, resolved server-side and honoured here. The
    // engine always computes near misses (the pricing path needs the same
    // loop), so this is where the setting actually takes effect.
    return bundle.showNearMiss ? result : { ...result, nearMiss: [] };
  }, [bundle, items, categoryByLine]);
}
