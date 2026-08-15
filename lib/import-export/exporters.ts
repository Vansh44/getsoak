import "server-only";

// Where export rows come from.
//
// Every exporter is an ASYNC GENERATOR that yields one record at a time, KEYED
// BY FIELD NAME, and pages the database with a KEYSET cursor. Three choices,
// each about a specific failure:
//
//  • Generating rows lets the route stream them straight to the browser, so
//    peak memory is one page rather than the whole file, and the download
//    starts immediately instead of after a 30-second silence that looks like a
//    hang and gets cancelled.
//  • Keyset paging (`id > cursor`) keeps every page fast and, unlike OFFSET,
//    cannot skip or repeat a row when the catalogue is edited mid-export —
//    which for a long export is not a rare race, it is Tuesday. Same reason
//    the POS catalogue snapshot pages this way.
//  • Field-keyed records, laid out by `toCells`, make column drift impossible:
//    see the note on that function for what a positional array costs.

import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import type { LocationScope } from "@/lib/locations/scope";
import { withUser, type UserIdentity } from "@/lib/db/client";
import {
  categories,
  coupons,
  inventoryLevels,
  orderItems,
  orders,
  productVariants,
  products,
  storeLocations,
  taxClasses,
  users,
} from "@/drizzle/schema";
import type { ResourceId } from "./types";

const PAGE = 500;

/** A row as the exporter sees it: registry field name → value. */
export type ExportRecord = Record<string, unknown>;

export interface ExportContext {
  storeId: string;
  admin: UserIdentity;
  /** Resource-specific narrowing from the UI (a status filter, a location). */
  filters?: Record<string, string | undefined>;
  /**
   * ★★ THE VIEWER'S LOCATION SCOPE — `null` for unrestricted, ids otherwise.
   *
   * Resolved ONCE by the route (the gate) rather than per exporter, and applied
   * to every resource that has a location. Without it an export was a scope
   * BYPASS: the orders LIST filtered to a restricted admin's shops while
   * Export handed them every location's rows — customer names, addresses and
   * phones included. The narrower path was the visible one, which is the worst
   * way round.
   *
   * ⚠ NOT the same as `filters.location`, which is what the merchant PICKED.
   * That one narrows; this one bounds. A picked location outside the scope must
   * still return nothing.
   */
  locationScope?: LocationScope;
}

/**
 * The location predicate for one column, or null when the viewer is
 * unrestricted and there is nothing to add.
 *
 * ⚠ An EMPTY scope means "assigned to nothing that still exists" and must match
 * NOTHING — `inArray(col, [])` is the correct expression of that, and is why
 * this returns a predicate rather than skipping when the list is empty.
 */
function scopeCondition(
  scope: LocationScope | undefined,
  column: Parameters<typeof inArray>[0],
) {
  return scope === null || scope === undefined ? null : inArray(column, scope);
}

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

// ---------------------------------------------------------------------------
// Products — one row per variant, Shopify's shape
// ---------------------------------------------------------------------------

