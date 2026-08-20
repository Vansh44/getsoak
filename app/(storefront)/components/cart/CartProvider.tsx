/* eslint-disable react-hooks/set-state-in-effect */
"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import {
  validateCoupon,
  type AppliedCoupon,
} from "@/app/actions/coupon-actions";
import { cartLineMax } from "@/lib/inventory/status";
import { useStorefrontTracking } from "@/app/(storefront)/components/merchant-tracking";

export interface CartItem {
  productId: string;
  slug: string;
  name: string;
  variantId: string | null;
  variantName: string | null;
  price: number; // effective selling price (per unit)
  basePrice: number; // original price, for struck-through display
  image: string | null;
  quantity: number;
  /** Resolved category name — shown as the line subtitle in the grocery cart.
   *  Optional so older persisted carts (and non-grocery callers) still fit. */
  category?: string | null;
  // Inventory snapshot captured when the line was added, so the cart can cap
  // quantity WITHOUT a round-trip (the server reserve_stock is the final word).
  // All optional so older persisted carts still parse — absent ⇒ treated as
  // untracked (unlimited) by cartLineMax.
  trackInventory?: boolean;
  stock?: number;
  allowBackorder?: boolean;
}

type AddItemInput = Omit<CartItem, "quantity">;

// A fresh, server-read stock snapshot for one cart line — the input to
// reconcileStock. Structurally matches getCartStock's CartStockInfo so the
// checkout page can pass its result straight through (no runtime coupling to
// the server-action module).
export interface CartStockUpdate {
  productId: string;
  variantId: string | null;
  // False when the product/variant no longer exists in this store → drop it.
  exists: boolean;
  trackInventory: boolean;
  stock: number;
  allowBackorder: boolean;
}

// What reconcileStock changed, so the caller can tell the shopper.
export interface StockReconcileResult {
  removed: string[]; // names of lines dropped (vanished or sold out)
  reduced: Array<{ name: string; from: number; to: number }>;
}

type CartContextType = {
  items: CartItem[];
  hydrated: boolean;
  addItem: (item: AddItemInput, quantity?: number) => void;
  removeItem: (key: string) => void;
  setQuantity: (key: string, quantity: number) => void;
  // Reconcile the cart against fresh server stock: refresh each line's
  // snapshot, clamp over-stock quantities, drop vanished/sold-out lines.
  // Returns a summary of the changes (empty when nothing changed).
  reconcileStock: (updates: CartStockUpdate[]) => StockReconcileResult;
  clear: () => void;
  totalItems: number;
  subtotal: number;
  isCartOpen: boolean;
  openCart: () => void;
  closeCart: () => void;
  // Coupons
  appliedCoupon: AppliedCoupon | null;
  couponDiscount: number; // rupees off, clamped to subtotal
  couponValid: boolean; // false when the cart no longer meets the minimum
  total: number; // subtotal - couponDiscount
  applyCoupon: (code: string) => Promise<{ error?: string }>;
  removeCoupon: () => void;
};

const CartContext = createContext<CartContextType | null>(null);

const STORAGE_KEY = "wholesip-cart-v1";
const COUPON_KEY = "wholesip-coupon-v1";

// A cart line is uniquely identified by product + variant.
export function lineKey(productId: string, variantId: string | null): string {
  return `${productId}:${variantId ?? ""}`;
}

export function useCart() {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error("useCart must be used within CartProvider");
  return ctx;
}

