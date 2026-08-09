// THE REGISTRY — every resource that can be moved in or out as CSV, and every
// column it carries.
//
// A registry rather than five hand-written import screens, for the reason
// `lib/settings/registry.ts` and `lib/notifications/events.ts` are registries:
// the alternative is the same five concerns (header matching, coercion,
// validation, error reporting, the template file) reimplemented per resource,
// diverging immediately, and a sixth resource costing a week. Adding one here
// is a `ResourceDef` plus one importer function.
//
// PURE — no server imports. The browser parses and validates the merchant's
// file against these exact definitions to build the preview, and the server
// re-validates against the same ones. Two copies would let the preview promise
// something the import then refuses.

import type { ColumnDef, ResourceDef, ResourceId } from "./types";

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------
//
// One row per VARIANT, grouped by Handle — Shopify's shape, because that is
// the file merchants already have. The first row of a handle carries the
// product fields; later rows with the same handle carry only variant fields
// and are folded into it (see `groupProductRows`). A product with no variants
// is simply a handle with one row and no Variant Name.

const PRODUCT_COLUMNS: ColumnDef[] = [
  {
    key: "Handle",
    field: "handle",
    type: "text",
    required: true,
    maxLength: 200,
    aliases: ["slug", "url handle", "product handle"],
    help: "The product's URL slug. Rows sharing a handle become one product with several variants.",
    example: "amul-taaza-toned-milk",
  },
  {
    key: "Title",
    field: "name",
    type: "text",
    maxLength: 300,
    aliases: ["name", "product title", "product name"],
    help: "Required when creating. Leave blank on a variant row.",
    example: "Amul Taaza Toned Milk",
  },
  {
    key: "Description",
    field: "description",
    type: "text",
    maxLength: 20000,
    aliases: ["body", "body html", "body (html)", "product description"],
    example: "Fresh toned milk, pasteurised.",
  },
  {
    key: "Category",
    field: "category",
    type: "text",
    maxLength: 200,
    aliases: ["collection", "product category", "product type"],
    help: "Matched by name or handle. Created automatically if it doesn't exist yet.",
    example: "Dairy",
  },
  {
    key: "Status",
    field: "status",
    type: "enum",
    enumValues: ["draft", "published"],
    enumAliases: {
      active: "published",
      live: "published",
      true: "published",
      visible: "published",
      archived: "draft",
      false: "draft",
      hidden: "draft",
    },
    example: "published",
  },
  { key: "Featured", field: "featured", type: "boolean", example: "FALSE" },
  {
    key: "Base Price",
    field: "basePrice",
    type: "decimal",
    min: 0,
    max: 99999999,
    aliases: ["mrp", "compare at price", "list price"],
    example: "60",
  },
  {
    key: "Selling Price",
    field: "sellingPrice",
    type: "decimal",
    min: 0,
    max: 99999999,
    aliases: ["price", "sale price"],
    help: "Clamped to Base Price when higher.",
    example: "54",
  },
  {
    key: "Image URL",
    field: "imageUrl",
    type: "url",
    aliases: ["image", "image src", "main image"],
    example: "https://storage.googleapis.com/bucket/milk.webp",
  },
  {
    key: "Gallery Image URLs",
    field: "images",
    type: "list",
    aliases: ["images", "gallery", "additional images"],
    help: "Separate with | (or commas if no URL contains one).",
  },
  { key: "SEO Title", field: "seoTitle", type: "text", maxLength: 300 },
  {
    key: "SEO Description",
    field: "seoDescription",
    type: "text",
    maxLength: 1000,
  },
  { key: "Card Colour", field: "cardColor", type: "text", maxLength: 50 },
  {
    key: "Sort Order",
    field: "sortOrder",
    type: "integer",
    min: 0,
    max: 99999,
  },
  {
    key: "Track Inventory",
    field: "trackInventory",
    type: "boolean",
    example: "TRUE",
  },
  {
    key: "Stock",
    field: "stock",
    type: "integer",
    min: 0,
    max: 9999999,
    aliases: ["quantity", "qty", "inventory qty", "inventory quantity"],
    help: "Only applied when creating. Change stock on an existing product with an Inventory import — it has to go through the stock ledger.",
    example: "120",
  },
  {
    key: "Low Stock Threshold",
    field: "lowStockThreshold",
    type: "integer",
    min: 0,
    max: 9999999,
  },
  { key: "Allow Backorder", field: "allowBackorder", type: "boolean" },
  {
    key: "Barcode",
    field: "barcode",
    type: "text",
    maxLength: 100,
    aliases: ["ean", "upc", "gtin"],
    help: "Your supplier's scannable code. Not the same as SKU.",
  },
  { key: "HSN Code", field: "hsnCode", type: "text", maxLength: 20 },
  {
    key: "Tax Class",
    field: "taxClass",
    type: "text",
    maxLength: 200,
    help: "Matched by name against your existing tax classes. Never created automatically — a wrong rate is a tax filing problem.",
    example: "GST 5%",
  },
  { key: "Returnable", field: "returnable", type: "boolean" },
  {
    key: "Return Window Days",
    field: "returnWindowDays",
    type: "integer",
    min: 0,
    max: 365,
    help: "Blank uses the store's default window.",
  },
  {
    key: "SKU",
    field: "sku",
    type: "text",
    readOnly: true,
    help: "Generated by StoreMink and permanent. Exported for reference; ignored on import.",
  },
  // --- variant columns -----------------------------------------------------
  {
    key: "Variant Name",
    field: "variantName",
    type: "text",
    maxLength: 200,
    aliases: ["option1 value", "variant", "variant title"],
    help: "Blank means the row is the product itself, not a variant.",
    example: "1 L",
  },
  {
    key: "Variant Base Price",
    field: "variantBasePrice",
    type: "decimal",
    min: 0,
    max: 99999999,
  },
  {
    key: "Variant Selling Price",
    field: "variantSellingPrice",
    type: "decimal",
    min: 0,
    max: 99999999,
  },
  {
    key: "Variant Special Price",
    field: "variantSpecialPrice",
    type: "decimal",
    min: 0,
    max: 99999999,
    help: "Optional sale price. Blank or 0 means none.",
  },
  {
    key: "Variant Stock",
    field: "variantStock",
    type: "integer",
    min: 0,
    max: 9999999,
    help: "Only applied when creating the variant — see Stock.",
  },
  {
    key: "Variant Barcode",
    field: "variantBarcode",
    type: "text",
    maxLength: 100,
  },
  { key: "Variant Image URL", field: "variantImageUrl", type: "url" },
  {
    key: "Variant SKU",
    field: "variantSku",
    type: "text",
    readOnly: true,
    help: "Generated by StoreMink. Exported for reference; ignored on import.",
  },
];

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

