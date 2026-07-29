"use server";

import { headers } from "next/headers";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { getServerUser } from "@/lib/auth/server-user";
import {
  orderItems,
  orders,
  productVariants,
  products,
  storeBillingSettings,
  stores,
  taxClasses,
} from "@/drizzle/schema";
import { getCurrentStore, getCurrentStoreId } from "@/lib/store/resolve";
import { rateLimit, clientIp } from "@/lib/rate-limit";
import { validateCoupon } from "./coupon-actions";
import { CartItem } from "@/app/(storefront)/components/cart/CartProvider";
import { computeTax } from "@/lib/billing/tax";
import { effectivePlan, limitsFor } from "@/lib/plans";
import { getStoreGateway } from "@/lib/payments/provider";
import {
  capturedPayment,
  rzpCreateOrder,
  rzpFetchOrderPayments,
  verifyCheckoutSignature,
} from "@/lib/payments/razorpay";
import { emitEvent } from "@/lib/notifications/record";
import { reportStockChanges } from "@/lib/inventory/alerts";
import { resolveFulfilmentLocation } from "@/lib/fulfilment/resolve";
import {
  pickupEnabled,
  pickupHoldDays,
  pickupLocationsFor,
} from "@/lib/fulfilment/pickup";
import { holdStock, releaseHold } from "@/lib/inventory/reservations";
import {
  recordStorePolicyConsent,
  getCheckoutPolicies,
} from "@/lib/legal/store-consent";
import { summariseItems } from "@/lib/notifications/format";
import {
  rowToBillingSettings,
  rowToTaxClass,
  type BillingSettings,
  type TaxClass,
} from "@/lib/billing/types";

// Aliased select for store_billing_settings preserving the snake_case row shape
// rowToBillingSettings expects (Drizzle would otherwise return camelCase keys).
const BILLING_COLS = {
  store_id: storeBillingSettings.storeId,
  tax_enabled: storeBillingSettings.taxEnabled,
  prices_include_tax: storeBillingSettings.pricesIncludeTax,
  default_tax_class_id: storeBillingSettings.defaultTaxClassId,
  business_name: storeBillingSettings.businessName,
  business_address: storeBillingSettings.businessAddress,
  tax_id: storeBillingSettings.taxId,
  contact_email: storeBillingSettings.contactEmail,
  contact_phone: storeBillingSettings.contactPhone,
  logo_url: storeBillingSettings.logoUrl,
  invoice_prefix: storeBillingSettings.invoicePrefix,
  accent_color: storeBillingSettings.accentColor,
  footer_note: storeBillingSettings.footerNote,
  terms: storeBillingSettings.terms,
  template: storeBillingSettings.template,
};

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Bounds on client-supplied cart data — reject oversized/malformed payloads
// before any DB work so a hostile client can't send 10k line items or negative
// quantities.
const MAX_LINE_ITEMS = 100;
const MAX_QUANTITY_PER_LINE = 1000;
const MAX_FIELD_LEN = 200;
const MAX_NOTES_LEN = 1000;

// Required shipping-address fields. Enforced server-side too (the form's
// `required` attribute is a UX hint, not a security boundary).
const REQUIRED_FIELDS: Array<[keyof CheckoutFormData, string]> = [
  ["firstName", "First name"],
  ["lastName", "Last name"],
  ["email", "Email"],
  ["phone", "Phone"],
  ["addressLine1", "Address"],
  ["city", "City"],
  ["state", "State"],
  ["postalCode", "Postal code"],
  ["country", "Country"],
];

function cleanField(value: string | undefined, maxLen = MAX_FIELD_LEN): string {
  return (value ?? "").toString().trim().slice(0, maxLen);
}

export interface CheckoutFormData {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  notes?: string;
}

export type PaymentMethod = "cod" | "razorpay";

export type CheckoutResult =
  | {
      success: true;
      orderId: string;
      orderRef: string;
      /** Present for online payments — everything the client needs to open
       *  Razorpay Standard Checkout. The amount is the SERVER-computed total. */
      payment?: { rzpOrderId: string; keyId: string; amountPaise: number };
    }
  | { error: string };

// Normalize a coupon code the same way coupon-actions does (stored uppercased,
// no whitespace) so the usage-increment lookup matches the stored row.
function normalizeCode(code: string): string {
  return code.trim().toUpperCase().replace(/\s+/g, "");
}

// Live per-line stock, re-read from the DB and scoped to the host store, so the
// cart can be reconciled against the truth BEFORE the shopper fills the form.
// A cart persisted in localStorage can drift: the merchant lowers stock, deletes
// a product, or another shopper buys the last unit. reserve_stock is still the
// hard guarantee at order time, but this lets us honestly reflect availability
// (clamp quantities, drop vanished/sold-out lines) and tell the shopper up front
// instead of failing them after they've typed an address.
export interface CartStockInfo {
  productId: string;
  variantId: string | null;
  // False when the product (or its selected variant) no longer exists in this
  // store — the line should be removed.
  exists: boolean;
  trackInventory: boolean;
  stock: number;
  allowBackorder: boolean;
}

interface StockRow {
  id: string;
  track_inventory: boolean | null;
  stock: number | null;
  allow_backorder: boolean | null;
}

function toInfo(
  productId: string,
  variantId: string | null,
  row: StockRow | undefined,
): CartStockInfo {
  if (!row) {
    return {
      productId,
      variantId,
      exists: false,
      trackInventory: false,
      stock: 0,
      allowBackorder: false,
    };
  }
  return {
    productId,
    variantId,
    exists: true,
    trackInventory: !!row.track_inventory,
    stock: row.stock ?? 0,
    allowBackorder: !!row.allow_backorder,
  };
}