export default function CartProvider({ children }: { children: ReactNode }) {
  const trackStorefrontEvent = useStorefrontTracking();
  const [items, setItems] = useState<CartItem[]>([]);
  const [appliedCoupon, setAppliedCoupon] = useState<AppliedCoupon | null>(
    null,
  );
  const [hydrated, setHydrated] = useState(false);
  const [isCartOpen, setIsCartOpen] = useState(false);

  // Always-current mirror of `items`, so reconcileStock can diff against the
  // latest cart from an imperative callback without re-creating the callback
  // (and without running side effects inside a setItems updater — StrictMode
  // would double-invoke it).
  const itemsRef = useRef<CartItem[]>([]);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  const openCart = useCallback(() => setIsCartOpen(true), []);
  const closeCart = useCallback(() => setIsCartOpen(false), []);

  // Load persisted cart + coupon on mount (client only — avoids SSR mismatch).
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) setItems(parsed);
      }
      const couponRaw = localStorage.getItem(COUPON_KEY);
      if (couponRaw) {
        const parsed = JSON.parse(couponRaw);
        if (parsed && typeof parsed.code === "string") setAppliedCoupon(parsed);
      }
    } catch {
      // Ignore malformed storage.
    }
    setHydrated(true);
  }, []);

  // Persist whenever the cart changes (after the initial load).
  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    } catch {
      // Storage full / unavailable — non-fatal.
    }
  }, [items, hydrated]);

  // Persist the applied coupon separately.
  useEffect(() => {
    if (!hydrated) return;
    try {
      if (appliedCoupon) {
        localStorage.setItem(COUPON_KEY, JSON.stringify(appliedCoupon));
      } else {
        localStorage.removeItem(COUPON_KEY);
      }
    } catch {
      // non-fatal
    }
  }, [appliedCoupon, hydrated]);

  const addItem = useCallback(
    (item: AddItemInput, quantity = 1) => {
      if (quantity < 1 || cartLineMax(item) < 1) return;
      trackStorefrontEvent("add_to_cart", { productId: item.productId });
      setItems((prev) => {
        const key = lineKey(item.productId, item.variantId);
        const existing = prev.find(
          (i) => lineKey(i.productId, i.variantId) === key,
        );
        // The incoming item carries the freshest stock snapshot (its card/detail
        // page just rendered), so cap against IT — never let repeated adds pile
        // quantity past what the shopper could actually buy.
        const max = cartLineMax(item);
        if (existing) {
          // Refresh the line's stock snapshot from the fresh add, then clamp.
          return prev.map((i) =>
            lineKey(i.productId, i.variantId) === key
              ? {
                  ...i,
                  trackInventory: item.trackInventory,
                  stock: item.stock,
                  allowBackorder: item.allowBackorder,
                  quantity: Math.min(i.quantity + quantity, max),
                }
              : i,
          );
        }
        return [...prev, { ...item, quantity: Math.min(quantity, max) }];
      });
    },
    [trackStorefrontEvent],
  );

  const removeItem = useCallback((key: string) => {
    setItems((prev) =>
      prev.filter((i) => lineKey(i.productId, i.variantId) !== key),
    );
  }, []);

  const setQuantity = useCallback((key: string, quantity: number) => {
    setItems((prev) =>
      quantity < 1
        ? prev.filter((i) => lineKey(i.productId, i.variantId) !== key)
        : prev.map((i) =>
            lineKey(i.productId, i.variantId) === key
              ? // Clamp to the line's own stock snapshot so a stepper can never
                // push a line past available stock.
                { ...i, quantity: Math.min(quantity, cartLineMax(i)) }
              : i,
          ),
    );
  }, []);

  const reconcileStock = useCallback(
    (updates: CartStockUpdate[]): StockReconcileResult => {
      const byKey = new Map(
        updates.map((u) => [lineKey(u.productId, u.variantId), u]),
      );
      const removed: string[] = [];
      const reduced: StockReconcileResult["reduced"] = [];
      const next: CartItem[] = [];
      let changed = false;

      for (const line of itemsRef.current) {
        const fresh = byKey.get(lineKey(line.productId, line.variantId));
        // No fresh info for this line ⇒ couldn't verify it; leave it as-is and
        // let the server reserve_stock be the final word. Only drop a line when
        // we KNOW it's gone (exists === false) or genuinely sold out.
        if (!fresh) {
          next.push(line);
          continue;
        }
        if (!fresh.exists) {
          removed.push(line.name);
          changed = true;
          continue;
        }
        const max = cartLineMax(fresh);
        if (max <= 0) {
          removed.push(line.name);
          changed = true;
          continue;
        }
        const qty = Math.min(line.quantity, max);
        if (qty < line.quantity) {
          reduced.push({ name: line.name, from: line.quantity, to: qty });
        }
        const snapshotChanged =
          line.trackInventory !== fresh.trackInventory ||
          line.stock !== fresh.stock ||
          line.allowBackorder !== fresh.allowBackorder;
        if (qty !== line.quantity || snapshotChanged) changed = true;
        next.push({
          ...line,
          trackInventory: fresh.trackInventory,
          stock: fresh.stock,
          allowBackorder: fresh.allowBackorder,
          quantity: qty,
        });
      }

      if (changed) setItems(next);
      return { removed, reduced };
    },
    [],
  );

  const clear = useCallback(() => {
    setItems([]);
    setAppliedCoupon(null);
  }, []);

  const totalItems = useMemo(
    () => items.reduce((sum, i) => sum + i.quantity, 0),
    [items],
  );

  const subtotal = useMemo(
    () => items.reduce((sum, i) => sum + i.price * i.quantity, 0),
    [items],
  );

  // Recompute the discount locally as the cart changes. The coupon is invalid
  // (0 off) when the cart no longer meets its minimum-order requirement.
  const couponValid = useMemo(() => {
    if (!appliedCoupon) return false;
    if (
      appliedCoupon.minOrderAmount > 0 &&
      subtotal < appliedCoupon.minOrderAmount
    )
      return false;
    return subtotal > 0;
  }, [appliedCoupon, subtotal]);

  const couponDiscount = useMemo(() => {
    if (!appliedCoupon || !couponValid) return 0;
    const raw =
      appliedCoupon.discountType === "percentage"
        ? subtotal * (appliedCoupon.discountValue / 100)
        : appliedCoupon.discountValue;
    return Math.min(Math.round(raw), subtotal);
  }, [appliedCoupon, couponValid, subtotal]);

  const total = useMemo(
    () => Math.max(0, subtotal - couponDiscount),
    [subtotal, couponDiscount],
  );

  const applyCoupon = useCallback(
    async (code: string): Promise<{ error?: string }> => {
      const result = await validateCoupon(code, subtotal);
      if (result.error || !result.coupon) {
        return { error: result.error ?? "Invalid coupon code." };
      }
      setAppliedCoupon(result.coupon);
      return {};
    },
    [subtotal],
  );

  const removeCoupon = useCallback(() => setAppliedCoupon(null), []);

  const value = useMemo(
    () => ({
      items,
      hydrated,
      addItem,
      removeItem,
      setQuantity,
      reconcileStock,
      clear,
      totalItems,
      subtotal,
      isCartOpen,
      openCart,
      closeCart,
      appliedCoupon,
      couponDiscount,
      couponValid,
      total,
      applyCoupon,
      removeCoupon,
    }),
    [
      items,
      hydrated,
      addItem,
      removeItem,
      setQuantity,
      reconcileStock,
      clear,
      totalItems,
      subtotal,
      isCartOpen,
      openCart,
      closeCart,
      appliedCoupon,
      couponDiscount,
      couponValid,
      total,
      applyCoupon,
      removeCoupon,
    ],
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}
