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

export interface MinkCatalogLocationHealth {
  id: string;
  name: string;
  type: string;
  inventoryItems: number;
  trackedItems: number;
  lowStock: number;
  outOfStock: number;
  dashboardPath: string;
}

export interface MinkCatalogLocationComparisonResult {
  total: number;
  published: number;
  unpublished: number;
  draft: number;
  archived: number;
  inventoryItems: number;
  trackedItems: number;
  locations: MinkCatalogLocationHealth[];
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

/**
 * Compare the same tracked-SKU status rules across an already authorized set
 * of active locations. Missing inventory_levels rows count as zero on that
 * shelf, matching the Inventory workspace. The query rechecks store and active
 * location predicates even though the ids came from trusted actor scope.
 */
export async function readMinkCatalogHealthByLocation(input: {
  storeId: string;
  identity: UserIdentity;
  locationIds: string[];
  defaultThreshold: number;
}): Promise<MinkCatalogLocationComparisonResult> {
  const locationFilter = input.locationIds.length
    ? sql`and l.id in (${sql.join(
        input.locationIds.map((id) => sql`${id}`),
        sql`, `,
      )})`
    : sql`and false`;
  const levelFilter = input.locationIds.length
    ? sql`and il.location_id in (${sql.join(
        input.locationIds.map((id) => sql`${id}`),
        sql`, `,
      )})`
    : sql`and false`;

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
      sku_rows as (
        select
          p.id as product_id,
          null::uuid as variant_id,
          p.track_inventory,
          coalesce(p.low_stock_threshold, ${input.defaultThreshold})::int as threshold
        from products p
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
          v.track_inventory,
          coalesce(v.low_stock_threshold, ${input.defaultThreshold})::int as threshold
        from product_variants v
        inner join products p
          on p.id = v.product_id and p.store_id = ${input.storeId}
        where v.store_id = ${input.storeId}
      ),
      sku_counts as (
        select
          count(*)::int as inventory_items,
          count(*) filter (where track_inventory)::int as tracked_items
        from sku_rows
      ),
      location_levels as (
        select
          il.location_id,
          sku.product_id,
          sku.variant_id,
          sku.threshold,
          coalesce(sum(il.on_hand), 0)::int as stock
        from inventory_levels il
        inner join sku_rows sku
          on sku.track_inventory
          and sku.product_id = il.product_id
          and sku.variant_id is not distinct from il.variant_id
        where il.store_id = ${input.storeId}
          ${levelFilter}
        group by
          il.location_id,
          sku.product_id,
          sku.variant_id,
          sku.threshold
      ),
      location_counts as (
        select
          l.id,
          l.name,
          l.type,
          counts.inventory_items,
          counts.tracked_items,
          count(levels.product_id) filter (
            where levels.stock > 0 and levels.stock <= levels.threshold
          )::int as low_stock,
          (
            counts.tracked_items
            - count(levels.product_id)
            + count(levels.product_id) filter (where levels.stock <= 0)
          )::int as out_of_stock,
          l.sort_order
        from store_locations l
        cross join sku_counts counts
        left join location_levels levels on levels.location_id = l.id
        where l.store_id = ${input.storeId}
          and l.active = true
          ${locationFilter}
        group by
          l.id,
          l.name,
          l.type,
          l.sort_order,
          counts.inventory_items,
          counts.tracked_items
      )
      select
        products.total,
        products.published,
        products.unpublished,
        products.draft,
        products.archived,
        counts.inventory_items,
        counts.tracked_items,
        coalesce((
          select jsonb_agg(
            jsonb_build_object(
              'id', location_counts.id,
              'name', location_counts.name,
              'type', location_counts.type,
              'inventory_items', location_counts.inventory_items,
              'tracked_items', location_counts.tracked_items,
              'low_stock', location_counts.low_stock,
              'out_of_stock', location_counts.out_of_stock
            )
            order by location_counts.sort_order, location_counts.name
          )
          from location_counts
        ), '[]'::jsonb) as locations
      from product_counts products
      cross join sku_counts counts
    `),
  );

  const row = result.rows[0] as Record<string, unknown> | undefined;
  const locations = Array.isArray(row?.locations)
    ? (row.locations as Array<Record<string, unknown>>)
    : [];
  return {
    total: numberValue(row?.total),
    published: numberValue(row?.published),
    unpublished: numberValue(row?.unpublished),
    draft: numberValue(row?.draft),
    archived: numberValue(row?.archived),
    inventoryItems: numberValue(row?.inventory_items),
    trackedItems: numberValue(row?.tracked_items),
    locations: locations.map((location) => {
      const id = String(location.id ?? "");
      return {
        id,
        name: String(location.name ?? "Location"),
        type: String(location.type ?? "location"),
        inventoryItems: numberValue(location.inventory_items),
        trackedItems: numberValue(location.tracked_items),
        lowStock: numberValue(location.low_stock),
        outOfStock: numberValue(location.out_of_stock),
        dashboardPath: `/dashboard/inventory?location=${encodeURIComponent(id)}`,
      };
    }),
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