export async function getCartStock(
  lines: Array<{ productId: string; variantId: string | null }>,
): Promise<CartStockInfo[]> {
  if (!Array.isArray(lines) || lines.length === 0) return [];
  const bounded = lines.slice(0, MAX_LINE_ITEMS);

  const storeId = await getCurrentStoreId();

  const productIds = Array.from(
    new Set(
      bounded
        .map((l) => l.productId)
        .filter((x): x is string => typeof x === "string" && !!x),
    ),
  );
  if (productIds.length === 0) return [];

  const variantIds = Array.from(
    new Set(
      bounded
        .map((l) => l.variantId)
        .filter((x): x is string => typeof x === "string" && !!x),
    ),
  );

  // Read-only, store-scoped stock lookup. Stock is already public on the
  // storefront, so a service-role (RLS-bypassing) read just gives us a single
  // uncached snapshot.
  const { productRows, variantRows } = await withService(async (db) => {
    const productRows = await db
      .select({
        id: products.id,
        track_inventory: products.trackInventory,
        stock: products.stock,
        allow_backorder: products.allowBackorder,
      })
      .from(products)
      .where(
        and(inArray(products.id, productIds), eq(products.storeId, storeId)),
      );
    const variantRows = variantIds.length
      ? await db
          .select({
            id: productVariants.id,
            track_inventory: productVariants.trackInventory,
            stock: productVariants.stock,
            allow_backorder: productVariants.allowBackorder,
          })
          .from(productVariants)
          .where(
            and(
              inArray(productVariants.id, variantIds),
              eq(productVariants.storeId, storeId),
            ),
          )
      : [];
    return { productRows, variantRows };
  });

  const productMap = new Map<string, StockRow>(
    productRows.map((p) => [p.id, p as StockRow]),
  );
  const variantMap = new Map<string, StockRow>();
  for (const v of variantRows) variantMap.set(v.id, v as StockRow);

  return bounded.map((l) => {
    const product = productMap.get(l.productId);
    if (l.variantId) {
      // A variant line is valid only when BOTH the product and the variant
      // still exist in this store; the sellable SKU is the variant.
      const variant = variantMap.get(l.variantId);
      if (!product) return toInfo(l.productId, l.variantId, undefined);
      return toInfo(l.productId, l.variantId, variant);
    }
    return toInfo(l.productId, null, product);
  });
}

// After a reserve fails, read how many units are actually left so the error can
// tell the shopper the exact shortfall (reserve_stock only returns a boolean).
async function availableStock(
  storeId: string,
  productId: string,
  variantId: string | null,
): Promise<number> {
  try {
    const id = variantId ?? productId;
    const rows = await withService((db) =>
      variantId
        ? db
            .select({ stock: productVariants.stock })
            .from(productVariants)
            .where(
              and(
                eq(productVariants.id, id),
                eq(productVariants.storeId, storeId),
              ),
            )
            .limit(1)
        : db
            .select({ stock: products.stock })
            .from(products)
            .where(and(eq(products.id, id), eq(products.storeId, storeId)))
            .limit(1),
    );
    return Math.max(0, rows[0]?.stock ?? 0);
  } catch {
    return 0;
  }
}

// Read a store's tax config authoritatively (uncached, store-scoped) with a
// service-role read. Used by both placeOrder (trust boundary) and
// getCartTaxRates (display), so both agree. Uncached on purpose: an order must
// reflect the tax config at the exact moment it's placed, never a stale copy.
async function readTaxConfig(
  storeId: string,
): Promise<{ billing: BillingSettings; taxClasses: TaxClass[] }> {
  const { billingRow, taxRows } = await withService(async (db) => {
    const billingRows = await db
      .select(BILLING_COLS)
      .from(storeBillingSettings)
      .where(eq(storeBillingSettings.storeId, storeId))
      .limit(1);
    const taxRows = await db
      .select({
        id: taxClasses.id,
        name: taxClasses.name,
        rate: taxClasses.rate,
        sort_order: taxClasses.sortOrder,
      })
      .from(taxClasses)
      .where(eq(taxClasses.storeId, storeId))
      .orderBy(asc(taxClasses.sortOrder));
    return { billingRow: billingRows[0] ?? null, taxRows };
  });
  return {
    billing: rowToBillingSettings(billingRow as Record<string, unknown> | null),
    taxClasses: taxRows.map((r) => rowToTaxClass(r as Record<string, unknown>)),
  };
}

export interface CartTaxResult {
  enabled: boolean;
  inclusive: boolean;
  tax: number;
  byRate: Array<{ rate: number; label: string; tax: number }>;
}

export interface CartTaxRateLine {
  productId: string;
  variantId: string | null;
  /** Authoritative per-unit price (from the DB) — the tax base. */
  price: number;
  /** Resolved tax rate as a percentage (0..100). */
  rate: number;
  /** Tax class name, for the per-rate breakdown label. */
  label?: string;
}

export interface CartTaxRates {
  enabled: boolean;
  inclusive: boolean;
  lines: CartTaxRateLine[];
}

// Resolve the store's tax config + each cart line's authoritative price and tax
// rate for DISPLAY, WITHOUT quantity or discount. Those inputs depend only on
// WHICH products are in the cart, so the client (`useCartTax`) fetches this once
// per product-set change and recomputes the actual tax LOCALLY via the pure
// `computeTax` whenever quantity or the coupon changes — quantity/discount edits
// then cost ZERO round-trips; only adding/removing a product refetches.
// placeOrder remains the authoritative recompute at order time.
export async function getCartTaxRates(
  lines: Array<{ productId: string; variantId: string | null }>,
): Promise<CartTaxRates> {
  const empty: CartTaxRates = { enabled: false, inclusive: false, lines: [] };
  if (!Array.isArray(lines) || lines.length === 0) return empty;
  // Same bound as placeOrder — this is an anonymous-callable action doing
  // service-role reads, so reject oversized payloads before any DB work.
  if (lines.length > MAX_LINE_ITEMS) return empty;
  const safeLines = lines
    .map((l) => ({
      productId: typeof l?.productId === "string" ? l.productId : "",
      variantId: typeof l?.variantId === "string" ? l.variantId : null,
    }))
    .filter((l) => l.productId);
  if (safeLines.length === 0) return empty;

  // Anonymous-callable action doing service-role reads. The client debounces and
  // only refetches on product-set changes, so a real shopper never approaches
  // this — but throttle per IP so a scripted caller can't drive unbounded DB
  // load. Generous cap (well above any human's cart activity, tolerant of shared
  // NAT); the check runs BEFORE the tax reads, and fails OPEN on a DB hiccup.
  // Blocked callers just get the empty result (tax hidden — display only;
  // placeOrder recomputes authoritatively at order time).
  const ip = clientIp(await headers());
  const { allowed } = await rateLimit(`cart-tax:${ip}`, {
    max: 120,
    windowSeconds: 60,
  });
  if (!allowed) return empty;

  const storeId = await getCurrentStoreId();
  const { billing, taxClasses: taxClassList } = await readTaxConfig(storeId);
  if (!billing.taxEnabled) return empty;

  const productIds = Array.from(new Set(safeLines.map((l) => l.productId)));
  const variantIds = Array.from(
    new Set(safeLines.map((l) => l.variantId).filter(Boolean)),
  ) as string[];

  const { productRows, variantRows } = await withService(async (db) => {
    const productRows = await db
      .select({
        id: products.id,
        selling_price: products.sellingPrice,
        tax_class_id: products.taxClassId,
      })
      .from(products)
      .where(
        and(inArray(products.id, productIds), eq(products.storeId, storeId)),
      );
    const variantRows = variantIds.length
      ? await db
          .select({
            id: productVariants.id,
            selling_price: productVariants.sellingPrice,
          })
          .from(productVariants)
          .where(
            and(
              inArray(productVariants.id, variantIds),
              eq(productVariants.storeId, storeId),
            ),
          )
      : [];
    return { productRows, variantRows };
  });

  const pMap = new Map(
    productRows.map((p) => [
      p.id as string,
      p as { selling_price: number; tax_class_id: string | null },
    ]),
  );
  const vMap = new Map(
    variantRows.map((v) => [v.id as string, v as { selling_price: number }]),
  );
  const classById = new Map(taxClassList.map((c) => [c.id, c]));

  const resolved: CartTaxRateLine[] = safeLines.map((l) => {
    const p = pMap.get(l.productId);
    if (!p) {
      return {
        productId: l.productId,
        variantId: l.variantId,
        price: 0,
        rate: 0,
      };
    }
    const price = l.variantId
      ? (vMap.get(l.variantId)?.selling_price ?? p.selling_price)
      : p.selling_price;
    const classId = p.tax_class_id ?? billing.defaultTaxClassId;
    const cls = classId ? classById.get(classId) : null;
    return {
      productId: l.productId,
      variantId: l.variantId,
      price,
      rate: cls?.rate ?? 0,
      label: cls?.name,
    };
  });

  return {
    enabled: true,
    inclusive: billing.pricesIncludeTax,
    lines: resolved,
  };
}

