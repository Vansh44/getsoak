"use server";

// POS Phase 2 — the sell path. `placePosSale` is the register's trust boundary
// and mirrors placeOrder (checkout-actions.ts, CODEBASE §12) exactly:
//
//   * the OPERATOR is resolved server-side (device-bound; never from the client)
//   * prices are RE-READ from the DB, store-scoped — the client's are ignored
//   * discounts are re-derived and capped, with manager approval above the cap
//   * tax is recomputed with computeTax + the GST place-of-supply split
//   * stock is reserved atomically AT THE REGISTER'S LOCATION
//   * writes run under the service role AFTER all of the above
//   * every failure unwinds the steps that already succeeded, in reverse
//
// There is no cross-statement transaction over the pool, hence the manual
// rollback chain — the same discipline placeOrder uses.

import {
  and,
  count,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  isNotNull,
  or,
  sql,
} from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withService } from "@/lib/db/client";
import { dbErrorMessage } from "@/lib/db/errors";
import {
  inventoryLevels,
  orderItems,
  orderPayments,
  orders,
  productVariants,
  products,
  storeBillingSettings,
  storeLocations,
  taxClasses,
  users,
} from "@/drizzle/schema";
import { resolvePosOperator } from "@/lib/pos/operator";
import { likePattern } from "@/lib/pos/search";
import { personLabel } from "@/lib/pos/person";
import { currentShiftIdFor } from "./pos-shift-actions";
import { emitEvent } from "@/lib/notifications/record";
import { reportStockChanges } from "@/lib/inventory/alerts";
import { summariseItems } from "@/lib/notifications/format";
import { posCan, type PosActorRole } from "@/lib/pos/permissions";
import { verifyPin } from "@/lib/pos/pin";
import {
  type ApprovableSale,
  saleFingerprint,
  signApprovalToken,
  verifyApprovalToken,
} from "@/lib/pos/approval";
import {
  posSessionConfigured,
  POS_SECRET_MISSING_ERROR,
} from "@/lib/pos/session";
import { posStaff, posStaffLocations } from "@/drizzle/schema";
import { posTotals } from "@/lib/pos/totals";
import {
  settleTenders,
  validateTenderShape,
  type PosTender,
} from "@/lib/pos/tenders";
import { isIntraState, isValidGstinFormat, splitGst } from "@/lib/billing/gst";
import { rowToBillingSettings, rowToTaxClass } from "@/lib/billing/types";
import { getStoreSettings } from "@/lib/settings/resolve";
import { rateLimit } from "@/lib/rate-limit";
import { buildReceiptModel, type ReceiptModel } from "@/lib/pos/receipt";
import { getStoreBrandById } from "@/lib/store/brand";

// Bounds on client-supplied cart data (mirrors checkout-actions).
const MAX_LINE_ITEMS = 200;
const MAX_QTY_PER_LINE = 1000;

export interface PosCartLine {
  productId: string;
  variantId: string | null;
  quantity: number;
  /** Cashier's per-line discount in rupees (validated against the cap). */
  lineDiscount?: number;
  /** Cashier-entered price override in rupees (gated by pos.allowPriceOverride). */
  priceOverride?: number | null;
}

// The tender vocabulary, the allowlist and the coverage math moved to
// lib/pos/tenders.ts when the collection counter became a second place money is
// taken (§23). Re-exported so importers are unchanged — types are erased, so a
// type re-export from a "use server" file is not an endpoint.
export type { PosTender, PosTenderMethod } from "@/lib/pos/tenders";

