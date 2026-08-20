import "server-only";

import { and, asc, eq } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import {
  cardColors,
  categories,
  products,
  stores,
  taxClasses,
} from "@/drizzle/schema";
import { getActingStoreId } from "@/app/dashboard/lib/access";
import { resolveStoreSettings } from "@/lib/settings/registry";
import { PRODUCT_COLUMNS, VARIANT_COLUMNS } from "./columns";
import { productVariants } from "@/drizzle/schema";
import type {
  Product,
  CategoryOption,
  CardColorOption,
  TaxClassOption,
} from "./page";
import { storeHasAnalyticsFeature } from "@/lib/analytics/store-entitlement";

/**
 * The option lists (categories, card colours, tax classes) + the store default
 * for the "track inventory" checkbox — everything the editor needs to CREATE a
 * new product (no product row yet). Used by the full-page New-product route,
 * mirroring the list page's own option loading.
 */
export async function getProductCreateData(): Promise<{
  categories: CategoryOption[];
  colors: CardColorOption[];
  taxClasses: TaxClassOption[];
  defaultTrackInventory: boolean;
  canUseGrossMargin: boolean;
}> {
  const storeId = await getActingStoreId();
  const canUseGrossMargin = await storeHasAnalyticsFeature(
    storeId,
    "grossMargin",
  );

  return await withService(async (db) => {
    const categoryRows = await db
      .select({
        id: categories.id,
        name: categories.name,
        slug: categories.slug,
        status: categories.status,
      })
      .from(categories)
      .where(eq(categories.storeId, storeId))
      .orderBy(asc(categories.sortOrder), asc(categories.name));
    const colorRows = await db
      .select({ id: cardColors.id, name: cardColors.name, hex: cardColors.hex })
      .from(cardColors)
      .where(eq(cardColors.storeId, storeId))
      .orderBy(asc(cardColors.sortOrder), asc(cardColors.name));
    const taxClassRows = await db
      .select({
        id: taxClasses.id,
        name: taxClasses.name,
        rate: taxClasses.rate,
      })
      .from(taxClasses)
      .where(eq(taxClasses.storeId, storeId))
      .orderBy(asc(taxClasses.sortOrder), asc(taxClasses.name));
    const storeRows = await db
      .select({ settings: stores.settings, plan: stores.plan })
      .from(stores)
      .where(eq(stores.id, storeId))
      .limit(1);

    const settings = resolveStoreSettings(
      storeRows[0]?.settings as Record<string, unknown>,
      storeRows[0]?.plan,
    );

    return {
      categories: categoryRows as CategoryOption[],
      colors: colorRows as CardColorOption[],
      taxClasses: taxClassRows as TaxClassOption[],
      defaultTrackInventory: Boolean(settings["inventory.simpleTrackDefault"]),
      canUseGrossMargin,
    };
  });
}

/**
 * Everything the product editor needs for one product: the product (with its
 * category + variants) plus the category, card-colour and tax-class option
 * lists. Returns null if the product doesn't exist for this store. Service
 * scope + explicit store filter (the editor needs drafts too), mirroring the
 * list page.
 */
export async function getProductEditData(id: string): Promise<{
  product: Product;
  categories: CategoryOption[];
  colors: CardColorOption[];
  taxClasses: TaxClassOption[];
  canUseGrossMargin: boolean;
} | null> {
  const storeId = await getActingStoreId();
  const canUseGrossMargin = await storeHasAnalyticsFeature(
    storeId,
    "grossMargin",
  );

  try {
    return await withService(async (db) => {
      const productRows = await db
        .select({
          ...PRODUCT_COLUMNS,
          cat_id: categories.id,
          cat_name: categories.name,
          cat_slug: categories.slug,
        })
        .from(products)
        .leftJoin(categories, eq(products.categoryId, categories.id))
        .where(and(eq(products.id, id), eq(products.storeId, storeId)))
        .limit(1);
      const variants = await db
        .select(VARIANT_COLUMNS)
        .from(productVariants)
        .where(eq(productVariants.productId, id))
        .orderBy(asc(productVariants.sortOrder));
      const categoryRows = await db
        .select({
          id: categories.id,
          name: categories.name,
          slug: categories.slug,
          status: categories.status,
        })
        .from(categories)
        .where(eq(categories.storeId, storeId))
        .orderBy(asc(categories.sortOrder), asc(categories.name));
      const colorRows = await db
        .select({
          id: cardColors.id,
          name: cardColors.name,
          hex: cardColors.hex,
        })
        .from(cardColors)
        .where(eq(cardColors.storeId, storeId))
        .orderBy(asc(cardColors.sortOrder), asc(cardColors.name));
      const taxClassRows = await db
        .select({
          id: taxClasses.id,
          name: taxClasses.name,
          rate: taxClasses.rate,
        })
        .from(taxClasses)
        .where(eq(taxClasses.storeId, storeId))
        .orderBy(asc(taxClasses.sortOrder), asc(taxClasses.name));

      const row = productRows[0];
      if (!row) {
        // Don't swallow the reason: a null here renders a 404. If the row
        // exists (it usually does), the culprit is almost always a store_id
        // mismatch — this log makes it obvious.
        console.error(
          `getProductEditData: no product for id=${id} store=${storeId} (0 rows matched)`,
        );
        return null;
      }

      const { cat_id, cat_name, cat_slug, ...productFields } = row;
      const product = {
        ...productFields,
        category: cat_id
          ? { id: cat_id, name: cat_name!, slug: cat_slug! }
          : null,
        variants,
      } as unknown as Product;

      return {
        product,
        categories: categoryRows as CategoryOption[],
        colors: colorRows as CardColorOption[],
        taxClasses: taxClassRows as TaxClassOption[],
        canUseGrossMargin,
      };
    });
  } catch (err) {
    console.error(
      "getProductEditData:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