// ---- Online payments (BYO Razorpay — CODEBASE §18) -------------------------

// The store's usable online gateway, or null. Three server-side conditions,
// re-checked on EVERY call (never trusted from the client): credentials are
// connected, the merchant has the channel enabled, and the store's EFFECTIVE
// plan includes online payments (a lapsed plan silently reverts to COD-only
// without touching the stored credentials).
async function onlineGateway(
  storeId: string,
): Promise<{ keyId: string; keySecret: string } | null> {
  const [gateway, storeRows] = await Promise.all([
    getStoreGateway(storeId),
    withService((db) =>
      db
        .select({ plan: stores.plan, plan_expires_at: stores.planExpiresAt })
        .from(stores)
        .where(eq(stores.id, storeId))
        .limit(1),
    ),
  ]);
  const store = storeRows[0];
  if (!gateway?.enabled) return null;
  if (!limitsFor(effectivePlan(store ?? {})).onlinePayments) return null;
  return gateway.creds;
}

export interface CheckoutConfig {
  /** True when the "Pay online" option should render at checkout. */
  onlinePayments: boolean;
  /** The store's public Razorpay key id (needed by checkout.js). */
  keyId: string | null;
  /** Display name for the payment modal header. */
  storeName: string;
}

/** What payment methods this store's checkout offers. Server-computed; the
 *  client only uses it to decide whether to RENDER the method selector —
 *  placeOrder re-checks everything. */
export async function getCheckoutConfig(): Promise<CheckoutConfig> {
  const store = await getCurrentStore();
  const creds = await onlineGateway(store.id);
  return {
    onlinePayments: !!creds,
    keyId: creds?.keyId ?? null,
    storeName: store.name,
  };
}

export interface PickupOptions {
  enabled: boolean;
  locations: {
    id: string;
    name: string;
    /** One readable line, for the picker list. */
    address: string;
    city: string;
    postalCode: string;
    hasStock: boolean;
  }[];
  /** How many shops actually have the whole basket — the "N locations with
   *  your item" line. */
  inStockCount: number;
  holdDays: number;
}

/**
 * Shops this cart could be collected from.
 *
 * Takes the cart so it can say which shops actually have the goods — offering
 * a shop that would then refuse the basket is worse than not offering pickup.
 * Purely for DISPLAY: `placeOrder` re-validates the chosen id (`canCollectAt`),
 * because a client naming a location is a request, not a fact.
 */
export async function getPickupOptions(
  items: CartItem[],
): Promise<PickupOptions> {
  const off: PickupOptions = {
    enabled: false,
    locations: [],
    inStockCount: 0,
    holdDays: 0,
  };
  if (!Array.isArray(items) || items.length === 0) return off;
  if (!(await pickupEnabled())) return off;

  try {
    const storeId = await getCurrentStoreId();
    const productIds = Array.from(
      new Set(
        items
          .map((i) => i.productId)
          .filter((id): id is string => typeof id === "string"),
      ),
    ).slice(0, MAX_LINE_ITEMS);
    if (productIds.length === 0) return off;

    // Whether a line needs stock at all is DB truth, not a cart claim — an
    // untracked or backorderable SKU must never disqualify a shop.
    const [prodRows, varRows] = await withService(async (db) => [
      await db
        .select({
          id: products.id,
          track_inventory: products.trackInventory,
          allow_backorder: products.allowBackorder,
        })
        .from(products)
        .where(
          and(eq(products.storeId, storeId), inArray(products.id, productIds)),
        ),
      await db
        .select({
          id: productVariants.id,
          track_inventory: productVariants.trackInventory,
          allow_backorder: productVariants.allowBackorder,
        })
        .from(productVariants)
        .where(inArray(productVariants.productId, productIds)),
    ]);
    const pMap = new Map(prodRows.map((r) => [r.id, r]));
    const vMap = new Map(varRows.map((r) => [r.id, r]));

    const lines = items
      .filter((i) => pMap.has(i.productId))
      .map((i) => {
        const v = i.variantId ? vMap.get(i.variantId) : null;
        const p = pMap.get(i.productId);
        const tracked = v ? v.track_inventory : p?.track_inventory;
        const backorder = v ? v.allow_backorder : p?.allow_backorder;
        return {
          productId: i.productId,
          variantId: i.variantId ?? null,
          quantity: Math.max(1, Math.trunc(Number(i.quantity) || 1)),
          needsStock: !!tracked && !backorder,
        };
      });

    const locations = await pickupLocationsFor(storeId, lines);
    // Shops that have the whole basket first. Short ones are still listed —
    // shown disabled at the end — because a missing shop is confusing while
    // "not everything is in stock here" is information.
    const ordered = [
      ...locations.filter((l) => l.hasStock),
      ...locations.filter((l) => !l.hasStock),
    ];
    return {
      enabled: locations.length > 0,
      inStockCount: locations.filter((l) => l.hasStock).length,
      locations: ordered.map((l) => {
        const a = (l.address ?? {}) as Record<string, unknown>;
        const str = (k: string) =>
          typeof a[k] === "string" ? (a[k] as string).trim() : "";
        return {
          id: l.id,
          name: l.name,
          address: formatPickupAddress(l.address),
          city: str("city"),
          postalCode: str("postalCode"),
          hasStock: l.hasStock,
        };
      }),
      holdDays: await pickupHoldDays(),
    };
  } catch (err) {
    // Pickup is an extra way to buy — never the reason checkout breaks.
    console.error("getPickupOptions:", errMsg(err));
    return off;
  }
}

