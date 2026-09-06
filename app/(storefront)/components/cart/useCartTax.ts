"use client";

import { useEffect, useMemo, useState } from "react";
import { computeTax } from "@/lib/billing/tax";
import {
  getCartTaxRates,
  type CartTaxRates,
  type CartTaxResult,
} from "@/app/actions/checkout-actions";
import { lineKey, type CartItem } from "./CartProvider";

// Live cart tax for the order summary, shared by the checkout page and the
// grocery cart. The expensive part — resolving each product's authoritative
// price + tax rate from the DB — depends only on WHICH products are in the cart,
// so we fetch it once per product-SET change and recompute the actual tax
// LOCALLY (pure `computeTax`) whenever quantity or the coupon discount changes.
// Quantity/discount edits therefore cost ZERO round-trips; only adding or
// removing a product refetches. placeOrder recomputes authoritatively at order
// time — this is display only.
//
// Three-state return, matching the old getCartTax contract the callers rely on:
//   • null                     → loading / not hydrated / empty cart / fetch failed
//                                 (caller shows "calculated at checkout")
//   • { enabled: false, … }    → the store has tax turned off
//   • { enabled: true, tax, … } → tax to display
/**
 * Just the fetch: the store's tax config and each line's authoritative price,
 * rate, category and pre-sale price.
 *
 * ★★ SPLIT OUT BECAUSE THE CHECKOUT NEEDS THE MIDDLE OF THIS HOOK. Offers are
 * priced from `rates.lines` (categories and sale prices) and the tax is then
 * computed from what the offers took off — so the caller has to get between
 * the fetch and the arithmetic. As one hook that is a cycle: tax needs the
 * discount, the discount needs the rates, and the rates arrive with the tax.
 *
 * `useCartTax` below is unchanged for every caller that does not need to.
 */
export function useCartTaxRates(
  items: CartItem[],
  hydrated: boolean,
): CartTaxRates | null {
  const [rates, setRates] = useState<CartTaxRates | null>(null);

  // Stable key over the SET of (product, variant) pairs — order-independent and
  // ignores quantity, so it only changes when a product is added or removed.
  const setKey = useMemo(
    () =>
      items
        .map((i) => lineKey(i.productId, i.variantId))
        .sort()
        .join("|"),
    [items],
  );

  useEffect(() => {
    if (!hydrated || items.length === 0) {
      setRates(null);
      return;
    }
    let active = true;
    const lines = items.map((i) => ({
      productId: i.productId,
      variantId: i.variantId,
    }));
    // Debounce a burst of add/remove; the fetch is keyed on the product set, so
    // quantity changes never re-enter this effect (setKey is unchanged).
    const timer = setTimeout(() => {
      getCartTaxRates(lines)
        .then((r) => {
          if (active) setRates(r);
        })
        .catch(() => {
          // Refetch failed — clear so we never show a stale tax/total from a
          // previous cart state; the caller falls back to its "at checkout" note.
          if (active) setRates(null);
        });
    }, 300);
    return () => {
      active = false;
      clearTimeout(timer);
    };
    // Intentionally keyed on the product SET, not `items` identity: quantity and
    // discount changes must NOT trigger a refetch — they recompute locally below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, setKey]);

  return rates;
}

/**
 * The tax those rates imply, for a given discount. Pure.
 *
 * @param lineDiscounts what an OFFER took off each line, keyed by `lineKey`.
 *   ★ PER LINE, NOT SPREAD. `computeTax` allocates an order-level discount
 *   proportionally, and an offer's reward is not proportional — ₹200 off a
 *   ₹1,000 18% shirt beside a ₹1,000 5% book is ₹194 of tax, not the ₹207 the
 *   spread produces. `placeOrder` passes the same per-line figures, so the
 *   summary and the invoice agree.
 * @param discount whatever is left over at ORDER level: a legacy coupon, or
 *   the part of an offer the engine did not allocate to a line.
 */
export function cartTaxFrom(
  rates: CartTaxRates | null,
  items: CartItem[],
  discount: number,
  lineDiscounts?: ReadonlyMap<string, number> | null,
): CartTaxResult | null {
  if (rates === null) return null;
  if (!rates.enabled) {
    return { enabled: false, inclusive: false, tax: 0, byRate: [] };
  }
  const byKey = new Map(
    rates.lines.map((l) => [lineKey(l.productId, l.variantId), l]),
  );
  // A just-added line may not be in `rates` yet (its refetch is in flight) —
  // it contributes 0 until the rates arrive, then this recomputes.
  const taxLines = items.map((i) => {
    const key = lineKey(i.productId, i.variantId);
    const r = byKey.get(key);
    return {
      amount: (r?.price ?? 0) * i.quantity,
      rate: r?.rate ?? 0,
      label: r?.label,
      discount: Math.max(0, lineDiscounts?.get(key) ?? 0),
    };
  });
  const result = computeTax({
    lines: taxLines,
    discount: Math.max(0, discount),
    pricesIncludeTax: rates.inclusive,
    enabled: true,
  });
  return {
    enabled: true,
    inclusive: rates.inclusive,
    // Passed through for `useCartOffers`, which needs each line's category
    // and would otherwise repeat this fetch (see CartTaxResult.lines).
    lines: rates.lines,
    tax: result.totalTax,
    byRate: result.byRate.map((b) => ({
      rate: b.rate,
      label: b.label,
      tax: b.tax,
    })),
  };
}

/**
 * The original hook, unchanged for callers that price only a coupon (the
 * grocery cart). Fetch + compute in one.
 */
export function useCartTax(
  items: CartItem[],
  hydrated: boolean,
  discount: number,
): CartTaxResult | null {
  const rates = useCartTaxRates(items, hydrated);
  return useMemo(
    () => cartTaxFrom(rates, items, discount),
    [rates, items, discount],
  );
}