export interface PosSaleResult {
  success?: boolean;
  error?: string;
  /** Set when the action needs a manager PIN to proceed. */
  needsApproval?: boolean;
  orderId?: string;
  receiptNo?: string;
  orderRef?: string;
  changeDue?: number;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Aliased select preserving the snake_case shape rowToBillingSettings expects.
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

// ---- Register config -------------------------------------------------------

export interface RegisterConfig {
  /** Scope the client-side catalog cache — one cached catalog per register,
   *  since stock is per-location and a browser can be shared between stores. */
  storeId: string;
  locationId: string;
  locationName: string;
  operatorName: string;
  role: PosActorRole;
  taxEnabled: boolean;
  gstEnabled: boolean;
  pricesIncludeTax: boolean;
  /** Tax-class id → rate (%). Sent once at register open so the sell screen can
   *  quote the SAME total placePosSale will charge. Rates live here rather than
   *  baked into the cached catalog because the catalog persists in IndexedDB —
   *  a rate change would otherwise stay stale until the next background sync. */
  taxRates: Record<string, number>;
  /** Applied to products with no tax class of their own. */
  defaultTaxClassId: string | null;
  currency: string;
  /** Whether to render the discount fields at all. The SERVER still refuses a
   *  discount from anyone else — this only keeps a control off the screen that
   *  the cashier would be told off for using. It replaces the cap/approval
   *  numbers that used to ride here unread: the client must not hold the
   *  discount policy, only the answer. */
  canDiscount: boolean;
  /** Same, for a line's price. Replaces the raw `allowPriceOverride` setting:
   *  the merchant's on/off switch is only half the answer, and shipping half an
   *  answer to the client is how a UI ends up offering what the server refuses.
   *  (No override control exists on the register yet — this is what one would
   *  ask.) */
  canOverridePrice: boolean;
}

export async function getRegisterConfig(): Promise<
  RegisterConfig | { error: string }
> {
  const op = await resolvePosOperator();
  if (!op) return { error: "Not signed in." };

  const [billingRows, locRows, settings, classRows] = await Promise.all([
    withService((db) =>
      db
        .select({
          tax_enabled: storeBillingSettings.taxEnabled,
          prices_include_tax: storeBillingSettings.pricesIncludeTax,
          gst_enabled: storeBillingSettings.gstEnabled,
          default_tax_class_id: storeBillingSettings.defaultTaxClassId,
        })
        .from(storeBillingSettings)
        .where(eq(storeBillingSettings.storeId, op.storeId))
        .limit(1),
    ).catch(() => []),
    withService((db) =>
      db
        .select({ name: storeLocations.name })
        .from(storeLocations)
        .where(eq(storeLocations.id, op.locationId))
        .limit(1),
    ).catch(() => []),
    getStoreSettings(),
    withService((db) =>
      db
        .select({ id: taxClasses.id, rate: taxClasses.rate })
        .from(taxClasses)
        .where(eq(taxClasses.storeId, op.storeId)),
    ).catch(() => []),
  ]);

  const taxRates: Record<string, number> = {};
  for (const c of classRows) {
    if (c.id) taxRates[c.id] = Number(c.rate) || 0;
  }

  return {
    storeId: op.storeId,
    locationId: op.locationId,
    locationName: locRows[0]?.name ?? "Location",
    operatorName: op.name,
    role: op.role,
    taxEnabled: !!billingRows[0]?.tax_enabled,
    gstEnabled: !!billingRows[0]?.gst_enabled,
    pricesIncludeTax: !!billingRows[0]?.prices_include_tax,
    taxRates,
    defaultTaxClassId: billingRows[0]?.default_tax_class_id ?? null,
    currency: "INR",
    canDiscount:
      settings["pos.ownerOnlyDiscounts"] === false ||
      posCan(op.role, "discount"),
    canOverridePrice:
      settings["pos.allowPriceOverride"] !== false &&
      (settings["pos.ownerOnlyDiscounts"] === false ||
        posCan(op.role, "price_override")),
  };
}

// ---- Catalog lookup (search + barcode) -------------------------------------

export interface PosCatalogItem {
  productId: string;
  variantId: string | null;
  name: string;
  variantName: string | null;
  sku: string | null;
  barcode: string | null;
  price: number;
  image: string | null;
  /** Live stock at THIS register's location (null = untracked). */
  stock: number | null;
  trackInventory: boolean;
  allowBackorder: boolean;
  /** The product's tax class, resolved to a RATE on the client via
   *  RegisterConfig.taxRates. Carried so the sell screen can quote the
   *  tax-inclusive total without a round trip (see lib/pos/totals.ts). */
  taxClassId: string | null;
}

// The sellable-catalog projection, shared by the interactive lookup and the
// full snapshot the client caches, so the two can never disagree about what a
// SKU costs or how much of it is on hand.
const CATALOG_COLS = {
  product_id: products.id,
  variant_id: productVariants.id,
  name: products.name,
  variant_name: productVariants.name,
  p_sku: products.sku,
  v_sku: productVariants.sku,
  p_barcode: products.barcode,
  v_barcode: productVariants.barcode,
  p_price: products.sellingPrice,
  v_price: productVariants.sellingPrice,
  v_special: productVariants.specialPrice,
  p_image: products.imageUrl,
  v_image: productVariants.imageUrl,
  p_track: products.trackInventory,
  v_track: productVariants.trackInventory,
  p_backorder: products.allowBackorder,
  v_backorder: productVariants.allowBackorder,
  p_stock: products.stock,
  v_stock: productVariants.stock,
  // Stock AT THIS REGISTER'S LOCATION. products.stock is the aggregate across
  // every location, so a two-location store would otherwise show (and let a
  // cashier ring up) stock sitting in the other shop.
  loc_stock: inventoryLevels.onHand,
  p_tax_class: products.taxClassId,
};

/** Mirrors CATALOG_COLS. Written out rather than inferred so a schema change
 *  that alters a column's nullability fails HERE, at the mapper, instead of
 *  silently producing a NaN price or a null name on the register. */
interface CatalogRow {
  product_id: string;
  variant_id: string | null;
  name: string;
  variant_name: string | null;
  p_sku: string | null;
  v_sku: string | null;
  p_barcode: string | null;
  v_barcode: string | null;
  p_price: number | null;
  v_price: number | null;
  v_special: number | null;
  p_image: string | null;
  v_image: string | null;
  p_track: boolean | null;
  v_track: boolean | null;
  p_backorder: boolean | null;
  v_backorder: boolean | null;
  p_stock: number | null;
  v_stock: number | null;
  loc_stock: number | null;
  p_tax_class: string | null;
}

function mapCatalogRow(r: CatalogRow): PosCatalogItem {
  const isVariant = !!r.variant_id;
  // Only variants carry a special price; a product's selling price is final.
  const special = isVariant ? r.v_special : null;
  const base = (isVariant ? r.v_price : r.p_price) ?? 0;
  return {
    productId: r.product_id,
    variantId: r.variant_id,
    name: r.name,
    variantName: r.variant_name,
    sku: (isVariant ? r.v_sku : r.p_sku) ?? null,
    barcode: (isVariant ? r.v_barcode : r.p_barcode) ?? null,
    price: special && special > 0 ? special : base,
    // A variant with no image of its own falls back to the product's.
    image: (isVariant ? r.v_image : r.p_image) ?? r.p_image ?? null,
    stock: r.loc_stock ?? (isVariant ? (r.v_stock ?? 0) : (r.p_stock ?? 0)),
    trackInventory: isVariant ? !!r.v_track : !!r.p_track,
    allowBackorder: isVariant ? !!r.v_backorder : !!r.p_backorder,
    taxClassId: r.p_tax_class ?? null,
  };
}

/** Join every sellable SKU to its on-hand level at the operator's location. */
const locationStockJoin = (locationId: string) =>
  and(
    eq(inventoryLevels.productId, products.id),
    eq(inventoryLevels.locationId, locationId),
    sql`${inventoryLevels.variantId} is not distinct from ${productVariants.id}`,
  );

/**
 * Search the catalog for the register: an exact barcode/SKU hit first (a scan),
 * otherwise a name match. Returns MULTIPLE rows when one barcode maps to
 * several variants so the register can disambiguate rather than guessing —
 * mislabelled supplier barcodes are common in retail.
 *
 * This is the FALLBACK path once the client-side catalog cache is warm
 * (lib/pos/use-catalog.ts) — it still runs for cache misses, which is what
 * lets a product added since the last sync be sold immediately.
 */
export async function lookupProducts(
  query: string,
  limit = 24,
): Promise<{ items: PosCatalogItem[]; error?: string }> {
  const op = await resolvePosOperator();
  if (!op) return { items: [], error: "Not signed in." };
  if (!posCan(op.role, "sell")) return { items: [], error: "Not allowed." };

  const q = typeof query === "string" ? query.trim().slice(0, 100) : "";
  const safeLimit = Math.min(Math.max(Math.trunc(limit) || 24, 1), 100);

  try {
    const rows = await withService(async (db) => {
      const pattern = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
      // One query over the variant-aware catalog: every sellable SKU is either
      // a variant row or a variant-less product row.
      return db
        .select(CATALOG_COLS)
        .from(products)
        .leftJoin(productVariants, eq(productVariants.productId, products.id))
        .leftJoin(inventoryLevels, locationStockJoin(op.locationId))
        .where(
          and(
            eq(products.storeId, op.storeId),
            eq(products.status, "published"),
            q
              ? or(
                  eq(products.barcode, q),
                  eq(productVariants.barcode, q),
                  eq(products.sku, q),
                  eq(productVariants.sku, q),
                  ilike(products.name, pattern),
                )
              : undefined,
          ),
        )
        .limit(safeLimit);
    });

    const items: PosCatalogItem[] = rows.map(mapCatalogRow);

    // An exact barcode/SKU scan should win over fuzzy name matches.
    if (q) {
      const exact = items.filter((i) => i.barcode === q || i.sku === q);
      if (exact.length > 0) return { items: exact };
    }
    return { items };
  } catch (err) {
    return { items: [], error: dbErrorMessage(err, "Couldn't load products.") };
  }
}

// ---- Catalog snapshot (client-side cache) ----------------------------------

/** Products per page. Paged so a large catalog streams in the background
 *  instead of arriving as one payload that stalls the register's first paint. */
const CATALOG_PAGE_PRODUCTS = 300;

export interface CatalogPage {
  items: PosCatalogItem[];
  /** Pass back to continue; null when the catalog is fully drained. */
  nextCursor: string | null;
  error?: string;
}

/**
 * A page of the FULL sellable catalog for the operator's location, for the
 * client-side cache (lib/pos/use-catalog.ts) that makes search and scan
 * resolve locally with no network — docs/pos-plan.md §10.
 *
 * Paging is keyset over `products.id` (not OFFSET), so pages stay stable and
 * cheap while the catalog is being edited underneath the sync. Whole products
 * are fetched per page — the page size counts products, not joined rows, so a
 * product with 40 variants can never be split across a page boundary and lose
 * variants at the seam.
 */
export async function getCatalogSnapshot(
  cursor?: string | null,
): Promise<CatalogPage> {
  const op = await resolvePosOperator();
  if (!op) return { items: [], nextCursor: null, error: "Not signed in." };
  if (!posCan(op.role, "sell"))
    return { items: [], nextCursor: null, error: "Not allowed." };

  const after = typeof cursor === "string" && cursor ? cursor : null;

  try {
    const rows = await withService(async (db) => {
      // 1. The page of product ids...
      const page = await db
        .select({ id: products.id })
        .from(products)
        .where(
          and(
            eq(products.storeId, op.storeId),
            eq(products.status, "published"),
            after ? gt(products.id, after) : undefined,
          ),
        )
        .orderBy(products.id)
        .limit(CATALOG_PAGE_PRODUCTS);
      if (page.length === 0) return [];

      // 2. ...then every sellable SKU within it.
      return db
        .select(CATALOG_COLS)
        .from(products)
        .leftJoin(productVariants, eq(productVariants.productId, products.id))
        .leftJoin(inventoryLevels, locationStockJoin(op.locationId))
        .where(
          inArray(
            products.id,
            page.map((p) => p.id),
          ),
        )
        .orderBy(products.id);
    });

    const items = rows.map(mapCatalogRow);
    // A short page means the catalog is drained. Cursor is the last product id
    // of the page, which the ORDER BY guarantees is its maximum.
    const productIds = new Set(items.map((i) => i.productId));
    const nextCursor =
      productIds.size < CATALOG_PAGE_PRODUCTS
        ? null
        : (items[items.length - 1]?.productId ?? null);

    return { items, nextCursor };
  } catch (err) {
    return {
      items: [],
      nextCursor: null,
      error: dbErrorMessage(err, "Couldn't load the catalog."),
    };
  }
}

// ---- Customer attach -------------------------------------------------------

export interface PosCustomer {
  id: string;
  name: string;
  phone: string;
  email: string | null;
}

/**
 * Find an existing customer of THIS store to attach to a sale — by phone, name
 * or email. Store-scoped, so one store's register can never surface another
 * store's customer list.
 *
 * Only customers who already exist are searchable. The register deliberately
 * cannot CREATE one: `users.id` is the Firebase uid and `(phone, store_id)` is
 * unique, so a till-invented row would collide with — and break — that same
 * person's later online signup. Walk-in capture needs a claim/merge story and
 * belongs with the CRM phase (docs/pos-plan.md Phase 5+).
 */
export async function searchPosCustomers(
  query: string,
): Promise<{ customers: PosCustomer[]; error?: string }> {
  const op = await resolvePosOperator();
  if (!op) return { customers: [], error: "Not signed in." };
  if (!posCan(op.role, "sell")) return { customers: [], error: "Not allowed." };

  const q = typeof query === "string" ? query.trim().slice(0, 60) : "";
  // Two characters is the floor: a one-character search would stream a large
  // slice of the customer list to the till for nothing.
  if (q.length < 2) return { customers: [] };

  try {
    const pattern = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
    const rows = await withService((db) =>
      db
        .select({
          id: users.id,
          phone: users.phone,
          email: users.email,
          first_name: users.firstName,
          last_name: users.lastName,
        })
        .from(users)
        .where(
          and(
            eq(users.storeId, op.storeId),
            or(
              ilike(users.phone, pattern),
              ilike(users.firstName, pattern),
              ilike(users.lastName, pattern),
              ilike(users.email, pattern),
            ),
          ),
        )
        .limit(10),
    );

    return {
      customers: rows.map((r) => ({
        id: r.id,
        name:
          [r.first_name, r.last_name].filter(Boolean).join(" ").trim() ||
          r.phone,
        phone: r.phone,
        email: r.email,
      })),
    };
  } catch (err) {
    return {
      customers: [],
      error: dbErrorMessage(err, "Couldn't search customers."),
    };
  }
}

// ---- Manager approval ------------------------------------------------------

/**
 * Verify a manager's PIN for an override (discount over the cap, price
 * override) and mint a signed approval for THAT sale.
 *
 * The token — not a boolean — is what `placePosSale` accepts. Returning
 * `{approved: true}` and letting the client tell the sale so was the whole
 * gate: a cashier could call placePosSale directly with `managerApproved:
 * true` and never touch the keypad. See lib/pos/approval.ts for what the
 * token is bound to.
 *
 * No session is minted, so approving does not switch the operator.
 */
export async function verifyManagerPin(
  pin: string,
  sale: ApprovableSale,
): Promise<{ approved?: boolean; token?: string; error?: string }> {
  const op = await resolvePosOperator();
  if (!op) return { error: "Not signed in." };
  // Minting can't degrade the way verification does — say so plainly rather
  // than throwing a 500 at a cashier mid-sale.
  if (!posSessionConfigured()) return { error: POS_SECRET_MISSING_ERROR };

  const rl = await rateLimit(`pos-approve:${op.storeId}:${op.locationId}`, {
    max: 10,
    windowSeconds: 60,
  });
  if (!rl.allowed) return { error: "Too many attempts. Please wait." };
  if (typeof pin !== "string" || !/^\d{8}$/.test(pin)) {
    return { error: "Enter the manager's 8-digit PIN." };
  }

  try {
    const rows = await withService((db) =>
      db
        .select({ id: posStaff.id, pin_hash: posStaff.pinHash })
        .from(posStaff)
        .innerJoin(
          posStaffLocations,
          and(
            eq(posStaffLocations.staffId, posStaff.id),
            eq(posStaffLocations.locationId, op.locationId),
          ),
        )
        .where(
          and(
            eq(posStaff.storeId, op.storeId),
            eq(posStaff.role, "manager"),
            eq(posStaff.active, true),
            eq(posStaff.status, "active"),
          ),
        )
        .limit(50),
    );
    const approver = rows.find((r) => verifyPin(pin, r.pin_hash));
    if (!approver) return { error: "Incorrect manager PIN." };

    return {
      approved: true,
      token: signApprovalToken({
        storeId: op.storeId,
        locationId: op.locationId,
        operatorId: op.staffId,
        approverId: approver.id,
        // The cart as the client will submit it — the manager is approving
        // THIS sale, not this cashier for the next three minutes.
        fingerprint: saleFingerprint(sale ?? { lines: [] }),
      }),
    };
  } catch (err) {
    return { error: dbErrorMessage(err, "Couldn't verify.") };
  }
}

// ---- The sale --------------------------------------------------------------

interface PricedLine {
  product_id: string;
  variant_id: string | null;
  name: string;
  variant_name: string | null;
  hsn_code: string | null;
  unit_price: number;
  quantity: number;
  /** unit_price * qty, minus the line discount. */
  amount: number;
  line_discount: number;
  tax_rate: number;
  tax_class_name: string | null;
}

export async function placePosSale(
  lines: PosCartLine[],
  tenders: PosTender[],
  opts: {
    customerId?: string | null;
    customerGstin?: string | null;
    orderDiscount?: number;
    /** A manager's approval, as minted by `verifyManagerPin` for THIS cart.
     *  Never a boolean: a flag from the client is a flag the client can set. */
    approvalToken?: string | null;
    note?: string | null;
  } = {},
): Promise<PosSaleResult> {
  // 1. Operator — server-resolved, device-bound, DB-revalidated.
  const op = await resolvePosOperator();
  if (!op) return { error: "You're signed out. Please sign in again." };
  if (!posCan(op.role, "sell")) {
    return { error: "You don't have permission to sell." };
  }

  const rl = await rateLimit(`pos-sale:${op.staffId ?? op.storeId}`, {
    max: 120,
    windowSeconds: 60,
  });
  if (!rl.allowed) return { error: "Too many sales too quickly. Try again." };

  // 2. Shape validation before any DB work.
  if (!Array.isArray(lines) || lines.length === 0) {
    return { error: "The cart is empty." };
  }
  if (lines.length > MAX_LINE_ITEMS) return { error: "Too many items." };
  for (const l of lines) {
    if (typeof l?.productId !== "string" || !l.productId) {
      return { error: "The cart contains an invalid item." };
    }
    if (
      !Number.isInteger(l.quantity) ||
      l.quantity < 1 ||
      l.quantity > MAX_QTY_PER_LINE
    ) {
      return { error: "Invalid quantity." };
    }
  }
  const badTender = validateTenderShape(
    tenders,
    "Take a payment to complete the sale.",
  );
  if (badTender) return { error: badTender };

  // A GSTIN prints on the customer's invoice, so it is validated rather than
  // trusted: normalised, format-checked, and length-capped.
  let customerGstin: string | null = null;
  if (typeof opts.customerGstin === "string" && opts.customerGstin.trim()) {
    customerGstin = opts.customerGstin.trim().toUpperCase().slice(0, 15);
    if (!isValidGstinFormat(customerGstin)) {
      return { error: "That GSTIN doesn't look valid." };
    }
  }

  // The attached customer MUST belong to this store. Without this check the
  // client could name any customer id and file the sale against another
  // store's customer — who would then see a foreign order in their history
  // (customers hold RLS SELECT on their own orders).
  let customerId: string | null = null;
  if (typeof opts.customerId === "string" && opts.customerId.trim()) {
    const wanted = opts.customerId.trim();
    try {
      const owned = await withService((db) =>
        db
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.id, wanted), eq(users.storeId, op.storeId)))
          .limit(1),
      );
      if (owned.length === 0)
        return { error: "That customer isn't in this store." };
      customerId = owned[0].id;
    } catch (err) {
      return { error: dbErrorMessage(err, "Couldn't verify the customer.") };
    }
  }

  const settings = await getStoreSettings();
  const allowOverride = settings["pos.allowPriceOverride"] !== false;
  const requireApproval = settings["pos.requireManagerForDiscount"] === true;
  const maxDiscountPct = Number(settings["pos.maxDiscountPercent"]) || 10;
  // Default TRUE: discounting belongs to the owner unless a merchant hands it
  // out deliberately.
  const ownerOnlyDiscounts = settings["pos.ownerOnlyDiscounts"] !== false;
  const mayDiscount = posCan(op.role, "discount");

  // A manager's approval is a SIGNED grant for this exact cart at this exact
  // till, minted by verifyManagerPin. An unverifiable, stale, tampered or
  // absent token all land in the same place — unapproved — so a caller that
  // skips the PIN pad entirely gets nowhere.
  const managerApproved = !!verifyApprovalToken(opts.approvalToken, {
    storeId: op.storeId,
    locationId: op.locationId,
    operatorId: op.staffId,
    fingerprint: saleFingerprint({
      lines,
      orderDiscount: opts.orderDiscount,
    }),
  });

  // Which cash drawer this sale belongs to (Phase 3). Stamped on the order so
  // reconciliation never has to infer it from a timestamp. A store may require
  // an open shift before selling; that is OFF by default because turning it on
  // can stop a till, so it stays the merchant's decision.
  const shiftId = await currentShiftIdFor(op.locationId);
  if (!shiftId && settings["pos.requireOpenShift"] === true) {
    return { error: "Open a shift before selling." };
  }

  // 3. Re-read prices from the DB, store-scoped. The client's prices are only
  //    ever a display hint.
  const productIds = Array.from(new Set(lines.map((l) => l.productId)));
  const variantIds = Array.from(
    new Set(lines.map((l) => l.variantId).filter(Boolean)),
  ) as string[];

  let dbProducts: Array<{
    id: string;
    name: string;
    selling_price: number;
    tax_class_id: string | null;
    hsn_code: string | null;
  }>;
  let dbVariants: Array<{
    id: string;
    name: string;
    selling_price: number;
    special_price: number | null;
  }>;
  try {
    const res = await withService(async (db) => {
      const p = await db
        .select({
          id: products.id,
          name: products.name,
          selling_price: products.sellingPrice,
          tax_class_id: products.taxClassId,
          hsn_code: products.hsnCode,
        })
        .from(products)
        .where(
          and(
            inArray(products.id, productIds),
            eq(products.storeId, op.storeId),
          ),
        );
      const v = variantIds.length
        ? await db
            .select({
              id: productVariants.id,
              name: productVariants.name,
              selling_price: productVariants.sellingPrice,
              special_price: productVariants.specialPrice,
            })
            .from(productVariants)
            .where(
              and(
                inArray(productVariants.id, variantIds),
                eq(productVariants.storeId, op.storeId),
              ),
            )
        : [];
      return { p, v };
    });
    dbProducts = res.p;
    dbVariants = res.v;
  } catch (err) {
    return { error: dbErrorMessage(err, "Couldn't price the sale.") };
  }

  const pMap = new Map(dbProducts.map((p) => [p.id, p]));
  const vMap = new Map(dbVariants.map((v) => [v.id, v]));

  // 4. Tax config + GST place of supply (uncached — a sale must reflect the
  //    config at the moment it is rung, never a stale copy).
  let billing: ReturnType<typeof rowToBillingSettings>;
  let taxClassList: ReturnType<typeof rowToTaxClass>[];
  let gstEnabled = false;
  let supplierState: string | null = null;
  try {
    const cfg = await withService(async (db) => {
      const b = await db
        .select({
          ...BILLING_COLS,
          gst_enabled: storeBillingSettings.gstEnabled,
        })
        .from(storeBillingSettings)
        .where(eq(storeBillingSettings.storeId, op.storeId))
        .limit(1);
      const t = await db
        .select({
          id: taxClasses.id,
          name: taxClasses.name,
          rate: taxClasses.rate,
          sort_order: taxClasses.sortOrder,
        })
        .from(taxClasses)
        .where(eq(taxClasses.storeId, op.storeId));
      const loc = await db
        .select({ state_code: storeLocations.stateCode })
        .from(storeLocations)
        .where(eq(storeLocations.id, op.locationId))
        .limit(1);
      return { b: b[0] ?? null, t, loc: loc[0] ?? null };
    });
    billing = rowToBillingSettings(cfg.b as Record<string, unknown> | null);
    gstEnabled = !!(cfg.b as { gst_enabled?: boolean } | null)?.gst_enabled;
    taxClassList = cfg.t.map((r) =>
      rowToTaxClass(r as Record<string, unknown>),
    );
    supplierState = cfg.loc?.state_code ?? null;
  } catch (err) {
    return { error: dbErrorMessage(err, "Couldn't read tax settings.") };
  }
  const classById = new Map(taxClassList.map((c) => [c.id, c]));

  // 5. Price each line + validate discounts/overrides.
  const priced: PricedLine[] = [];
  let needsApproval = false;

  for (const l of lines) {
    const p = pMap.get(l.productId);
    if (!p) return { error: "A product in the cart is no longer available." };
    const v = l.variantId ? vMap.get(l.variantId) : null;
    if (l.variantId && !v) {
      return { error: "A variant in the cart is no longer available." };
    }

    const special = v ? v.special_price : null;
    const listed = v ? v.selling_price : p.selling_price;
    let unit = special && special > 0 ? special : listed;

    // A price override is an authorised deviation, never a client claim.
    if (
      l.priceOverride !== undefined &&
      l.priceOverride !== null &&
      Number.isFinite(l.priceOverride)
    ) {
      if (!allowOverride) return { error: "Price overrides are turned off." };
      if (l.priceOverride < 0) return { error: "Invalid price." };
      // ★ Repricing a line to ₹1 IS a discount, so it answers to the same rule
      // (`pos.ownerOnlyDiscounts`) and the same capability table. Without this,
      // the discount gate below would be decorative — a manager would simply
      // mark the price down instead.
      if (ownerOnlyDiscounts && !posCan(op.role, "price_override")) {
        return {
          error:
            "Only the owner can change a price on a sale. Ask them to ring it, or turn off owner-only discounts in POS settings.",
        };
      }
      // Legacy path (owner-only discounts switched off): a cashier needs a
      // manager's PIN, a manager and above don't. `discount_over_cap` is that
      // set, named — it used to be an inline `role === "cashier"`.
      if (!managerApproved && !posCan(op.role, "discount_over_cap")) {
        needsApproval = true;
      }
      unit = l.priceOverride;
    }

    const gross = unit * l.quantity;
    const lineDisc =
      Number.isFinite(l.lineDiscount) && (l.lineDiscount ?? 0) > 0
        ? Math.min(Math.round(l.lineDiscount!), gross)
        : 0;

    const cls = p.tax_class_id
      ? classById.get(p.tax_class_id)
      : billing.defaultTaxClassId
        ? classById.get(billing.defaultTaxClassId)
        : null;

    priced.push({
      product_id: l.productId,
      variant_id: l.variantId ?? null,
      name: p.name,
      variant_name: v?.name ?? null,
      hsn_code: p.hsn_code ?? null,
      unit_price: unit,
      quantity: l.quantity,
      amount: gross - lineDisc,
      line_discount: lineDisc,
      tax_rate: billing.taxEnabled ? (cls?.rate ?? 0) : 0,
      tax_class_name: cls?.name ?? null,
    });
  }

  // Totals come from the SHARED pure helper the sell screen also uses, so the
  // amount quoted to the customer and the amount charged cannot diverge.
  const totals = posTotals({
    lines: priced.map((l) => ({
      gross: l.unit_price * l.quantity,
      lineDiscount: l.line_discount,
      rate: l.tax_rate,
      label: l.tax_class_name ?? undefined,
    })),
    requestedOrderDiscount:
      Number.isFinite(opts.orderDiscount) && (opts.orderDiscount ?? 0) > 0
        ? Math.round(opts.orderDiscount!)
        : 0,
    pricesIncludeTax: billing.pricesIncludeTax,
    taxEnabled: billing.taxEnabled,
  });
  const { subtotal, discount } = totals;

  // ★ WHO MAY DISCOUNT AT ALL. Under `pos.ownerOnlyDiscounts` (the default) a
  // discount from staff is REFUSED, not queued for approval — a manager's PIN
  // must not open this door, because the manager is one of the people being
  // kept out of it. Returning `needsApproval` here would hand them the key.
  //
  // Both kinds count: an order discount and a per-line markdown are the same
  // act with different arithmetic, and allowing "Less ₹50" per line while
  // blocking "Discount ₹50" would be a rule in name only.
  if (discount > 0 && ownerOnlyDiscounts && !mayDiscount) {
    return {
      error:
        "Only the owner can apply a discount. Ask them to ring this sale, or turn off owner-only discounts in POS settings.",
    };
  }

  // The cap, for a merchant who has handed discounting to their staff. A
  // cashier needs a manager's PIN above it; `discount_over_cap` is what exempts
  // a manager, rather than an inline role check that could disagree with the
  // capability table.
  if (
    requireApproval &&
    subtotal > 0 &&
    discount > 0 &&
    !posCan(op.role, "discount_over_cap")
  ) {
    const pct = (discount / subtotal) * 100;
    if (pct > maxDiscountPct && !managerApproved) needsApproval = true;
  }
  if (needsApproval) {
    return {
      needsApproval: true,
      error: `A manager's PIN is needed to approve this (over ${maxDiscountPct}%).`,
    };
  }

  // 6. Tax + GST split.
  const tax = totals.tax;

  // A walk-in's place of supply is the selling location's state.
  const placeOfSupply = supplierState;
  const intra = isIntraState(supplierState, placeOfSupply);

  const total = totals.total;

  // 7. Tenders must cover the total. Change is derived server-side.
  const settled = settleTenders(tenders, total);
  if ("error" in settled) return { error: settled.error };
  const changeDue = settled.change;

  // 8. Allocate a per-location receipt number.
  let receiptNo: string | null = null;
  try {
    const res = await withService((db) =>
      db.execute(sql`select next_pos_receipt_no(${op.locationId}) as seq`),
    );
    const seq = Number((res.rows[0] as { seq?: number } | undefined)?.seq ?? 0);
    const prefixRows = await withService((db) =>
      db
        .select({ prefix: storeLocations.receiptPrefix })
        .from(storeLocations)
        .where(eq(storeLocations.id, op.locationId))
        .limit(1),
    );
    const prefix = prefixRows[0]?.prefix || "POS";
    receiptNo = `${prefix}-${String(seq).padStart(6, "0")}`;
  } catch (err) {
    // A receipt number is cosmetic — never lose a sale over it.
    console.error("next_pos_receipt_no:", errMsg(err));
  }

  // 9. Write: order → stock → items → payments, unwinding in reverse on failure.
  const orderId = crypto.randomUUID();
  let orderRef = "";
  try {
    const rows = await withService((db) =>
      db
        .insert(orders)
        // order_no / order_ref are filled by the BEFORE-INSERT trigger
        // (identifiers_04_triggers.sql), so the insert type is asserted past them.
        .values({
          id: orderId,
          storeId: op.storeId,
          customerId,
          status: "completed",
          paymentMethod: tenders.length === 1 ? tenders[0].method : "split",
          paymentStatus: "paid",
          shippingAddress: null,
          billingAddress: null,
          subtotal,
          tax,
          taxInclusive: billing.pricesIncludeTax,
          shipping: 0,
          discount,
          total,
          currency: "INR",
          notes: opts.note ?? null,
          stockStatus: "reserved",
          salesChannel: "pos",
          shiftId,
          locationId: op.locationId,
          cashierId: op.staffId,
          cashierName: op.name,
          receiptNo,
          supplierState,
          placeOfSupplyState: placeOfSupply,
          customerGstin,
        } as typeof orders.$inferInsert)
        .returning({ id: orders.id, order_ref: orders.orderRef }),
    );
    orderRef = (rows[0] as { order_ref?: string })?.order_ref ?? "";
  } catch (err) {
    console.error("placePosSale (order):", errMsg(err));
    return { error: "Couldn't record the sale. Please try again." };
  }

  const reserved: Array<{ p: string; v: string | null; q: number }> = [];
  const releaseStock = async () => {
    for (const r of reserved) {
      await withService((db) =>
        db.execute(
          sql`select release_stock_at(p_store => ${op.storeId}, p_location => ${op.locationId}, p_product => ${r.p}, p_variant => ${r.v}, p_qty => ${r.q}, p_order => ${orderId}, p_reason => ${"pos_sale_failed"})`,
        ),
      ).catch((e) => console.error("release_stock_at:", errMsg(e)));
    }
  };
  const deleteOrder = async () => {
    await withService((db) =>
      db.delete(orders).where(eq(orders.id, orderId)),
    ).catch((e) => console.error("pos order rollback:", errMsg(e)));
  };

  for (const l of priced) {
    let ok: boolean | undefined;
    try {
      const res = await withService((db) =>
        db.execute(
          sql`select reserve_stock_at(p_store => ${op.storeId}, p_location => ${op.locationId}, p_product => ${l.product_id}, p_variant => ${l.variant_id}, p_qty => ${l.quantity}, p_order => ${orderId}) as reserved`,
        ),
      );
      ok =
        (res.rows[0] as { reserved?: boolean } | undefined)?.reserved ?? false;
    } catch (err) {
      console.error("reserve_stock_at:", errMsg(err));
      ok = false;
    }
    if (!ok) {
      await releaseStock();
      await deleteOrder();
      const label = l.variant_name ? `${l.name} (${l.variant_name})` : l.name;
      return { error: `Not enough stock for ${label} at this location.` };
    }
    reserved.push({ p: l.product_id, v: l.variant_id, q: l.quantity });
  }

  try {
    await withService((db) =>
      db.insert(orderItems).values(
        priced.map((l, i) => {
          const lineTax = totals.taxLines[i]?.tax ?? 0;
          const g = splitGst(gstEnabled ? lineTax : 0, intra);
          return {
            orderId,
            productId: l.product_id,
            variantId: l.variant_id,
            name: l.name,
            variantName: l.variant_name,
            price: l.unit_price,
            quantity: l.quantity,
            total: l.amount,
            lineDiscount: l.line_discount,
            taxRate: l.tax_rate,
            taxAmount: lineTax,
            taxClassName: l.tax_class_name,
            taxCgst: g.cgst,
            taxSgst: g.sgst,
            taxIgst: g.igst,
            hsnCode: l.hsn_code,
          };
        }),
      ),
    );
  } catch (err) {
    console.error("placePosSale (items):", errMsg(err));
    await releaseStock();
    await deleteOrder();
    return { error: "Couldn't save the sale's items. Please try again." };
  }

  try {
    await withService((db) =>
      db.insert(orderPayments).values(
        tenders.map((t) => ({
          orderId,
          storeId: op.storeId,
          method: t.method,
          amount: t.amount,
          tendered: t.method === "cash" ? (t.tendered ?? t.amount) : null,
          changeDue: t.method === "cash" ? changeDue : null,
          reference: t.reference?.slice(0, 120) ?? null,
        })),
      ),
    );
  } catch (err) {
    // The sale IS recorded and stock is taken; losing the tender breakdown must
    // not void a completed transaction. Log loudly for reconciliation.
    console.error("placePosSale (payments):", errMsg(err));
  }

  // An in-store sale is a sale. Without this it existed only in the orders
  // table: absent from /dashboard/logs, absent from the team's "new order"
  // alert, and — because reserve_stock_at bypassed the checkout path — it could
  // empty a shelf without ever tripping the low-stock warning. The register was
  // the one channel the store couldn't see happening.
  emitEvent({
    type: "order.placed",
    storeId: op.storeId,
    // The register this was rung at, so a store can route in-store alerts to
    // the staff who actually work there (routing scope "event_location").
    locationId: op.locationId,
    actor: { type: "admin", id: op.staffId ?? null, label: op.name },
    subject: { type: "order", id: orderId, label: orderRef },
    // Null for a walk-in, which emitEvent reads as "no customer audience" —
    // correct, since a POS shopper leaves with a printed receipt in hand.
    customerId,
    payload: {
      total,
      currency: "INR",
      items: summariseItems(
        priced.map((l) => ({
          name: l.name,
          variantName: l.variant_name,
          quantity: l.quantity,
        })),
      ),
      paymentMethod: "pos",
      channel: "In-store",
    },
    // Same order summary the thermal receipt prints, so an attached customer's
    // emailed copy and the paper in their hand agree line for line.
    email: {
      currency: "INR",
      items: priced.map((l) => ({
        name: l.name,
        variant: l.variant_name,
        quantity: l.quantity,
        total: l.amount,
      })),
      subtotal: totals.subtotal,
      discount: totals.discount,
      tax: totals.tax,
      total: totals.total,
    },
  });

  reportStockChanges(
    op.storeId,
    lines.map((l) => ({
      productId: l.productId,
      variantId: l.variantId,
      delta: -l.quantity,
    })),
  );

  revalidatePath("/dashboard/orders");
  return {
    success: true,
    orderId,
    orderRef,
    receiptNo: receiptNo ?? orderRef,
    changeDue,
  };
}