/** The shop's address as one readable line. */
function formatPickupAddress(a: Record<string, unknown> | null): string {
  if (!a) return "";
  return ["line1", "line2", "city", "state", "postalCode"]
    .map((k) => (typeof a[k] === "string" ? (a[k] as string).trim() : ""))
    .filter(Boolean)
    .join(", ");
}

export async function placeOrder(
  form: CheckoutFormData,
  items: CartItem[],
  couponCode?: string | null,
  paymentMethod: PaymentMethod = "cod",
  /** Collect at this shop instead of having it delivered (roadmap Phase F).
   *  Re-validated server-side — the client naming a location is a request, not
   *  a fact. */
  pickupLocationId?: string | null,
): Promise<CheckoutResult> {
  // Authenticate the shopper via the identity seam (session-backed).
  const user = await getServerUser();

  if (!user) {
    return { error: "You must be logged in to checkout." };
  }

  // Throttle order placement per customer (abuse / accidental double-submit /
  // scripted spam). Backed by Postgres so it holds across serverless instances;
  // fails open on a DB hiccup, since auth + validation remain the real boundary.
  const rl = await rateLimit(`checkout:${user.id}`, {
    max: 10,
    windowSeconds: 60,
  });
  if (!rl.allowed) {
    return {
      error: "Too many checkout attempts. Please wait a moment and try again.",
    };
  }

  if (paymentMethod !== "cod" && paymentMethod !== "razorpay") {
    return { error: "Invalid payment method." };
  }

  if (items.length === 0) {
    return { error: "Your cart is empty." };
  }
  if (items.length > MAX_LINE_ITEMS) {
    return { error: "Your cart has too many items." };
  }

  // Validate each line's shape before trusting it downstream: a real product id
  // and a whole, positive, bounded quantity.
  for (const item of items) {
    if (typeof item.productId !== "string" || !item.productId) {
      return { error: "Your cart contains an invalid item." };
    }
    if (
      !Number.isInteger(item.quantity) ||
      item.quantity < 1 ||
      item.quantity > MAX_QUANTITY_PER_LINE
    ) {
      return { error: `Invalid quantity for ${item.name || "an item"}.` };
    }
  }

  // Validate required address fields server-side (defense in depth).
  for (const [key, label] of REQUIRED_FIELDS) {
    if (!cleanField(form[key] as string | undefined)) {
      return { error: `${label} is required.` };
    }
  }

  // The order belongs to the store the shopper is actually on (the host),
  // never a store inferred from client-supplied cart contents.
  const storeId = await getCurrentStoreId();

  // Orders/order_items are written with a service-role (RLS-bypassing) scope:
  // there is no customer INSERT RLS policy on those tables by design (see
  // orders_table.sql), and all prices/totals are re-derived from the DB below,
  // not trusted from the client — so the write is safe with RLS bypassed.

  // For an online payment, resolve the store's gateway UP FRONT (connected +
  // enabled + plan allows — all server-side) so an unavailable gateway fails
  // fast, before any coupon/stock reservation.
  let gatewayCreds: { keyId: string; keySecret: string } | null = null;
  if (paymentMethod === "razorpay") {
    gatewayCreds = await onlineGateway(storeId);
    if (!gatewayCreds) {
      return {
        error:
          "Online payment isn't available right now. Please choose Cash on Delivery.",
      };
    }
  }

  // 1. Re-validate prices by fetching products from the DB (anti-tampering),
  //    scoped to the host store so another store's products can't be smuggled in.
  const productIds = Array.from(new Set(items.map((i) => i.productId)));

  const dbProducts = await withService((db) =>
    db
      .select({
        id: products.id,
        name: products.name,
        selling_price: products.sellingPrice,
        store_id: products.storeId,
        tax_class_id: products.taxClassId,
        // Routing only: a location cannot be disqualified by a SKU that has no
        // stock to run out of (roadmap Phase D).
        track_inventory: products.trackInventory,
        allow_backorder: products.allowBackorder,
      })
      .from(products)
      .where(
        and(inArray(products.id, productIds), eq(products.storeId, storeId)),
      ),
  );

  if (!dbProducts || dbProducts.length === 0) {
    return { error: "One or more products were not found." };
  }

  const productsMap = new Map(dbProducts.map((p) => [p.id, p]));

  // Tax config + rate resolver. A line's rate comes from its product's tax
  // class, falling back to the store default; only applied when tax is enabled.
  // Read store-scoped (service role), never trusting the client.
  const { billing, taxClasses: taxClassList } = await readTaxConfig(storeId);
  const taxClassById = new Map(taxClassList.map((c) => [c.id, c]));
  const resolveTax = (
    p: { tax_class_id?: string | null } | undefined,
  ): { rate: number; name: string | null } => {
    if (!billing.taxEnabled) return { rate: 0, name: null };
    const classId = p?.tax_class_id ?? billing.defaultTaxClassId;
    const cls = classId ? taxClassById.get(classId) : null;
    return cls ? { rate: cls.rate, name: cls.name } : { rate: 0, name: null };
  };

  // 2. Fetch variants if any (also store-scoped).
  const variantIds = Array.from(
    new Set(items.map((i) => i.variantId).filter(Boolean)),
  ) as string[];
  const variantsMap = new Map<
    string,
    {
      id: string;
      name: string;
      selling_price: number;
      track_inventory?: boolean | null;
      allow_backorder?: boolean | null;
    }
  >();
  if (variantIds.length > 0) {
    const dbVariants = await withService((db) =>
      db
        .select({
          id: productVariants.id,
          name: productVariants.name,
          selling_price: productVariants.sellingPrice,
          track_inventory: productVariants.trackInventory,
          allow_backorder: productVariants.allowBackorder,
        })
        .from(productVariants)
        .where(
          and(
            inArray(productVariants.id, variantIds),
            eq(productVariants.storeId, storeId),
          ),
        ),
    );

    for (const v of dbVariants) {
      variantsMap.set(v.id, v);
    }
  }

  let subtotal = 0;
  const validItems: Array<{
    product_id: string;
    variant_id: string | null;
    name: string;
    variant_name: string | null;
    price: number;
    quantity: number;
    total: number;
    // Tax snapshot per line (rate resolved from the product's tax class). Filled
    // in below once the discount is known so tax is computed on the net amount.
    tax_rate: number;
    tax_amount: number;
    tax_class_name: string | null;
  }> = [];

  for (const item of items) {
    const dbProduct = productsMap.get(item.productId);
    if (!dbProduct)
      return { error: `Product no longer available: ${item.name}` };

    let price = dbProduct.selling_price;
    const name = dbProduct.name;
    let variantName: string | null = null;

    if (item.variantId) {
      const dbVariant = variantsMap.get(item.variantId);
      if (!dbVariant)
        return { error: `Variant no longer available: ${item.variantName}` };
      price = dbVariant.selling_price;
      variantName = dbVariant.name;
    }

    const taxInfo = resolveTax(dbProduct);
    subtotal += price * item.quantity;
    validItems.push({
      product_id: item.productId,
      variant_id: item.variantId,
      name,
      variant_name: variantName,
      price,
      quantity: item.quantity,
      total: price * item.quantity,
      tax_rate: taxInfo.rate,
      tax_amount: 0,
      tax_class_name: taxInfo.name,
    });
  }

  // 3. Validate and apply coupon. Round to whole rupees and clamp to subtotal so
  //    the stored total matches what the cart showed the shopper (CartProvider
  //    rounds identically).
  let discount = 0;
  let couponApplied = false;
  const couponCodeNormalized = couponCode ? normalizeCode(couponCode) : null;
  if (couponCode) {
    const validation = await validateCoupon(couponCode, subtotal);
    if (validation.error) {
      return { error: `Coupon error: ${validation.error}` };
    }
    if (validation.coupon) {
      couponApplied = true;
      const raw =
        validation.coupon.discountType === "fixed"
          ? validation.coupon.discountValue
          : subtotal * (validation.coupon.discountValue / 100);
      discount = Math.min(Math.round(raw), subtotal);
    }
  }

  const shipping = 0; // Hardcoded free shipping for now

  // 3c. Compute tax from each line's resolved rate, on the DISCOUNTED amount
  //     (see lib/billing/tax.ts). Exclusive: tax is ADDED to the total.
  //     Inclusive: tax is already inside the listed prices, so it's reported but
  //     NOT added again. Per-line tax is written back to each order item below.
  const taxResult = computeTax({
    lines: validItems.map((it) => ({
      amount: it.total,
      rate: it.tax_rate,
      label: it.tax_class_name ?? undefined,
    })),
    discount,
    pricesIncludeTax: billing.pricesIncludeTax,
    enabled: billing.taxEnabled,
  });
  const tax = taxResult.totalTax;
  validItems.forEach((it, idx) => {
    it.tax_amount = taxResult.lines[idx]?.tax ?? 0;
  });

  const total = Math.max(
    0,
    subtotal - discount + shipping + (billing.pricesIncludeTax ? 0 : tax),
  );

  // Store only trimmed, length-capped values (the fields render in the admin
  // dashboard; React escapes output, but we keep the stored data clean too).
  const shippingAddress = {
    firstName: cleanField(form.firstName),
    lastName: cleanField(form.lastName),
    addressLine1: cleanField(form.addressLine1),
    addressLine2: cleanField(form.addressLine2),
    city: cleanField(form.city),
    state: cleanField(form.state),
    postalCode: cleanField(form.postalCode),
    country: cleanField(form.country),
    email: cleanField(form.email),
    phone: cleanField(form.phone),
  };
  const notes = cleanField(form.notes, MAX_NOTES_LEN) || null;

  // The order id is generated up front so the order row and its stock-ledger
  // movements share it. What follows is a reserve → create → reserve → rollback
  // flow. There is NO cross-statement transaction over PostgREST, so every
  // failure path unwinds each step that already succeeded, in reverse order.
  const orderId = crypto.randomUUID();

  // 3b. Reserve a coupon use ATOMICALLY, before creating the order, so a
  //     max_uses cap can never be exceeded even under simultaneous checkouts
  //     (increment_coupon_usage does a single conditional UPDATE and returns
  //     false when the cap is already hit). This touches only the `coupons`
  //     table (no FK to `orders`), so it can safely run before the order exists;
  //     we release it below if a later step fails. A transient RPC error fails
  //     OPEN — we don't block a paying customer over the usage counter
  //     (validation already passed).
  let couponReserved = false;
  if (couponApplied && couponCodeNormalized) {
    try {
      const res = await withService((db) =>
        db.execute(
          sql`select increment_coupon_usage(p_code => ${couponCodeNormalized}, p_store_id => ${storeId}) as reserved`,
        ),
      );
      const reserved = (res.rows[0] as { reserved: boolean | null } | undefined)
        ?.reserved;
      if (reserved === false) {
        return { error: "This coupon has reached its usage limit." };
      }
      couponReserved = true;
    } catch (err) {
      // A transient RPC error fails OPEN — never block a paying customer over
      // the usage counter (validation already passed).
      console.error("increment_coupon_usage:", errMsg(err));
    }
  }

  const releaseCoupon = async () => {
    if (couponReserved && couponCodeNormalized) {
      await withService((db) =>
        db.execute(
          sql`select decrement_coupon_usage(p_code => ${couponCodeNormalized}, p_store_id => ${storeId})`,
        ),
      ).catch((err) => console.error("decrement_coupon_usage:", errMsg(err)));
    }
  };

  // 4. Create the order BEFORE reserving stock. Each stock reservation writes a
  //    `stock_movements` row whose `order_id` references `orders(id)`, so the
  //    order row must already exist — otherwise the ledger insert violates that
  //    foreign key and every tracked-SKU checkout fails. We pass the
  //    pre-generated id so the sale movements carry the real order id from the
  //    start.
  // Where this order ships from (roadmap Phase D). Before this, every online
  // order reserved against the store's DEFAULT location via the reserve_stock
  // wrapper — so a store with stock in a second shop advertised it and then
  // failed the order. null means "no better answer": the wrapper's default
  // location, exactly as before. Routing must never be why a sale is refused.
  // A CUSTOMER-CHOSEN pickup shop overrides routing entirely: they are driving
  // there. Validated against capability AND stock, because the client only
  // sends an id.
  const routingLines = validItems.map((it) => {
    const p = productsMap.get(it.product_id);
    const v = it.variant_id ? variantsMap.get(it.variant_id) : null;
    const tracked = v ? v.track_inventory : p?.track_inventory;
    const backorder = v ? v.allow_backorder : p?.allow_backorder;
    return {
      productId: it.product_id,
      variantId: it.variant_id,
      quantity: it.quantity,
      needsStock: !!tracked && !backorder,
    };
  });

  let pickupAt: string | null = null;
  let pickupShop: { name: string; address: string } | null = null;
  if (typeof pickupLocationId === "string" && pickupLocationId) {
    const options = await pickupLocationsFor(storeId, routingLines);
    const chosen = options.find((o) => o.id === pickupLocationId && o.hasStock);
    if (!chosen) {
      return {
        error:
          "That shop can't fulfil this order for collection. Choose another, or switch to delivery.",
      };
    }
    pickupAt = chosen.id;
    // Carried into the confirmation so the shopper is told WHERE to collect —
    // the whole point of the email changing for a pickup.
    pickupShop = {
      name: chosen.name,
      address: formatPickupAddress(chosen.address),
    };
  }

  const fulfilmentLocationId =
    pickupAt ?? (await resolveFulfilmentLocation(storeId, routingLines));
  const holdDays = pickupAt ? await pickupHoldDays() : 0;

  const orderRows = await withService((db) =>
    db
      .insert(orders)
      // order_no / order_ref are NOT NULL but owned by the BEFORE-INSERT trigger
      // (identifiers_04_triggers.sql) — the app never sends them, so the insert
      // type is asserted past those columns.
      .values({
        id: orderId,
        storeId,
        customerId: user.id,
        status: "pending",
        paymentMethod:
          paymentMethod === "razorpay" ? "razorpay" : "cash_on_delivery",
        paymentStatus: "pending",
        shippingAddress,
        billingAddress: null, // COD uses shipping as billing essentially
        subtotal,
        tax,
        taxInclusive: billing.pricesIncludeTax,
        shipping,
        discount,
        total,
        currency: "INR",
        appliedCouponCode: couponCode || null,
        locationId: fulfilmentLocationId,
        fulfilmentType: pickupAt ? "pickup" : "delivery",
        pickupLocationId: pickupAt,
        pickupStatus: pickupAt ? "awaiting" : null,
        pickupExpiresAt: pickupAt
          ? sql`now() + make_interval(days => ${holdDays})`
          : null,
        notes,
        // This order goes through the reserve flow below; mark it so that
        // cancellation restocks it exactly once (and never restocks legacy
        // orders, which stay 'none'). If the reserve loop fails, the order row
        // is deleted, so this value only ever persists on a fully-reserved order.
        // A pickup's units are HELD, not taken: cancelling it releases the
        // holds instead of restocking, so it must not claim the
        // reserved→released restock path (order-actions).
        stockStatus: pickupAt ? "none" : "reserved",
      } as typeof orders.$inferInsert)
      .returning({ id: orders.id, order_ref: orders.orderRef }),
  ).catch((err) => {
    console.error("Order creation error:", errMsg(err));
    return null;
  });

  const order = orderRows?.[0];
  if (!order) {
    await releaseCoupon(); // give the reserved coupon use back
    return { error: "Failed to create order. Please try again." };
  }

  // 4b. Reserve stock ATOMICALLY for each line, now that the order row exists so
  //     the ledger's order_id FK is satisfied. If any line would oversell, roll
  //     everything back. IMPORTANT: release stock BEFORE deleting the order — the
  //     order row must still exist for the release movements to be written
  //     (deleting it SET NULLs their order_id afterwards).
  const reservedStockItems: Array<{
    product_id: string;
    variant_id: string | null;
    qty: number;
  }> = [];

  const releaseStock = async () => {
    for (const r of reservedStockItems) {
      await withService((db) =>
        db.execute(
          sql`select release_stock(p_store => ${storeId}, p_product => ${r.product_id}, p_variant => ${r.variant_id}, p_qty => ${r.qty}, p_order => ${order.id}, p_reason => ${"checkout_failed"})`,
        ),
      ).catch((err) => console.error("release_stock:", errMsg(err)));
    }
  };

  // Holds taken for a pickup order (Phase F). Released, not restocked, on a
  // rollback — nothing left the shelf, so there is nothing to put back.
  const heldIds: string[] = [];
  const releaseHolds = async () => {
    for (const id of heldIds) {
      await releaseHold(id).catch((err) =>
        console.error("release_stock_hold:", errMsg(err)),
      );
    }
  };

  // Best-effort rollback delete of the order row (no cross-statement txn; the
  // caller has already released stock first so the movements still wrote).
  const deleteOrder = async () => {
    await withService((db) =>
      db.delete(orders).where(eq(orders.id, order.id)),
    ).catch((err) => console.error("order rollback delete:", errMsg(err)));
  };

  for (const item of validItems) {
    let reserved: boolean | null | undefined;
    let reserveFailed = false;
    try {
      if (pickupAt) {
        // A pickup HOLDS the units: they stay on that shop's shelf until
        // somebody hands them over (locations_04). Selling them now would show
        // the shelf empty while the goods are still physically on it.
        const holdId = await holdStock({
          storeId,
          locationId: pickupAt,
          productId: item.product_id,
          variantId: item.variant_id,
          quantity: item.quantity,
          owner: "pickup",
          ownerId: order.id,
          // The order's own expiry is the hold's expiry — one deadline, so the
          // stock can never come back while the order still promises it.
          ttlMinutes: holdDays * 24 * 60,
        });
        if (holdId) heldIds.push(holdId);
        reserved = !!holdId;
      } else {
        const res = await withService((db) =>
          db.execute(
            fulfilmentLocationId
              ? sql`select reserve_stock_at(p_store => ${storeId}, p_location => ${fulfilmentLocationId}, p_product => ${item.product_id}, p_variant => ${item.variant_id}, p_qty => ${item.quantity}, p_order => ${order.id}) as reserved`
              : sql`select reserve_stock(p_store => ${storeId}, p_product => ${item.product_id}, p_variant => ${item.variant_id}, p_qty => ${item.quantity}, p_order => ${order.id}) as reserved`,
          ),
        );
        reserved = (res.rows[0] as { reserved: boolean | null } | undefined)
          ?.reserved;
      }
    } catch (err) {
      console.error("reserve_stock:", errMsg(err));
      reserveFailed = true;
    }

    if (reserveFailed || !reserved) {
      await releaseHolds();
      await releaseHolds();
      await releaseStock();
      await deleteOrder();
      await releaseCoupon();
      // Report the exact shortfall so the shopper knows what to do rather than
      // seeing a generic "not enough stock". reserve_stock failed because the
      // SKU is tracked, non-backorderable, and short — so the live count is the
      // most they can take.
      const label = item.variant_name
        ? `${item.name} (${item.variant_name})`
        : item.name;
      const remaining = await availableStock(
        storeId,
        item.product_id,
        item.variant_id,
      );
      return {
        error:
          remaining > 0
            ? `Not enough stock for ${label} — only ${remaining} left. Please lower the quantity and try again.`
            : `${label} just sold out. Please remove it from your cart and try again.`,
      };
    }
    // Only a real reserve is restockable. A held line is undone by releasing
    // the hold — putting it here too would ADD units that never left.
    if (!pickupAt) {
      reservedStockItems.push({
        product_id: item.product_id,
        variant_id: item.variant_id,
        qty: item.quantity,
      });
    }
  }

  // 5. Create order items. If this fails, roll back everything: release the
  //    reserved stock (order still present so the movements write), then delete
  //    the order, then give the coupon use back — no orphan order is left behind
  //    (there is no cross-statement transaction).
  const orderItemsToInsert = validItems.map((item) => ({
    orderId: order.id,
    productId: item.product_id,
    variantId: item.variant_id,
    name: item.name,
    variantName: item.variant_name,
    price: item.price,
    quantity: item.quantity,
    total: item.total,
    taxRate: item.tax_rate,
    taxAmount: item.tax_amount,
    taxClassName: item.tax_class_name,
  }));

  let itemsFailed = false;
  try {
    await withService((db) => db.insert(orderItems).values(orderItemsToInsert));
  } catch (err) {
    console.error("Order items error:", errMsg(err));
    itemsFailed = true;
  }

  if (itemsFailed) {
    await releaseHolds();
    await releaseStock();
    await deleteOrder();
    await releaseCoupon();
    return { error: "Failed to save order items. Please try again." };
  }

  const orderRef = (order as { order_ref?: string }).order_ref ?? "";

  // Consent to the store's payment + refund terms, recorded against the order
  // that triggered it. Deliberately AFTER the order is safely persisted: the
  // shopper agreed by placing it, and a consent write that could roll back a
  // paid order would be the tail wagging the dog. Best-effort, like every
  // other bookkeeping write below.
  await recordStorePolicyConsent({
    userId: user.id,
    email: user.email ?? null,
    storeId,
    context: "checkout",
    policies: await getCheckoutPolicies(storeId),
  });

  // The order exists and its items are saved — from here it is a real order, so
  // record it. Emitted for BOTH payment methods (an unpaid razorpay order is
  // still a placed order, exactly as the dashboard list shows it); the separate
  // order.payment_received fires when the money actually lands. emitEvent
  // defers via after(), so nothing below waits on it and a bookkeeping failure
  // can never fail a checkout that already succeeded.
  emitEvent({
    type: "order.placed",
    storeId,
    // The shop this will ship from. Null when routing had no better answer —
    // an event with no location is never narrowed by one (routing.ts).
    locationId: fulfilmentLocationId,
    actor: {
      type: "customer",
      id: user.id,
      label:
        [shippingAddress.firstName, shippingAddress.lastName]
          .filter(Boolean)
          .join(" ") || null,
    },
    subject: { type: "order", id: order.id, label: orderRef },
    customerId: user.id,
    payload: {
      total,
      currency: "INR",
      items: summariseItems(orderItemsToInsert),
      paymentMethod,
      // Only on a pickup. A delivery order's fact list is unchanged — an empty
      // "Pickup location" row on every confirmation would be noise.
      ...(pickupAt
        ? {
            fulfilment: "pickup",
            pickupLocation: pickupShop?.name ?? "",
            pickupAddress: pickupShop?.address ?? "",
          }
        : {}),
    },
    // The order summary the email renders as a table. Separate from `payload`
    // on purpose — see EmitEventInput.email.
    email: {
      currency: "INR",
      items: orderItemsToInsert.map((i) => ({
        name: i.name,
        variant: i.variantName,
        quantity: i.quantity,
        total: i.total,
      })),
      subtotal,
      discount,
      tax,
      shipping,
      total,
    },
  });

  // Tell the merchant if this sale just emptied a shelf. Deferred, and keyed on
  // the threshold CROSSING, so a slow-moving SKU alerts once rather than on
  // every subsequent order (lib/notifications/inventory-alerts.ts).
  reportStockChanges(
    storeId,
    reservedStockItems.map((r) => ({
      productId: r.product_id,
      variantId: r.variant_id,
      delta: -r.qty,
    })),
  );

  // 6. Online payment: create the Razorpay Order for the SERVER-computed total
  //    (never the client's) and pin its id to our order. Any failure here
  //    unwinds the whole checkout (stock → order [items cascade] → coupon) —
  //    a razorpay order without a rzp order id could never be paid or
  //    reconciled. From here the order stays `payment_status: 'pending'` until
  //    confirmOnlinePayment verifies the HMAC (or a reconcile path finds the
  //    captured payment); the expire-pending-payments reaper cancels + restocks
  //    it if no payment ever lands.
  if (paymentMethod === "razorpay" && gatewayCreds) {
    const amountPaise = Math.round(total * 100);
    const rollback = async () => {
      await releaseHolds();
      await releaseStock();
      await deleteOrder();
      await releaseCoupon();
    };

    const rzpRes = await rzpCreateOrder(gatewayCreds, {
      amountPaise,
      receipt: orderRef || order.id,
      notes: { order_id: order.id, store_id: storeId },
    });
    if (!rzpRes.ok) {
      console.error("placeOrder (razorpay create):", rzpRes.error);
      await rollback();
      return {
        error:
          "Couldn't start the online payment. Please try again or choose Cash on Delivery.",
      };
    }

    let pinFailed = false;
    try {
      await withService((db) =>
        db
          .update(orders)
          .set({ razorpayOrderId: rzpRes.data.id })
          .where(eq(orders.id, order.id)),
      );
    } catch (err) {
      console.error("placeOrder (razorpay pin):", errMsg(err));
      pinFailed = true;
    }
    if (pinFailed) {
      await rollback();
      return {
        error:
          "Couldn't start the online payment. Please try again or choose Cash on Delivery.",
      };
    }

    return {
      success: true,
      orderId: order.id,
      orderRef,
      payment: {
        rzpOrderId: rzpRes.data.id,
        keyId: gatewayCreds.keyId,
        amountPaise,
      },
    };
  }

  return {
    success: true,
    orderId: order.id,
    orderRef,
  };
}