const CATEGORY_COLUMNS: ColumnDef[] = [
  {
    key: "Handle",
    field: "handle",
    type: "text",
    required: true,
    maxLength: 200,
    aliases: ["slug", "url handle"],
    help: "URL slug. This is what an import matches on.",
    example: "dairy",
  },
  {
    key: "Name",
    field: "name",
    type: "text",
    maxLength: 200,
    aliases: ["title", "category name"],
    help: "Required when creating.",
    example: "Dairy",
  },
  {
    key: "Description",
    field: "description",
    type: "text",
    maxLength: 5000,
  },
  { key: "Image URL", field: "imageUrl", type: "url", aliases: ["image"] },
  {
    key: "Sort Order",
    field: "sortOrder",
    type: "integer",
    min: 0,
    max: 99999,
  },
  {
    key: "Status",
    field: "status",
    type: "enum",
    enumValues: ["active", "hidden"],
    enumAliases: {
      published: "active",
      visible: "active",
      true: "active",
      draft: "hidden",
      inactive: "hidden",
      false: "hidden",
    },
    example: "active",
  },
];

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------
//
// Deliberately narrow: this file sets COUNTS, nothing else. Everything
// descriptive is read-only, so a merchant editing a stocktake spreadsheet
// cannot rename a product by accident.

const INVENTORY_COLUMNS: ColumnDef[] = [
  {
    key: "SKU",
    field: "sku",
    type: "text",
    required: true,
    maxLength: 100,
    help: "The StoreMink SKU. Identifies the product or variant to count.",
    example: "SKU100100015",
  },
  {
    key: "Product",
    field: "productName",
    type: "text",
    readOnly: true,
    help: "For your reference. Changes here are ignored.",
  },
  { key: "Variant", field: "variantName", type: "text", readOnly: true },
  {
    key: "Location",
    field: "location",
    type: "text",
    maxLength: 200,
    help: "Location name. Blank uses your default location.",
    example: "Main",
  },
  {
    key: "On Hand",
    field: "onHand",
    type: "integer",
    min: 0,
    max: 9999999,
    aliases: ["stock", "quantity", "qty", "counted", "available quantity"],
    help: "The count you want this location to have. Applied as an adjustment, so the stock history stays intact.",
    example: "120",
  },
  {
    key: "Reserved",
    field: "reserved",
    type: "integer",
    readOnly: true,
    help: "Held for open orders and pickups. Not editable here.",
  },
  {
    key: "Available",
    field: "available",
    type: "integer",
    readOnly: true,
    help: "On Hand minus Reserved.",
  },
];