// ---- Receipt ---------------------------------------------------------------

/**
 * Load a completed sale as a printable receipt. Operator-gated and scoped to
 * the operator's store AND location, so a register can only reprint sales rung
 * at its own counter. Everything is read from the order's snapshot.
 */
export async function getPosReceipt(
  orderId: string,
): Promise<{ receipt?: ReceiptModel; error?: string }> {
  const op = await resolvePosOperator();
  if (!op) return { error: "Not signed in." };
  if (typeof orderId !== "string" || !orderId)
    return { error: "Invalid sale." };

  try {
    const data = await withService(async (db) => {
      const orderRows = await db
        .select({
          receipt_no: orders.receiptNo,
          order_ref: orders.orderRef,
          created_at: orders.createdAt,
          cashier_name: orders.cashierName,
          subtotal: orders.subtotal,
          discount: orders.discount,
          tax: orders.tax,
          tax_inclusive: orders.taxInclusive,
          total: orders.total,
          customer_gstin: orders.customerGstin,
          supplier_state: orders.supplierState,
          place_of_supply_state: orders.placeOfSupplyState,
          location_id: orders.locationId,
        })
        .from(orders)
        .where(
          and(
            eq(orders.id, orderId),
            eq(orders.storeId, op.storeId),
            eq(orders.locationId, op.locationId),
          ),
        )
        .limit(1);
      const order = orderRows[0];
      if (!order) return null;

      const items = await db
        .select({
          name: orderItems.name,
          variant_name: orderItems.variantName,
          hsn_code: orderItems.hsnCode,
          quantity: orderItems.quantity,
          price: orderItems.price,
          total: orderItems.total,
          line_discount: orderItems.lineDiscount,
          tax_rate: orderItems.taxRate,
          tax_class_name: orderItems.taxClassName,
          tax_amount: orderItems.taxAmount,
          tax_cgst: orderItems.taxCgst,
          tax_sgst: orderItems.taxSgst,
          tax_igst: orderItems.taxIgst,
        })
        .from(orderItems)
        .where(eq(orderItems.orderId, orderId));

      const payments = await db
        .select({
          method: orderPayments.method,
          amount: orderPayments.amount,
          tendered: orderPayments.tendered,
          change_due: orderPayments.changeDue,
          reference: orderPayments.reference,
        })
        .from(orderPayments)
        .where(eq(orderPayments.orderId, orderId));

      const loc = await db
        .select({
          name: storeLocations.name,
          address: storeLocations.address,
          gstin: storeLocations.gstin,
        })
        .from(storeLocations)
        .where(eq(storeLocations.id, op.locationId))
        .limit(1);

      const billing = await db
        .select({
          gst_enabled: storeBillingSettings.gstEnabled,
          legal_name: storeBillingSettings.legalName,
          business_name: storeBillingSettings.businessName,
          contact_phone: storeBillingSettings.contactPhone,
          footer_note: storeBillingSettings.footerNote,
        })
        .from(storeBillingSettings)
        .where(eq(storeBillingSettings.storeId, op.storeId))
        .limit(1);

      return {
        order,
        items,
        payments,
        loc: loc[0] ?? null,
        b: billing[0] ?? null,
      };
    });

    if (!data) return { error: "That sale isn't available on this register." };

    const brand = await getStoreBrandById(op.storeId).catch(() => null);
    return {
      receipt: buildReceiptModel({
        store: {
          name: data.b?.business_name || brand?.name || "Store",
          legalName: data.b?.legal_name ?? null,
          phone: data.b?.contact_phone ?? null,
        },
        location: data.loc,
        order: data.order,
        items: data.items,
        payments: data.payments,
        gstEnabled: !!data.b?.gst_enabled,
        footerNote: data.b?.footer_note ?? null,
      }),
    };
  } catch (err) {
    return { error: dbErrorMessage(err, "Couldn't load the receipt.") };
  }
}