// ---- Payment confirmation & reconciliation ---------------------------------

export interface ConfirmPaymentResult {
  success?: boolean;
  /** True once the order is marked paid (idempotent). */
  paid?: boolean;
  error?: string;
}

// Load an order for payment confirmation, scoped to the host store AND the
// signed-in shopper — a customer can only ever confirm their own order.
async function loadOwnRazorpayOrder(
  storeId: string,
  userId: string,
  orderId: string,
) {
  const rows = await withService((db) =>
    db
      .select({
        id: orders.id,
        payment_method: orders.paymentMethod,
        payment_status: orders.paymentStatus,
        razorpay_order_id: orders.razorpayOrderId,
      })
      .from(orders)
      .where(
        and(
          eq(orders.id, orderId),
          eq(orders.storeId, storeId),
          eq(orders.customerId, userId),
        ),
      )
      .limit(1),
  );
  return (rows[0] ?? null) as {
    id: string;
    payment_method: string;
    payment_status: string;
    razorpay_order_id: string | null;
  } | null;
}

// Mark a razorpay order paid exactly once (conditional UPDATE — the
// pending→paid transition is claimed atomically, so the client callback and
// the reconcile paths can race safely).
async function markOrderPaid(
  orderId: string,
  rzpPaymentId: string,
): Promise<void> {
  // The single choke point for "this order is now paid" — reached from the
  // client callback, reconcile-on-read, and the cron reaper alike. The UPDATE
  // is a conditional pending → paid CLAIM, so `claimed` is non-empty for
  // exactly one caller and the notification can't fire twice for one payment.
  const claimed = await withService((db) =>
    db
      .update(orders)
      .set({ paymentStatus: "paid", razorpayPaymentId: rzpPaymentId })
      .where(and(eq(orders.id, orderId), eq(orders.paymentStatus, "pending")))
      .returning({
        storeId: orders.storeId,
        orderRef: orders.orderRef,
        customerId: orders.customerId,
        total: orders.total,
        currency: orders.currency,
      }),
  ).catch((err) => {
    console.error("markOrderPaid:", errMsg(err));
    return [] as {
      storeId: string;
      orderRef: string;
      customerId: string;
      total: number;
      currency: string;
    }[];
  });

  const row = claimed[0];
  if (!row) return;

  emitEvent({
    type: "order.payment_received",
    storeId: row.storeId,
    actor: { type: "customer", id: row.customerId },
    subject: { type: "order", id: orderId, label: row.orderRef },
    payload: { total: row.total, currency: row.currency },
  });
}

