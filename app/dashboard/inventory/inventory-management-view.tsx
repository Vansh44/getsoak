"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import Image from "next/image";
import {
  ImageIcon,
  Search,
  PackageMinus,
  Edit2,
  MapPin,
  Eye,
  Settings,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { NumberField } from "@/components/ui/number-field";
import {
  bulkAdjust,
  setStock,
  type SkuRow,
  type InventoryFilter,
} from "@/app/actions/inventory-actions";
import { inventoryStatus } from "@/lib/inventory/status";
import { useRowSelection } from "@/app/dashboard/lib/use-row-selection";
import {
  BulkActionBar,
  RowCheckbox,
  SelectAllCheckbox,
} from "@/app/dashboard/components/bulk-actions";
import { ListPagination } from "@/app/dashboard/components/list-pagination";
import { ImportExportMenu } from "@/app/dashboard/components/import-export-menu";
import { InventoryHistoryDrawer } from "./inventory-history-drawer";
import { InventoryEditDrawer } from "./inventory-edit-drawer";

type Props = {
  rows: SkuRow[];
  total: number;
  categories: { id: string; name: string }[];
  canManage?: boolean;
  page: number;
  pageSize: number;
  query: string;
  filter: InventoryFilter;
  categoryFilter: string;
  storeLowStockThreshold: number;
  /** Shops this viewer may pick from; empty for a single-location store. */
  locations: { id: string; name: string }[];
  /** The shop being shown, or null for the cross-location total. */
  locationId: string | null;
  /** Store-wide totals are unavailable to location-bound staff. */
  canViewAggregate: boolean;
};

export function InventoryManagementView({
  rows: initialRows,
  total,
  categories,
  canManage = true,
  page,
  pageSize,
  query,
  filter,
  categoryFilter,
  storeLowStockThreshold,
  locations,
  locationId,
  canViewAggregate,
}: Props) {
  const router = useRouter();
  const pathname = usePathname();

  // A cross-location view shows the SUM across shops. There is no such shelf to
  // adjust, so editing is off until a specific location is chosen. Single-
  // location stores are unaffected: they have nothing to choose and locationId
  // stays null, which the compatibility wrapper resolves to their one shelf.
  const isAggregate =
    canViewAggregate && locations.length > 1 && locationId === null;
  const canEdit = canManage && !isAggregate;
  const selectedLocation =
    locations.find((location) => location.id === locationId) ?? locations[0];
  const locationName = isAggregate
    ? "all locations"
    : (selectedLocation?.name ?? "the main location");
  const locationHeading = isAggregate
    ? "All locations"
    : (selectedLocation?.name ?? "Main location");
  const [isPending, startTransition] = useTransition();
  const [navigating, startNavigation] = useTransition();
  const [search, setSearch] = useState(query);

  // Local optimistic state for rows
  const [rows, setRows] = useState(initialRows);
  useEffect(() => {
    setRows(initialRows);
  }, [initialRows]);

  const [activeHistory, setActiveHistory] = useState<SkuRow | null>(null);
  // Row-click opens the quick edit slide-over on the right.
  const [editSku, setEditSku] = useState<SkuRow | null>(null);

  const hrefFor = (next: {
    q?: string;
    filter?: InventoryFilter;
    category?: string;
    location?: string;
    page?: number;
  }): string => {
    const q = (next.q ?? query).trim();
    const f = next.filter ?? filter;
    const cat = next.category ?? categoryFilter;
    const loc =
      locations.length > 1 ? (next.location ?? locationId ?? "all") : null;
    const changedFacet =
      next.q !== undefined ||
      next.filter !== undefined ||
      next.category !== undefined ||
      next.location !== undefined;
    const p = next.page ?? (changedFacet ? 1 : page);

    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (f !== "all") params.set("filter", f);
    if (cat !== "all") params.set("category", cat);
    // `location=all` must remain explicit: an absent location now opens the
    // first real shelf for multi-location stores.
    if (loc) params.set("location", loc);
    if (p > 1) params.set("page", String(p));
    const qs = params.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  };

  const go = (next: Parameters<typeof hrefFor>[0]) =>
    startNavigation(() => router.push(hrefFor(next)));

  useEffect(() => {
    if (search.trim() === query.trim()) return;
    const handle = setTimeout(() => {
      startNavigation(() => router.push(hrefFor({ q: search })));
    }, 400);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  // Bulk selection
  const visibleIds = useMemo(() => rows.map((r) => r.id), [rows]);
  const selection = useRowSelection(visibleIds);

  const [bulkModalOpen, setBulkModalOpen] = useState(false);
  const [bulkValue, setBulkValue] = useState<number>(0);

  // Optimistic status for a row at a hypothetical stock level — uses the SAME
  // resolver as the server (getInventory) so the optimistic pill matches what a
  // refresh will show, including the store-wide default threshold fallback.
  const optimisticStatus = (r: SkuRow, newStock: number): SkuRow["status"] =>
    inventoryStatus(
      {
        track_inventory: r.trackInventory,
        stock: newStock,
        low_stock_threshold: r.lowStockThreshold,
        allow_backorder: r.allowBackorder,
      },
      storeLowStockThreshold,
    );

  // Save a new absolute stock level for one SKU. Optimistically updates the row
  // and closes the drawer immediately (feels instant), then reconciles with the
  // server and reverts on error. Shared by the edit drawer.
  const applyStock = (target: SkuRow, newStock: number, reason: string) => {
    startTransition(async () => {
      setRows((prev) =>
        prev.map((r) =>
          r.id === target.id
            ? { ...r, stock: newStock, status: optimisticStatus(r, newStock) }
            : r,
        ),
      );
      setEditSku(null);

      const res = await setStock(
        target.productId,
        target.variantId,
        newStock,
        reason,
        locationId,
      );

      if (res.error) {
        toast.error(res.error);
        setRows(initialRows); // revert
      } else {
        toast.success("Stock updated");
        router.refresh();
      }
    });
  };

  const handleBulkSubmit = () => {
    const val = bulkValue;
    const items = rows
      .filter((r) => selection.isSelected(r.id))
      .map((r) => ({
        productId: r.productId,
        variantId: r.variantId || undefined,
        set: val,
      }));

    startTransition(async () => {
      // Optimistic
      setRows((prev) =>
        prev.map((r) => {
          if (selection.isSelected(r.id)) {
            return {
              ...r,
              stock: val,
              status: optimisticStatus(r, val),
            };
          }
          return r;
        }),
      );
      setBulkModalOpen(false);
      selection.clear();

      const res = await bulkAdjust(items, locationId);
      if (res.error) {
        toast.error(res.error);
        setRows(initialRows);
      } else {
        toast.success(`Updated ${items.length} items`);
        router.refresh();
      }
    });
  };

  const tabs: { key: InventoryFilter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "low", label: "Low Stock" },
    { key: "out", label: "Out of Stock" },
  ];

  return (
    <div
      className="dash-page-enter"
      style={{ display: "flex", flexDirection: "column", minHeight: "100%" }}
    >
      <header className="dash-page-header row">
        <div>
          <h1>Inventory</h1>
          <p>Count and adjust stock at one physical location at a time.</p>
        </div>
        {/* Export the shop currently being shown, so a stocktake sheet counts
            the shelf the merchant is standing in front of. */}
        <ImportExportMenu
          resource="inventory"
          canImport={canEdit}
          filters={{ location: locationId ?? undefined }}
          locations={locations}
        />
      </header>

      <section
        className={`mb-4 rounded-xl border p-4 ${
          isAggregate
            ? "border-slate-200 bg-slate-50"
            : "border-indigo-100 bg-indigo-50/60"
        }`}
        aria-label="Inventory location"
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <span
              className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
                isAggregate
                  ? "bg-slate-200 text-slate-600"
                  : "bg-indigo-100 text-indigo-600"
              }`}
            >
              {isAggregate ? (
                <Eye className="h-4 w-4" />
              ) : (
                <MapPin className="h-4 w-4" />
              )}
            </span>
            <div className="min-w-0">
              <div className="text-xs font-semibold uppercase tracking-wide text-[#6b7280]">
                Stock location
              </div>
              <div className="mt-0.5 font-semibold text-[#111827]">
                {locationHeading}
              </div>
              <p className="mt-0.5 text-xs text-[#6b7280]">
                {isAggregate
                  ? "Store-wide totals for comparison. Choose a location before changing stock."
                  : `Every change on this page affects only ${locationName}.`}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {locations.length > 1 && (
              <label className="flex items-center gap-2 text-xs font-medium text-[#4b5563]">
                View
                <select
                  aria-label="Stock location"
                  value={locationId ?? "all"}
                  onChange={(e) => go({ location: e.target.value })}
                  className="min-w-44 rounded-lg border border-[#d1d5db] bg-white px-3 py-2 text-sm font-medium text-[#111827] outline-none focus:border-[#4f46e5] focus:ring-2 focus:ring-[#4f46e5]/15"
                >
                  {locations.map((location) => (
                    <option key={location.id} value={location.id}>
                      {location.name}
                    </option>
                  ))}
                  {canViewAggregate && (
                    <option value="all">All locations (view only)</option>
                  )}
                </select>
              </label>
            )}
            <Link
              href="/dashboard/locations"
              className="inline-flex items-center gap-1.5 rounded-lg border border-[#d1d5db] bg-white px-3 py-2 text-xs font-medium text-[#374151] hover:bg-[#f9fafb]"
            >
              <MapPin className="h-3.5 w-3.5" />
              Manage locations
            </Link>
            <Link
              href="/dashboard/inventory/settings"
              className="inline-flex items-center gap-1.5 rounded-lg border border-[#d1d5db] bg-white px-3 py-2 text-xs font-medium text-[#374151] hover:bg-[#f9fafb]"
            >
              <Settings className="h-3.5 w-3.5" />
              Settings
            </Link>
          </div>
        </div>
      </section>

      <div className="dash-card flex flex-col" style={{ flex: "1 1 auto" }}>
        <div className="dash-toolbar px-5 pt-4 pb-2 border-b border-[var(--dash-border)] mb-0 flex flex-col gap-4">
          <div className="dash-filter-tabs">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                className={`dash-filter-tab${filter === tab.key ? " active" : ""}`}
                onClick={() => go({ filter: tab.key })}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="dash-toolbar-actions w-full flex justify-between">
            <div className="flex items-center gap-2">
              <select
                value={categoryFilter}
                onChange={(e) => go({ category: e.target.value })}
                className="rounded-md border border-[var(--dash-border)] bg-[var(--dash-surface)] px-3 py-[7px] text-[13px] text-[var(--dash-text)] outline-none"
              >
                <option value="all">All categories</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>

            <label className="dash-search-bar">
              <Search className="h-4 w-4 shrink-0 opacity-50" />
              <input
                type="text"
                placeholder="Search products..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
          </div>
        </div>

        {isAggregate && (
          <div className="border-b border-slate-200 bg-slate-50 px-5 py-3 text-sm text-slate-700">
            <span className="font-semibold">View only:</span> these are totals
            across all locations. Choose a location above to edit a shelf.
          </div>
        )}

        {rows.length === 0 ? (
          <div className="dash-empty">
            <span className="dash-empty-icon">
              <PackageMinus className="h-5 w-5" />
            </span>
            <div className="dash-empty-title">No inventory found</div>
            <p className="dash-empty-text">
              Try adjusting your filters or search query.
            </p>
          </div>
        ) : (
          <table className="dash-table dash-table-wide">
            <thead>
              <tr>
                {canEdit && (
                  <th className="dash-checkbox-cell">
                    <SelectAllCheckbox
                      checked={selection.allSelected}
                      indeterminate={selection.someSelected}
                      onChange={selection.toggleAll}
                    />
                  </th>
                )}
                <th className="w-14">Image</th>
                <th>Product / Variant</th>
                <th>SKU</th>
                <th>Status</th>
                <th>
                  {isAggregate ? "Total stock" : `Stock at ${locationHeading}`}
                </th>
                {canEdit && <th className="dash-col-actions">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  onClick={canEdit ? () => setEditSku(r) : undefined}
                  className={`${canEdit ? "cursor-pointer" : ""} ${selection.isSelected(r.id) ? " is-selected" : ""} ${r.status === "low" ? "bg-amber-50/50 dark:bg-amber-900/10" : ""}`}
                >
                  {canEdit && (
                    <td
                      className="dash-checkbox-cell"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <RowCheckbox
                        checked={selection.isSelected(r.id)}
                        onToggle={() => selection.toggle(r.id)}
                        label={`Select ${r.name}`}
                      />
                    </td>
                  )}
                  <td>
                    {r.image ? (
                      <div className="dash-thumb">
                        <Image
                          src={r.image}
                          alt={r.name}
                          fill
                          sizes="48px"
                          className="object-cover"
                        />
                      </div>
                    ) : (
                      <div className="dash-thumb dash-thumb-empty">
                        <ImageIcon className="h-4 w-4" />
                      </div>
                    )}
                  </td>
                  <td>
                    <div className="dash-cell-title">{r.name}</div>
                    {r.variantName && (
                      <div className="dash-cell-sub">{r.variantName}</div>
                    )}
                  </td>
                  <td>
                    {r.sku ? (
                      <span className="dash-cell-title mono">{r.sku}</span>
                    ) : (
                      <span className="text-dim">—</span>
                    )}
                  </td>
                  <td>
                    {!r.trackInventory ? (
                      <span className="dash-badge dash-badge-grey">
                        Untracked
                      </span>
                    ) : r.status === "in" ? (
                      <span className="dash-badge dash-badge-green">
                        In stock
                      </span>
                    ) : r.status === "low" ? (
                      <span className="dash-badge dash-badge-amber">
                        Low stock
                      </span>
                    ) : (
                      <span className="dash-badge dash-badge-red text-red-600 bg-red-100 dark:bg-red-900/30">
                        Out of stock
                      </span>
                    )}
                  </td>
                  <td>
                    <div className="flex items-center gap-2">
                      {!r.trackInventory ? (
                        <span className="text-2xl text-dim">∞</span>
                      ) : (
                        <span className="dash-cell-title mono">{r.stock}</span>
                      )}
                    </div>
                  </td>
                  {canEdit && (
                    <td className="dash-col-actions">
                      <button
                        type="button"
                        className="dash-btn dash-btn-ghost h-8 px-2 text-xs"
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditSku(r);
                        }}
                      >
                        <Edit2 className="mr-1 h-3.5 w-3.5" />
                        Edit
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <ListPagination
          page={page}
          total={total}
          pageSize={pageSize}
          busy={navigating}
          onPage={(p) => go({ page: p })}
        />
      </div>

      {canEdit && (
        <BulkActionBar
          count={selection.count}
          onClear={selection.clear}
          busy={isPending}
        >
          <button
            type="button"
            className="dash-bulk-btn"
            disabled={isPending}
            onClick={() => {
              setBulkValue(0);
              setBulkModalOpen(true);
            }}
          >
            <Edit2 className="h-4 w-4" />
            Set Stock
          </button>
        </BulkActionBar>
      )}

      {/* Bulk Modal */}
      <Dialog
        open={bulkModalOpen}
        onOpenChange={(open) => !open && setBulkModalOpen(false)}
      >
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>Set stock for {selection.count} items</DialogTitle>
            <DialogDescription>
              This will overwrite the stock level for all selected tracked items
              at {locationName}.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4 space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">New stock level</label>
              <NumberField
                value={bulkValue}
                onValueChange={setBulkValue}
                className="w-full"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setBulkModalOpen(false)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button onClick={handleBulkSubmit} disabled={isPending}>
              {isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {editSku && (
        <InventoryEditDrawer
          open={!!editSku}
          onOpenChange={(open) => !open && setEditSku(null)}
          sku={editSku}
          onSave={applyStock}
          onViewHistory={(s) => {
            setEditSku(null);
            setActiveHistory(s);
          }}
          isPending={isPending}
          locationName={locationHeading}
        />
      )}

      {activeHistory && (
        <InventoryHistoryDrawer
          open={!!activeHistory}
          onOpenChange={(open) => !open && setActiveHistory(null)}
          sku={activeHistory}
          locationId={locationId}
          locationName={locationHeading}
        />
      )}
    </div>
  );
}