// NOTE: do not re-export types from this file. In a "use server" module every
// export becomes a server-action entry, so `export type { … }` fails the
// production build ("Export X doesn't exist in target module") even though dev
// and unit tests pass. Import PosOperator from @/lib/pos/operator instead.

// ---- Sale lookup (reprint / "what did I just ring?") ----------------------

export interface PosSaleRow {
  id: string;
  receiptNo: string;
  orderRef: string;
  total: number;
  createdAt: string;
  cashierName: string | null;
  customerName: string | null;
  itemCount: number;
  paymentMethod: string;
  refunded: boolean;
}

/**
 * Recent till sales at THIS shop, newest first.
 *
 * Why a cashier and not just a manager: the commonest reason to look a sale up
 * is a customer standing at the counter asking for their bill again. Making
 * that a manager's job stops the queue.
 *
 * Scoped to the operator's own location, never a location from the client —
 * and to sales with a `receipt_no`, which is what distinguishes a till sale
 * from an online order that merely routed to this shop. Someone else's online
 * order is not a receipt this till ever printed.
 */
export async function listPosSales(
  query?: string,
): Promise<{ sales: PosSaleRow[]; error?: string }> {
  const op = await resolvePosOperator();
  if (!op) return { sales: [], error: "Not signed in." };
  if (!posCan(op.role, "sell")) return { sales: [], error: "Not allowed." };

  const q = (query ?? "").trim().slice(0, 60);
  const like = likePattern(q);

  try {
    const rows = await withService((db) =>
      db
        .select({
          id: orders.id,
          receipt_no: orders.receiptNo,
          order_ref: orders.orderRef,
          total: orders.total,
          created_at: orders.createdAt,
          cashier_name: orders.cashierName,
          shipping_address: orders.shippingAddress,
          payment_method: orders.paymentMethod,
          status: orders.status,
        })
        .from(orders)
        .where(
          and(
            eq(orders.storeId, op.storeId),
            eq(orders.locationId, op.locationId),
            isNotNull(orders.receiptNo),
            q
              ? or(
                  ilike(orders.receiptNo, like),
                  ilike(orders.orderRef, like),
                  sql`${orders.shippingAddress}::text ilike ${like}`,
                )
              : undefined,
          ),
        )
        .orderBy(desc(orders.createdAt))
        .limit(60),
    );

    // Item counts as their own grouped query, NOT a correlated subquery in the
    // select. Interpolating columns into sql`` renders them UNQUALIFIED —
    // `where "order_id" = "id"` — and inside the subquery both names resolve to
    // order_items, so it silently counts zero for every row. Two plain queries
    // can't be wrong that way.
    const counts = new Map<string, number>();
    if (rows.length > 0) {
      const countRows = await withService((db) =>
        db
          .select({
            order_id: orderItems.orderId,
            n: count(),
          })
          .from(orderItems)
          .where(
            inArray(
              orderItems.orderId,
              rows.map((r) => r.id),
            ),
          )
          .groupBy(orderItems.orderId),
      );
      for (const c of countRows) counts.set(c.order_id, Number(c.n) || 0);
    }

    return {
      sales: rows.map((r) => {
        const addr = (r.shipping_address ?? {}) as Record<string, unknown>;
        const name =
          [addr.firstName, addr.lastName].filter(Boolean).join(" ").trim() ||
          null;
        return {
          id: r.id,
          receiptNo: r.receipt_no ?? "",
          orderRef: r.order_ref ?? "",
          total: Number(r.total) || 0,
          createdAt: r.created_at,
          cashierName: personLabel(r.cashier_name),
          customerName: name,
          itemCount: counts.get(r.id) ?? 0,
          paymentMethod: r.payment_method ?? "",
          refunded: r.status === "cancelled" || r.status === "refunded",
        };
      }),
    };
  } catch (err) {
    return { sales: [], error: dbErrorMessage(err, "Couldn't load sales.") };
  }
}