// ---------------------------------------------------------------------------
// Orders — EXPORT ONLY
// ---------------------------------------------------------------------------
//
// ★ There is no order import, and that is a decision rather than a gap. An
// imported order would carry an order_ref this store never issued, reserve no
// stock, take no money, and land in revenue reports as a sale that never
// happened. Every field below is therefore read-only.
//
// One row per LINE ITEM with the order-level fields repeated — what a
// spreadsheet pivot and an accountant both expect.

const ORDER_COLUMNS: ColumnDef[] = [
  { key: "Order Ref", field: "orderRef", type: "text", readOnly: true },
  { key: "Order Date", field: "createdAt", type: "date", readOnly: true },
  { key: "Status", field: "status", type: "text", readOnly: true },
  {
    key: "Payment Status",
    field: "paymentStatus",
    type: "text",
    readOnly: true,
  },
  {
    key: "Payment Method",
    field: "paymentMethod",
    type: "text",
    readOnly: true,
  },
  { key: "Sales Channel", field: "salesChannel", type: "text", readOnly: true },
  {
    key: "Fulfilment Type",
    field: "fulfilmentType",
    type: "text",
    readOnly: true,
  },
  { key: "Location", field: "locationName", type: "text", readOnly: true },
  { key: "Customer Name", field: "customerName", type: "text", readOnly: true },
  {
    key: "Customer Email",
    field: "customerEmail",
    type: "text",
    readOnly: true,
  },
  {
    key: "Customer Phone",
    field: "customerPhone",
    type: "text",
    readOnly: true,
  },
  { key: "Shipping Name", field: "shipName", type: "text", readOnly: true },
  {
    key: "Shipping Address 1",
    field: "shipLine1",
    type: "text",
    readOnly: true,
  },
  {
    key: "Shipping Address 2",
    field: "shipLine2",
    type: "text",
    readOnly: true,
  },
  { key: "Shipping City", field: "shipCity", type: "text", readOnly: true },
  { key: "Shipping State", field: "shipState", type: "text", readOnly: true },
  {
    key: "Shipping Postcode",
    field: "shipPostcode",
    type: "text",
    readOnly: true,
  },
  {
    key: "Shipping Country",
    field: "shipCountry",
    type: "text",
    readOnly: true,
  },
  { key: "Line Product", field: "lineProduct", type: "text", readOnly: true },
  { key: "Line Variant", field: "lineVariant", type: "text", readOnly: true },
  { key: "Line SKU", field: "lineSku", type: "text", readOnly: true },
  { key: "Line Quantity", field: "lineQty", type: "integer", readOnly: true },
  {
    key: "Line Unit Price",
    field: "linePrice",
    type: "decimal",
    readOnly: true,
  },
  {
    key: "Line Discount",
    field: "lineDiscount",
    type: "decimal",
    readOnly: true,
  },
  { key: "Line Tax", field: "lineTax", type: "decimal", readOnly: true },
  { key: "Line Total", field: "lineTotal", type: "decimal", readOnly: true },
  { key: "Order Subtotal", field: "subtotal", type: "decimal", readOnly: true },
  { key: "Order Discount", field: "discount", type: "decimal", readOnly: true },
  { key: "Order Tax", field: "tax", type: "decimal", readOnly: true },
  { key: "Order Shipping", field: "shipping", type: "decimal", readOnly: true },
  {
    key: "Store Credit Used",
    field: "storeCreditUsed",
    type: "decimal",
    readOnly: true,
  },
  { key: "Order Total", field: "total", type: "decimal", readOnly: true },
  { key: "Currency", field: "currency", type: "text", readOnly: true },
  { key: "Coupon Code", field: "couponCode", type: "text", readOnly: true },
  { key: "Notes", field: "notes", type: "text", readOnly: true },
];

// ---------------------------------------------------------------------------
// Coupons
// ---------------------------------------------------------------------------