/**
 * Called by the checkout client after Razorpay Standard Checkout succeeds.
 * Verifies the HMAC signature with the STORE's key secret (server-side) and
 * marks the order paid. Idempotent — double calls / races with the reconcile
 * paths are no-ops.
 */
export async function confirmOnlinePayment(
  orderId: string,
  rzpPaymentId: string,
  rzpSignature: string,
): Promise<ConfirmPaymentResult> {
  const user = await getServerUser();
  if (!user) return { error: "You must be logged in." };

  if (
    typeof orderId !== "string" ||
    !orderId ||
    typeof rzpPaymentId !== "string" ||
    !rzpPaymentId ||
    typeof rzpSignature !== "string" ||
    !rzpSignature
  ) {
    return { error: "Invalid payment confirmation." };
  }

  const rl = await rateLimit(`confirm-payment:${user.id}`, {
    max: 20,
    windowSeconds: 60,
  });
  if (!rl.allowed) {
    return { error: "Too many attempts. Please wait a moment." };
  }

  const storeId = await getCurrentStoreId();

  const order = await loadOwnRazorpayOrder(storeId, user.id, orderId);
  if (!order || order.payment_method !== "razorpay") {
    return { error: "Order not found." };
  }
  if (order.payment_status === "paid") return { success: true, paid: true };
  if (order.payment_status !== "pending" || !order.razorpay_order_id) {
    return { error: "This order can no longer be paid." };
  }

  const gateway = await getStoreGateway(storeId);
  if (!gateway) {
    return {
      error: "Payment verification is unavailable. Please contact the store.",
    };
  }

  const valid = verifyCheckoutSignature(
    gateway.creds.keySecret,
    order.razorpay_order_id,
    rzpPaymentId,
    rzpSignature,
  );
  if (!valid) {
    console.error("confirmOnlinePayment: bad signature for order", orderId);
    return { error: "Payment verification failed." };
  }

  await markOrderPaid(orderId, rzpPaymentId);
  return { success: true, paid: true };
}