async function* exportProducts(
  ctx: ExportContext,
): AsyncGenerator<ExportRecord> {
  let cursor = NIL_UUID;

  for (;;) {
    const conds = [eq(products.storeId, ctx.storeId), gt(products.id, cursor)];
    const status = ctx.filters?.status;
    if (status === "draft" || status === "published")
      conds.push(eq(products.status, status));

    const page = await withUser(ctx.admin, (db) =>
      db
        .select({
          id: products.id,
          slug: products.slug,
          name: products.name,
          description: products.description,
          categoryName: categories.name,
          taxClassName: taxClasses.name,
          status: products.status,
          featured: products.featured,
          basePrice: products.basePrice,
          sellingPrice: products.sellingPrice,
          imageUrl: products.imageUrl,
          images: products.images,
          seoTitle: products.seoTitle,
          seoDescription: products.seoDescription,
          cardColor: products.cardColor,
          sortOrder: products.sortOrder,
          trackInventory: products.trackInventory,
          stock: products.stock,
          lowStockThreshold: products.lowStockThreshold,
          allowBackorder: products.allowBackorder,
          barcode: products.barcode,
          hsnCode: products.hsnCode,
          returnable: products.returnable,
          returnWindowDays: products.returnWindowDays,
          sku: products.sku,
        })
        .from(products)
        .leftJoin(categories, eq(categories.id, products.categoryId))
        .leftJoin(taxClasses, eq(taxClasses.id, products.taxClassId))
        .where(and(...conds))
        .orderBy(asc(products.id))
        .limit(PAGE),
    );

    if (page.length === 0) return;
    cursor = page[page.length - 1].id;

    // Variants for the whole page in one query — per-product would be 500
    // round trips per page.
    const variantRows = await withUser(ctx.admin, (db) =>
      db
        .select({
          productId: productVariants.productId,
          name: productVariants.name,
          basePrice: productVariants.basePrice,
          sellingPrice: productVariants.sellingPrice,
          specialPrice: productVariants.specialPrice,
          stock: productVariants.stock,
          barcode: productVariants.barcode,
          imageUrl: productVariants.imageUrl,
          sku: productVariants.sku,
        })
        .from(productVariants)
        .where(
          inArray(
            productVariants.productId,
            page.map((p) => p.id),
          ),
        )
        .orderBy(
          asc(productVariants.productId),
          asc(productVariants.sortOrder),
        ),
    );

    const byProduct = new Map<string, typeof variantRows>();
    for (const v of variantRows) {
      const list = byProduct.get(v.productId);
      if (list) list.push(v);
      else byProduct.set(v.productId, [v]);
    }

    for (const p of page) {
      const productRecord: ExportRecord = {
        handle: p.slug,
        name: p.name,
        description: p.description,
        category: p.categoryName,
        taxClass: p.taxClassName,
        status: p.status,
        featured: p.featured,
        basePrice: p.basePrice,
        sellingPrice: p.sellingPrice,
        imageUrl: p.imageUrl,
        images: (p.images ?? []).filter(Boolean).join("|") || null,
        seoTitle: p.seoTitle,
        seoDescription: p.seoDescription,
        cardColor: p.cardColor,
        sortOrder: p.sortOrder,
        trackInventory: p.trackInventory,
        stock: p.stock,
        lowStockThreshold: p.lowStockThreshold,
        allowBackorder: p.allowBackorder,
        barcode: p.barcode,
        hsnCode: p.hsnCode,
        returnable: p.returnable,
        returnWindowDays: p.returnWindowDays,
        sku: p.sku,
      };

      const variants = byProduct.get(p.id);
      if (!variants || variants.length === 0) {
        yield productRecord;
        continue;
      }

      for (let i = 0; i < variants.length; i++) {
        const v = variants[i];
        // The first row carries the product; later rows repeat only the
        // handle, so re-importing the file cannot resurrect a stale product
        // field from a variant row. It also makes the file readable.
        const lead: ExportRecord = i === 0 ? productRecord : { handle: p.slug };
        yield {
          ...lead,
          variantName: v.name,
          variantBasePrice: v.basePrice,
          variantSellingPrice: v.sellingPrice,
          variantSpecialPrice: v.specialPrice,
          variantStock: v.stock,
          variantBarcode: v.barcode,
          variantImageUrl: v.imageUrl,
          variantSku: v.sku,
        };
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

async function* exportCategories(
  ctx: ExportContext,
): AsyncGenerator<ExportRecord> {
  let cursor = NIL_UUID;

  for (;;) {
    const page = await withUser(ctx.admin, (db) =>
      db
        .select({
          id: categories.id,
          slug: categories.slug,
          name: categories.name,
          description: categories.description,
          imageUrl: categories.imageUrl,
          sortOrder: categories.sortOrder,
          status: categories.status,
        })
        .from(categories)
        .where(
          and(eq(categories.storeId, ctx.storeId), gt(categories.id, cursor)),
        )
        .orderBy(asc(categories.id))
        .limit(PAGE),
    );

    if (page.length === 0) return;
    cursor = page[page.length - 1].id;

    for (const c of page) {
      yield {
        handle: c.slug,
        name: c.name,
        description: c.description,
        imageUrl: c.imageUrl,
        sortOrder: c.sortOrder,
        status: c.status,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Inventory — one row per SKU per location
// ---------------------------------------------------------------------------

async function* exportInventory(
  ctx: ExportContext,
): AsyncGenerator<ExportRecord> {
  let cursor = NIL_UUID;
  const locationFilter = ctx.filters?.location;

  for (;;) {
    const conds = [
      eq(inventoryLevels.storeId, ctx.storeId),
      gt(inventoryLevels.id, cursor),
    ];
    if (locationFilter && locationFilter !== "all")
      conds.push(eq(inventoryLevels.locationId, locationFilter));
    const scopedInv = scopeCondition(
      ctx.locationScope,
      inventoryLevels.locationId,
    );
    if (scopedInv) conds.push(scopedInv);

    const page = await withUser(ctx.admin, (db) =>
      db
        .select({
          id: inventoryLevels.id,
          onHand: inventoryLevels.onHand,
          reserved: inventoryLevels.reserved,
          locationName: storeLocations.name,
          productName: products.name,
          productSku: products.sku,
          variantName: productVariants.name,
          variantSku: productVariants.sku,
        })
        .from(inventoryLevels)
        .innerJoin(
          storeLocations,
          eq(storeLocations.id, inventoryLevels.locationId),
        )
        .innerJoin(products, eq(products.id, inventoryLevels.productId))
        .leftJoin(
          productVariants,
          eq(productVariants.id, inventoryLevels.variantId),
        )
        .where(and(...conds))
        .orderBy(asc(inventoryLevels.id))
        .limit(PAGE),
    );

    if (page.length === 0) return;
    cursor = page[page.length - 1].id;

    for (const row of page) {
      yield {
        // The variant's SKU when the level is a variant's, else the product's.
        // This is the column the import matches on, so it has to identify
        // exactly the thing the row counts.
        sku: row.variantSku ?? row.productSku,
        productName: row.productName,
        variantName: row.variantName,
        location: row.locationName,
        onHand: row.onHand,
        reserved: row.reserved,
        available: row.onHand - row.reserved,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Orders — one row per line item, order fields repeated
// ---------------------------------------------------------------------------

function addr(value: unknown, ...keys: string[]): string | null {
  if (!value || typeof value !== "object") return null;
  for (const key of keys) {
    const v = (value as Record<string, unknown>)[key];
    if (typeof v === "string" || typeof v === "number") return String(v);
  }
  return null;
}

async function* exportOrders(ctx: ExportContext): AsyncGenerator<ExportRecord> {
  let cursor = NIL_UUID;

  for (;;) {
    const conds = [eq(orders.storeId, ctx.storeId), gt(orders.id, cursor)];
    const status = ctx.filters?.status;
    if (status && status !== "all") conds.push(eq(orders.status, status));
    // ★ Bounds what the merchant picked, rather than replacing it.
    const scoped = scopeCondition(ctx.locationScope, orders.locationId);
    if (scoped) conds.push(scoped);

    const page = await withUser(ctx.admin, (db) =>
      db
        .select({
          id: orders.id,
          orderRef: orders.orderRef,
          createdAt: orders.createdAt,
          status: orders.status,
          paymentStatus: orders.paymentStatus,
          paymentMethod: orders.paymentMethod,
          salesChannel: orders.salesChannel,
          fulfilmentType: orders.fulfilmentType,
          locationName: storeLocations.name,
          shippingAddress: orders.shippingAddress,
          subtotal: orders.subtotal,
          discount: orders.discount,
          tax: orders.tax,
          shipping: orders.shipping,
          storeCreditUsed: orders.storeCreditUsed,
          total: orders.total,
          currency: orders.currency,
          couponCode: orders.appliedCouponCode,
          notes: orders.notes,
          customerFirst: users.firstName,
          customerLast: users.lastName,
          customerEmail: users.email,
          customerPhone: users.phone,
        })
        .from(orders)
        .leftJoin(users, eq(users.id, orders.customerId))
        .leftJoin(storeLocations, eq(storeLocations.id, orders.locationId))
        .where(and(...conds))
        .orderBy(asc(orders.id))
        .limit(PAGE),
    );

    if (page.length === 0) return;
    cursor = page[page.length - 1].id;

    const items = await withUser(ctx.admin, (db) =>
      db
        .select({
          orderId: orderItems.orderId,
          name: orderItems.name,
          variantName: orderItems.variantName,
          quantity: orderItems.quantity,
          price: orderItems.price,
          lineDiscount: orderItems.lineDiscount,
          taxAmount: orderItems.taxAmount,
          total: orderItems.total,
          createdAt: orderItems.createdAt,
          productSku: products.sku,
          variantSku: productVariants.sku,
        })
        .from(orderItems)
        .leftJoin(products, eq(products.id, orderItems.productId))
        .leftJoin(productVariants, eq(productVariants.id, orderItems.variantId))
        .where(
          inArray(
            orderItems.orderId,
            page.map((o) => o.id),
          ),
        )
        .orderBy(asc(orderItems.orderId), asc(orderItems.createdAt)),
    );

    const byOrder = new Map<string, typeof items>();
    for (const item of items) {
      const list = byOrder.get(item.orderId);
      if (list) list.push(item);
      else byOrder.set(item.orderId, [item]);
    }

    for (const o of page) {
      const ship = o.shippingAddress;
      const orderRecord: ExportRecord = {
        orderRef: o.orderRef,
        createdAt: o.createdAt,
        status: o.status,
        paymentStatus: o.paymentStatus,
        paymentMethod: o.paymentMethod,
        salesChannel: o.salesChannel,
        fulfilmentType: o.fulfilmentType,
        locationName: o.locationName,
        customerName:
          [o.customerFirst, o.customerLast].filter(Boolean).join(" ") || null,
        customerEmail: o.customerEmail,
        customerPhone: o.customerPhone,
        shipName: addr(ship, "fullName", "name"),
        shipLine1: addr(ship, "addressLine1", "line1"),
        shipLine2: addr(ship, "addressLine2", "line2"),
        shipCity: addr(ship, "city"),
        shipState: addr(ship, "state"),
        shipPostcode: addr(ship, "postalCode", "pincode", "postcode"),
        shipCountry: addr(ship, "country"),
        subtotal: o.subtotal,
        discount: o.discount,
        tax: o.tax,
        shipping: o.shipping,
        storeCreditUsed: o.storeCreditUsed,
        total: o.total,
        currency: o.currency,
        couponCode: o.couponCode,
        notes: o.notes,
      };

      const lines = byOrder.get(o.id);
      // An order with no items still exports: a missing row would silently
      // change what the file totals to.
      if (!lines || lines.length === 0) {
        yield orderRecord;
        continue;
      }

      for (const line of lines) {
        yield {
          ...orderRecord,
          lineProduct: line.name,
          lineVariant: line.variantName,
          lineSku: line.variantSku ?? line.productSku,
          lineQty: line.quantity,
          linePrice: line.price,
          lineDiscount: line.lineDiscount,
          lineTax: line.taxAmount,
          lineTotal: line.total,
        };
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Coupons
// ---------------------------------------------------------------------------

async function* exportCoupons(
  ctx: ExportContext,
): AsyncGenerator<ExportRecord> {
  let cursor = NIL_UUID;

  for (;;) {
    const page = await withUser(ctx.admin, (db) =>
      db
        .select({
          id: coupons.id,
          code: coupons.code,
          description: coupons.description,
          discountType: coupons.discountType,
          discountValue: coupons.discountValue,
          minOrderAmount: coupons.minOrderAmount,
          maxUses: coupons.maxUses,
          status: coupons.status,
          validFrom: coupons.validFrom,
          validUntil: coupons.validUntil,
          showOnStorefront: coupons.showOnStorefront,
          usedCount: coupons.usedCount,
        })
        .from(coupons)
        .where(and(eq(coupons.storeId, ctx.storeId), gt(coupons.id, cursor)))
        .orderBy(asc(coupons.id))
        .limit(PAGE),
    );

    if (page.length === 0) return;
    cursor = page[page.length - 1].id;

    for (const c of page) {
      yield {
        code: c.code,
        description: c.description,
        discountType: c.discountType,
        discountValue: c.discountValue,
        minOrderAmount: c.minOrderAmount,
        maxUses: c.maxUses,
        status: c.status,
        validFrom: c.validFrom,
        validUntil: c.validUntil,
        showOnStorefront: c.showOnStorefront,
        usedCount: c.usedCount,
      };
    }
  }
}

// ---------------------------------------------------------------------------

const EXPORTERS: Record<
  ResourceId,
  (ctx: ExportContext) => AsyncGenerator<ExportRecord>
> = {
  products: exportProducts,
  categories: exportCategories,
  inventory: exportInventory,
  orders: exportOrders,
  coupons: exportCoupons,
};

export function exportRows(
  resource: ResourceId,
  ctx: ExportContext,
): AsyncGenerator<ExportRecord> {
  return EXPORTERS[resource](ctx);
}

/**
 * Every field name an exporter can emit for a resource.
 *
 * Exists purely so `import-export.test.ts` can assert that each one is a real
 * registry field — the CI guard replacing the positional discipline that
 * yielding arrays used to require. A typo'd key here exports as an empty
 * column, which is exactly the kind of quiet wrongness nobody notices.
 */
export const EXPORT_FIELDS: Record<ResourceId, readonly string[]> = {
  products: [
    "handle",
    "name",
    "description",
    "category",
    "taxClass",
    "status",
    "featured",
    "basePrice",
    "sellingPrice",
    "imageUrl",
    "images",
    "seoTitle",
    "seoDescription",
    "cardColor",
    "sortOrder",
    "trackInventory",
    "stock",
    "lowStockThreshold",
    "allowBackorder",
    "barcode",
    "hsnCode",
    "returnable",
    "returnWindowDays",
    "sku",
    "variantName",
    "variantBasePrice",
    "variantSellingPrice",
    "variantSpecialPrice",
    "variantStock",
    "variantBarcode",
    "variantImageUrl",
    "variantSku",
  ],
  categories: [
    "handle",
    "name",
    "description",
    "imageUrl",
    "sortOrder",
    "status",
  ],
  inventory: [
    "sku",
    "productName",
    "variantName",
    "location",
    "onHand",
    "reserved",
    "available",
  ],
  orders: [
    "orderRef",
    "createdAt",
    "status",
    "paymentStatus",
    "paymentMethod",
    "salesChannel",
    "fulfilmentType",
    "locationName",
    "customerName",
    "customerEmail",
    "customerPhone",
    "shipName",
    "shipLine1",
    "shipLine2",
    "shipCity",
    "shipState",
    "shipPostcode",
    "shipCountry",
    "lineProduct",
    "lineVariant",
    "lineSku",
    "lineQty",
    "linePrice",
    "lineDiscount",
    "lineTax",
    "lineTotal",
    "subtotal",
    "discount",
    "tax",
    "shipping",
    "storeCreditUsed",
    "total",
    "currency",
    "couponCode",
    "notes",
  ],
  coupons: [
    "code",
    "description",
    "discountType",
    "discountValue",
    "minOrderAmount",
    "maxUses",
    "status",
    "validFrom",
    "validUntil",
    "showOnStorefront",
    "usedCount",
  ],
};

/** Rows this store would export — used to size the job before it starts. */
export async function countExportRows(
  resource: ResourceId,
  ctx: ExportContext,
): Promise<number> {
  const table =
    resource === "products"
      ? products
      : resource === "categories"
        ? categories
        : resource === "inventory"
          ? inventoryLevels
          : resource === "orders"
            ? orders
            : coupons;

  const rows = await withUser(ctx.admin, (db) =>
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(table)
      .where(eq(table.storeId, ctx.storeId)),
  );
  return rows[0]?.n ?? 0;
}