const COUPON_COLUMNS: ColumnDef[] = [
  {
    key: "Code",
    field: "code",
    type: "text",
    required: true,
    maxLength: 60,
    aliases: ["coupon code", "discount code"],
    help: "Matched case-insensitively. This is what an import matches on.",
    example: "WELCOME10",
  },
  { key: "Description", field: "description", type: "text", maxLength: 500 },
  {
    key: "Discount Type",
    field: "discountType",
    type: "enum",
    enumValues: ["percentage", "fixed"],
    enumAliases: {
      percent: "percentage",
      "%": "percentage",
      "percentage off": "percentage",
      amount: "fixed",
      "fixed amount": "fixed",
      flat: "fixed",
    },
    example: "percentage",
  },
  {
    key: "Discount Value",
    field: "discountValue",
    type: "decimal",
    min: 0,
    max: 99999999,
    help: "A percentage (0–100) or a rupee amount, depending on Discount Type.",
    example: "10",
  },
  {
    key: "Min Order Amount",
    field: "minOrderAmount",
    type: "decimal",
    min: 0,
    max: 99999999,
    example: "0",
  },
  {
    key: "Max Uses",
    field: "maxUses",
    type: "integer",
    min: 0,
    max: 9999999,
    help: "0 means unlimited.",
    example: "0",
  },
  {
    key: "Status",
    field: "status",
    type: "enum",
    enumValues: ["active", "disabled"],
    enumAliases: {
      enabled: "active",
      true: "active",
      inactive: "disabled",
      false: "disabled",
      expired: "disabled",
      paused: "disabled",
    },
    example: "active",
  },
  {
    key: "Valid From",
    field: "validFrom",
    type: "date",
    help: "YYYY-MM-DD. Blank means immediately.",
    example: "2026-08-01",
  },
  {
    key: "Valid Until",
    field: "validUntil",
    type: "date",
    help: "YYYY-MM-DD. Blank means no end date.",
    example: "2026-12-31",
  },
  {
    key: "Show On Storefront",
    field: "showOnStorefront",
    type: "boolean",
  },
  {
    key: "Used Count",
    field: "usedCount",
    type: "integer",
    readOnly: true,
    help: "How many times it has been redeemed. Exported for reference; ignored on import.",
  },
];

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

export const RESOURCES: readonly ResourceDef[] = [
  {
    id: "products",
    label: "Products",
    noun: "products",
    description:
      "Your catalogue, one row per variant. Rows sharing a handle become one product.",
    section: "products",
    canImport: true,
    canExport: true,
    matchOn: ["Handle"],
    columns: PRODUCT_COLUMNS,
  },
  {
    id: "categories",
    label: "Categories",
    noun: "categories",
    description: "Product categories, matched on handle.",
    section: "categories",
    canImport: true,
    canExport: true,
    matchOn: ["Handle"],
    columns: CATEGORY_COLUMNS,
  },
  {
    id: "inventory",
    label: "Inventory",
    noun: "stock levels",
    description:
      "Stock counts per location, matched on SKU. Applied through the stock ledger, so the history is kept.",
    section: "inventory",
    canImport: true,
    canExport: true,
    matchOn: ["SKU"],
    columns: INVENTORY_COLUMNS,
    // Resolving a SKU means reading products; writing a count means the
    // inventory RPC. A role holding one but not the other must not pass.
    alsoRequires: ["products"],
  },
  {
    id: "orders",
    label: "Orders",
    noun: "order lines",
    description:
      "Every order with its line items, one row per item. Export only.",
    section: "orders",
    canImport: false,
    canExport: true,
    matchOn: [],
    columns: ORDER_COLUMNS,
  },
  {
    id: "coupons",
    label: "Coupons",
    noun: "coupons",
    description: "Discount codes, matched on code.",
    section: "marketing",
    canImport: true,
    canExport: true,
    matchOn: ["Code"],
    columns: COUPON_COLUMNS,
  },
];

const BY_ID = new Map(RESOURCES.map((r) => [r.id, r]));

export function getResource(id: string): ResourceDef | undefined {
  return BY_ID.get(id as ResourceId);
}

export function isResourceId(id: unknown): id is ResourceId {
  return typeof id === "string" && BY_ID.has(id as ResourceId);
}

/** Columns an import will actually read (everything the DB doesn't own). */
export function writableColumns(resource: ResourceDef): ColumnDef[] {
  return resource.columns.filter((c) => !c.readOnly);
}

/**
 * A blank template: the header row plus one example row.
 *
 * Read-only columns are omitted rather than shown greyed out — a template is
 * what someone fills in, and a column that will be ignored is an invitation to
 * waste an afternoon on it.
 */
export function templateRows(resource: ResourceDef): {
  header: string[];
  example: string[];
} {
  const cols = writableColumns(resource);
  return {
    header: cols.map((c) => c.key),
    example: cols.map((c) => c.example ?? ""),
  };
}

/** Header row for an export — every column, read-only ones included. */
export function exportHeader(resource: ResourceDef): string[] {
  return resource.columns.map((c) => c.key);
}

/**
 * Lay a record out in the resource's column order.
 *
 * ★ THE REASON EXPORTERS YIELD OBJECTS, NOT ARRAYS. An exporter that built its
 * own array had to keep a positional list in step with the registry by hand,
 * and the failure mode is silent and total: add one column to the registry,
 * forget one exporter, and every cell after that point shifts by one — prices
 * land in the stock column, and the file still looks plausible enough to
 * reimport. Going through the registry means a field nobody supplied exports
 * as EMPTY, which is a visibly missing value rather than corrupt data.
 */
export function toCells(
  resource: ResourceDef,
  record: Readonly<Record<string, unknown>>,
): unknown[] {
  return resource.columns.map((c) => record[c.field] ?? null);
}