/**
 * Reconcile-on-read for a shopper's own PENDING razorpay order (the success/
 * confirmation page calls this when the client callback was dropped — closed
 * tab, network blip). Queries Razorpay directly: a captured payment there is
 * the source of truth ⇒ mark paid.
 */
export async function reconcileMyOrderPayment(
  orderId: string,
): Promise<ConfirmPaymentResult> {
  const user = await getServerUser();
  if (!user) return { error: "You must be logged in." };
  if (typeof orderId !== "string" || !orderId) {
    return { error: "Order not found." };
  }

  const rl = await rateLimit(`reconcile-payment:${user.id}`, {
    max: 10,
    windowSeconds: 60,
  });
  if (!rl.allowed) return { error: "Too many attempts." };

  const storeId = await getCurrentStoreId();

  const order = await loadOwnRazorpayOrder(storeId, user.id, orderId);
  if (!order || order.payment_method !== "razorpay") {
    return { error: "Order not found." };
  }
  if (order.payment_status === "paid") return { success: true, paid: true };
  if (order.payment_status !== "pending" || !order.razorpay_order_id) {
    return { success: true, paid: false };
  }

  const gateway = await getStoreGateway(storeId);
  if (!gateway) return { success: true, paid: false };

  const payments = await rzpFetchOrderPayments(
    gateway.creds,
    order.razorpay_order_id,
  );
  if (!payments.ok) return { success: true, paid: false };

  const captured = capturedPayment(payments.data);
  if (!captured) return { success: true, paid: false };

  await markOrderPaid(orderId, captured.id);
  return { success: true, paid: true };
}
