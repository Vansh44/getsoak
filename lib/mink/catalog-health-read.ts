import "server-only";

import { sql } from "drizzle-orm";
import { withUser, type UserIdentity } from "@/lib/db/client";

export type MinkCatalogInventoryStatus = "in" | "low" | "out" | "untracked";

export interface MinkCatalogHealthItem {
  id: string;
  productId: string;
  variantId: string | null;
  productName: string;
  variantName: string | null;
  sku: string;
  publicationStatus: string;
  publicationTags: string[];
  stock: number | null;
  threshold: number | null;
  inventoryStatus: MinkCatalogInventoryStatus | null;
  dashboardPath: string;
}

export interface MinkCatalogHealthResult {
  total: number;
  published: number;
  unpublished: number;
  draft: number;
  archived: number;
  inventoryItems: number | null;
  lowStock: number | null;
  outOfStock: number | null;
  items: MinkCatalogHealthItem[];
  truncated: boolean;
}

/**
 * Read one bounded catalogue-health snapshot using the same sellable-SKU model
 * as the Inventory workspace: simple products without variants plus every
 * variant. Publication counts stay product-level; stock counts are explicitly
 * SKU-level. A scoped location reads inventory_levels, while an unrestricted
 * read uses the trigger-maintained all-location aggregate.
 */
export async function readMinkCatalogHealth(input: {
  storeId: string;
  identity: UserIdentity;
  locationIds: string[] | null;
  defaultThreshold: number;
  includeInventory: boolean;
  limit: number;
}): Promise<MinkCatalogHealthResult> {
  const inventoryVisible =
    input.includeInventory && input.locationIds?.length !== 0;
  const scoped = inventoryVisible && input.locationIds !== null;
  const locationIds = input.locationIds ?? [];
  const locationFilter = scoped
    ? sql`and il.location_id in (${sql.join(
        locationIds.map((id) => sql`${id}`),
        sql`, `,
      )})`
    : sql`and false`;
  const productStock = scoped
    ? sql`coalesce(sl.stock, 0)::int`
    : sql`p.stock::int`;
  const variantStock = scoped
    ? sql`coalesce(sl.stock, 0)::int`
    : sql`v.stock::int`;

  const result = await withUser(input.identity, (db) =>
    db.execute(sql`
      with product_counts as (
        select
          count(*)::int as total,
          count(*) filter (where p.status = 'published')::int as published,
          count(*) filter (where p.status <> 'published')::int as unpublished,
          count(*) filter (where p.status = 'draft')::int as draft,
          count(*) filter (where p.status = 'archived')::int as archived
        from products p
        where p.store_id = ${input.storeId}
      ),
      scoped_levels as (
        select
          il.product_id,
          il.variant_id,
          coalesce(sum(il.on_hand), 0)::int as stock
        from inventory_levels il
        where il.store_id = ${input.storeId}
          ${locationFilter}
        group by il.product_id, il.variant_id
      ),
      sku_rows as (
        select
          p.id as product_id,
          null::uuid as variant_id,
          p.name as product_name,
          null::text as variant_name,
          p.sku,
          p.status as publication_status,
          p.track_inventory,
          ${productStock} as stock,
          coalesce(p.low_stock_threshold, ${input.defaultThreshold})::int as threshold
        from products p
        left join scoped_levels sl
          on sl.product_id = p.id and sl.variant_id is null
        where p.store_id = ${input.storeId}
          and not exists (
            select 1
            from product_variants child
            where child.product_id = p.id
          )

        union all

        select
          p.id as product_id,
          v.id as variant_id,
          p.name as product_name,
          v.name as variant_name,
          v.sku,
          p.status as publication_status,
          v.track_inventory,
          ${variantStock} as stock,
          coalesce(v.low_stock_threshold, ${input.defaultThreshold})::int as threshold
        from product_variants v
        inner join products p
          on p.id = v.product_id and p.store_id = ${input.storeId}
        left join scoped_levels sl on sl.variant_id = v.id
        where v.store_id = ${input.storeId}
      ),
      tagged as (
        select
          sku_rows.*,
          case
            when not sku_rows.track_inventory then 'untracked'
            when sku_rows.stock <= 0 then 'out'
            when sku_rows.stock <= sku_rows.threshold then 'low'
            else 'in'
          end as inventory_status
        from sku_rows
      )
      select
        pc.total,
        pc.published,
        pc.unpublished,
        pc.draft,
        pc.archived,
        ${inventoryVisible ? sql`(select count(*)::int from tagged)` : sql`null::int`} as inventory_items,
        ${inventoryVisible ? sql`(select count(*) filter (where inventory_status = 'low')::int from tagged)` : sql`null::int`} as low_stock,
        ${inventoryVisible ? sql`(select count(*) filter (where inventory_status = 'out')::int from tagged)` : sql`null::int`} as out_of_stock,
        coalesce((
          select jsonb_agg(to_jsonb(visible))
          from (
            select
              t.product_id,
              t.variant_id,
              t.product_name,
              t.variant_name,
              t.sku,
              t.publication_status,
              ${inventoryVisible ? sql`t.stock` : sql`null::int as stock`},
              ${inventoryVisible ? sql`t.threshold` : sql`null::int as threshold`},
              ${inventoryVisible ? sql`t.inventory_status` : sql`null::text as inventory_status`}
            from tagged t
            order by
              case ${inventoryVisible ? sql`t.inventory_status` : sql`t.publication_status`}
                when 'out' then 0
                when 'low' then 1
                when 'draft' then 2
                when 'archived' then 3
                when 'untracked' then 5
                else 4
              end,
              t.product_name,
              t.variant_name nulls first,
              t.sku
            limit ${input.limit + 1}
          ) visible
        ), '[]'::jsonb) as items
      from product_counts pc
    `),
  );

  const row = result.rows[0] as Record<string, unknown> | undefined;
  const rawItems = Array.isArray(row?.items)
    ? (row.items as Array<Record<string, unknown>>)
    : [];
  const items = rawItems.slice(0, input.limit).map(toCatalogItem);
  return {
    total: numberValue(row?.total),
    published: numberValue(row?.published),
    unpublished: numberValue(row?.unpublished),
    draft: numberValue(row?.draft),
    archived: numberValue(row?.archived),
    inventoryItems: nullableNumber(row?.inventory_items),
    lowStock: nullableNumber(row?.low_stock),
    outOfStock: nullableNumber(row?.out_of_stock),
    items,
    truncated: rawItems.length > input.limit,
  };
}

function toCatalogItem(row: Record<string, unknown>): MinkCatalogHealthItem {
  const productId = String(row.product_id ?? "");
  const variantId = nullableString(row.variant_id);
  const publicationStatus = String(row.publication_status ?? "draft");
  const inventoryStatus = isInventoryStatus(row.inventory_status)
    ? row.inventory_status
    : null;
  return {
    id: variantId ?? productId,
    productId,
    variantId,
    productName: String(row.product_name ?? "Product"),
    variantName: nullableString(row.variant_name),
    sku: String(row.sku ?? ""),
    publicationStatus,
    publicationTags:
      publicationStatus === "published"
        ? ["published"]
        : ["unpublished", publicationStatus],
    stock: nullableNumber(row.stock),
    threshold: nullableNumber(row.threshold),
    inventoryStatus,
    dashboardPath: `/dashboard/products/${productId}`,
  };
}

function isInventoryStatus(
  value: unknown,
): value is MinkCatalogInventoryStatus {
  return (
    value === "in" ||
    value === "low" ||
    value === "out" ||
    value === "untracked"
  );
}

function numberValue(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}
