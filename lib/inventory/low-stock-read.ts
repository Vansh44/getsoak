import "server-only";

import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { inventoryLevels, products, productVariants } from "@/drizzle/schema";
import { withUser, type UserIdentity } from "@/lib/db/client";

export interface LowStockReadItem {
  productId: string;
  variantId: string | null;
  productName: string;
  variantName: string | null;
  sku: string;
  stock: number;
  threshold: number;
  status: "low" | "out";
  productStatus: string;
}

export async function readLowStockItems(input: {
  storeId: string;
  identity: UserIdentity;
  /** Null is the store-wide aggregate; an array is the exact allowed shelf set. */
  locationIds: string[] | null;
  defaultThreshold: number;
  includeOutOfStock: boolean;
  limit: number;
}): Promise<{ items: LowStockReadItem[]; truncated: boolean }> {
  if (input.locationIds?.length === 0) return { items: [], truncated: false };
  const queryLimit = input.limit + 1;
  const scoped = input.locationIds !== null;

  const [productRows, variantRows] = await withUser(
    input.identity,
    async (db) => {
      const productStock = scoped
        ? sql<number>`coalesce(sum(${inventoryLevels.onHand}), 0)::int`
        : products.stock;
      const variantStock = scoped
        ? sql<number>`coalesce(sum(${inventoryLevels.onHand}), 0)::int`
        : productVariants.stock;
      const productThreshold = sql<number>`coalesce(${products.lowStockThreshold}, ${input.defaultThreshold})`;
      const variantThreshold = sql<number>`coalesce(${productVariants.lowStockThreshold}, ${input.defaultThreshold})`;
      const productStockCondition = input.includeOutOfStock
        ? sql`${productStock} <= ${productThreshold}`
        : sql`${productStock} > 0 and ${productStock} <= ${productThreshold}`;
      const variantStockCondition = input.includeOutOfStock
        ? sql`${variantStock} <= ${variantThreshold}`
        : sql`${variantStock} > 0 and ${variantStock} <= ${variantThreshold}`;
      const productCommon = and(
        eq(products.storeId, input.storeId),
        eq(products.trackInventory, true),
        eq(products.allowBackorder, false),
        sql`not exists (select 1 from product_variants child where child.product_id = ${products.id})`,
      );
      const variantCommon = and(
        eq(productVariants.storeId, input.storeId),
        eq(products.storeId, input.storeId),
        eq(productVariants.trackInventory, true),
        eq(productVariants.allowBackorder, false),
      );

      let productQuery = db
        .select({
          productId: products.id,
          variantId: sql<null>`null`,
          productName: products.name,
          variantName: sql<null>`null`,
          sku: products.sku,
          stock: productStock,
          threshold: productThreshold,
          productStatus: products.status,
        })
        .from(products)
        .leftJoin(
          inventoryLevels,
          scoped
            ? and(
                eq(inventoryLevels.storeId, input.storeId),
                eq(inventoryLevels.productId, products.id),
                isNull(inventoryLevels.variantId),
                inArray(
                  inventoryLevels.locationId,
                  input.locationIds as string[],
                ),
              )
            : sql`false`,
        )
        .$dynamic();
      if (scoped) {
        productQuery = productQuery
          .where(productCommon)
          .groupBy(
            products.id,
            products.name,
            products.sku,
            products.lowStockThreshold,
            products.status,
          )
          .having(productStockCondition);
      } else {
        productQuery = productQuery.where(
          and(productCommon, productStockCondition),
        );
      }

      let variantQuery = db
        .select({
          productId: products.id,
          variantId: productVariants.id,
          productName: products.name,
          variantName: productVariants.name,
          sku: productVariants.sku,
          stock: variantStock,
          threshold: variantThreshold,
          productStatus: products.status,
        })
        .from(productVariants)
        .innerJoin(products, eq(products.id, productVariants.productId))
        .leftJoin(
          inventoryLevels,
          scoped
            ? and(
                eq(inventoryLevels.storeId, input.storeId),
                eq(inventoryLevels.variantId, productVariants.id),
                inArray(
                  inventoryLevels.locationId,
                  input.locationIds as string[],
                ),
              )
            : sql`false`,
        )
        .$dynamic();
      if (scoped) {
        variantQuery = variantQuery
          .where(variantCommon)
          .groupBy(
            products.id,
            products.name,
            products.status,
            productVariants.id,
            productVariants.name,
            productVariants.sku,
            productVariants.lowStockThreshold,
          )
          .having(variantStockCondition);
      } else {
        variantQuery = variantQuery.where(
          and(variantCommon, variantStockCondition),
        );
      }

      // One withUser transaction owns one pg client. Issue statements
      // sequentially instead of pretending Promise.all gives DB concurrency.
      const productRows = await productQuery
        .orderBy(asc(productStock), asc(products.name))
        .limit(queryLimit);
      const variantRows = await variantQuery
        .orderBy(
          asc(variantStock),
          asc(products.name),
          asc(productVariants.name),
        )
        .limit(queryLimit);
      return [productRows, variantRows] as const;
    },
  );

  const combined = [...productRows, ...variantRows]
    .map((row) => {
      const stock = Number(row.stock);
      return {
        ...row,
        stock,
        threshold: Number(row.threshold),
        status: stock <= 0 ? ("out" as const) : ("low" as const),
      };
    })
    .sort(
      (left, right) =>
        left.stock - right.stock ||
        left.productName.localeCompare(right.productName) ||
        (left.variantName ?? "").localeCompare(right.variantName ?? ""),
    );
  return {
    items: combined.slice(0, input.limit),
    truncated: combined.length > input.limit,
  };
}
