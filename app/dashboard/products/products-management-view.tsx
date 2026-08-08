"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { toast } from "sonner";
import Image from "next/image";
import {
  Eye,
  ImageIcon,
  Lightbulb,
  MoreHorizontal,
  Package,
  Pencil,
  Plus,
  Search,
  Send,
  Star,
  Trash2,
  Undo2,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  deleteProduct,
  toggleProductPublish,
  bulkToggleProductPublish,
  bulkSetProductFeatured,
  bulkDeleteProducts,
} from "@/app/actions/product-actions";
import { useRowSelection } from "@/app/dashboard/lib/use-row-selection";
import {
  BulkActionBar,
  RowCheckbox,
  SelectAllCheckbox,
} from "@/app/dashboard/components/bulk-actions";
import { ListPagination } from "@/app/dashboard/components/list-pagination";
import { ImportExportMenu } from "@/app/dashboard/components/import-export-menu";
import { effectivePricing, formatPrice } from "@/lib/pricing";
import type {
  Product,
  CategoryOption,
  ProductFilter,
  ProductCounts,
} from "./page";

type Props = {
  products: Product[];
  categories: CategoryOption[];
  canManage?: boolean;
  counts: ProductCounts;
  total: number;
  page: number;
  pageSize: number;
  query: string;
  filter: ProductFilter;
  categoryFilter: string;
};

export function ProductsManagementView({
  products,
  categories,
  canManage = true,
  counts,
  total,
  page,
  pageSize,
  query,
  filter,
  categoryFilter,
}: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();
  const [navigating, startNavigation] = useTransition();
  const [search, setSearch] = useState(query);
  const [deleteTarget, setDeleteTarget] = useState<Product | null>(null);

  const hrefFor = (next: {
    q?: string;
    filter?: ProductFilter;
    category?: string;
    page?: number;
  }): string => {
    const q = (next.q ?? query).trim();
    const f = next.filter ?? filter;
    const cat = next.category ?? categoryFilter;
    const changedFacet =
      next.q !== undefined ||
      next.filter !== undefined ||
      next.category !== undefined;
    const p = next.page ?? (changedFacet ? 1 : page);

    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (f !== "all") params.set("filter", f);
    if (cat !== "all") params.set("category", cat);
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

  // ── Bulk selection (scoped to the current page) ────────────
  const visibleIds = useMemo(() => products.map((p) => p.id), [products]);
  const selection = useRowSelection(visibleIds);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  const runBulk = (
    action: () => Promise<{ error?: string; success?: boolean }>,
    successMsg: string,
  ) => {
    startTransition(async () => {
      const result = await action();
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success(successMsg);
        selection.clear();
        setBulkDeleteOpen(false);
        router.refresh();
      }
    });
  };

  const handleDelete = () => {
    if (!deleteTarget) return;
    startTransition(async () => {
      const result = await deleteProduct(deleteTarget.id);
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success("Product deleted");
        setDeleteTarget(null);
        router.refresh();
      }
    });
  };

  const handleTogglePublish = (product: Product) => {
    startTransition(async () => {
      const publish = product.status !== "published";
      const result = await toggleProductPublish(product.id, publish);
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success(publish ? "Product published" : "Product unpublished");
        router.refresh();
      }
    });
  };

  // Both create and edit are full-page, shareable routes so a teammate can be
  // sent a direct link (create = /dashboard/products/new, edit = /[id]).
  const openCreate = () => router.push("/dashboard/products/new");
  const openEdit = (product: Product) =>
    router.push(`/dashboard/products/${product.id}`);

  const tabs: { key: ProductFilter; label: string; count: number }[] = [
    { key: "all", label: "All", count: counts.all },
    { key: "published", label: "Published", count: counts.published },
    { key: "drafts", label: "Drafts", count: counts.drafts },
    { key: "featured", label: "Featured", count: counts.featured },
  ];

  return (
    <div className="dash-page-enter">
      <header className="dash-page-header row">
        <div>
          <h1>Products</h1>
          <p>Add and manage products across your categories</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/* Exports carry the list's own filters, so "export what I'm
              looking at" is what actually happens. */}
          <ImportExportMenu
            resource="products"
            canImport={canManage}
            filters={{
              status:
                filter === "drafts"
                  ? "draft"
                  : filter === "published"
                    ? "published"
                    : undefined,
            }}
          />
          {canManage && (
            <button className="dash-btn dash-btn-primary" onClick={openCreate}>
              <Plus className="h-4 w-4" />
              New product
            </button>
          )}
        </div>
      </header>

      {categories.length === 0 && (
        <div className="dash-card mb-3.5 flex items-center gap-2 px-4 py-3.5 text-[13px]">
          <Lightbulb className="h-4 w-4 shrink-0 text-[var(--dash-amber)]" />
          <span>
            You have no categories yet. Products work without one, but{" "}
            <Link
              href="/dashboard/categories"
              className="font-semibold text-[var(--dash-accent)]"
            >
              create a category
            </Link>{" "}
            to group them on the storefront.
          </span>
        </div>
      )}

      <div className="dash-card flex flex-col" style={{ flex: "1 1 auto" }}>
        {/* Toolbar: Tabs + Category filter + Search - Now INSIDE the card */}
        <div className="dash-toolbar px-5 pt-4 pb-2 border-b border-[var(--dash-border)] mb-0 flex flex-col gap-4">
          <div className="dash-filter-tabs">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                className={`dash-filter-tab${filter === tab.key ? " active" : ""}`}
                onClick={() => go({ filter: tab.key })}
              >
                {tab.label}
                <span className="dash-tab-count">{tab.count}</span>
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
                <option value="uncategorized">Uncategorized</option>
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

        {products.length === 0 ? (
          <div className="dash-empty">
            <span className="dash-empty-icon">
              <Package className="h-5 w-5" />
            </span>
            <div className="dash-empty-title">
              {search || filter !== "all" || categoryFilter !== "all"
                ? "No products match your filters"
                : "No products yet"}
            </div>
            <p className="dash-empty-text">
              {search || filter !== "all" || categoryFilter !== "all"
                ? "Try adjusting your filters."
                : "Add your first product to get started."}
            </p>
            {!search &&
              filter === "all" &&
              categoryFilter === "all" &&
              canManage && (
                <button
                  className="dash-btn dash-btn-primary"
                  onClick={openCreate}
                >
                  <Plus className="h-4 w-4" />
                  New product
                </button>
              )}
          </div>
        ) : (
          <table className="dash-table dash-table-wide">
            <thead>
              <tr>
                {canManage && (
                  <th className="dash-checkbox-cell">
                    <SelectAllCheckbox
                      checked={selection.allSelected}
                      indeterminate={selection.someSelected}
                      onChange={selection.toggleAll}
                    />
                  </th>
                )}
                <th className="w-14">Image</th>
                <th>Name</th>
                <th>Category</th>
                <th>Price</th>
                <th>Variants</th>
                <th>Status</th>
                {canManage && <th className="dash-col-actions">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {products.map((p) => (
                <tr
                  key={p.id}
                  onClick={canManage ? () => openEdit(p) : undefined}
                  onMouseEnter={
                    canManage
                      ? () => router.prefetch(`/dashboard/products/${p.id}`)
                      : undefined
                  }
                  className={`${canManage ? "cursor-pointer" : ""}${
                    selection.isSelected(p.id) ? " is-selected" : ""
                  }`}
                  title={canManage ? "Edit product" : undefined}
                >
                  {canManage && (
                    <td
                      className="dash-col-actions dash-checkbox-cell"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <RowCheckbox
                        checked={selection.isSelected(p.id)}
                        onToggle={() => selection.toggle(p.id)}
                        label={`Select ${p.name}`}
                      />
                    </td>
                  )}
                  <td>
                    {p.image_url ? (
                      <div className="dash-thumb">
                        <Image
                          src={p.image_url}
                          alt={p.name}
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
                    <div className="dash-cell-title inline-flex items-center gap-1.5">
                      {p.name}
                      {p.featured && (
                        <Star
                          className="h-3.5 w-3.5 fill-[var(--dash-amber)] text-[var(--dash-amber)]"
                          aria-label="Featured"
                        />
                      )}
                    </div>
                    <div className="dash-cell-sub mono">/{p.slug}</div>
                  </td>
                  <td>
                    {p.category ? (
                      <div className="dash-chip-row">
                        <span className="dash-chip">{p.category.name}</span>
                      </div>
                    ) : (
                      <span className="text-dim">Uncategorized</span>
                    )}
                  </td>
                  <td>
                    {(() => {
                      const pricing = effectivePricing(p);
                      return (
                        <div className="flex flex-wrap items-center gap-1.5">
                          {pricing.hasVariants && (
                            <span className="text-dim text-xs">from</span>
                          )}
                          <span className="dash-cell-title mono">
                            {formatPrice(pricing.selling)}
                          </span>
                          {pricing.discount > 0 && (
                            <>
                              <span className="dash-cell-sub mono line-through">
                                {formatPrice(pricing.base)}
                              </span>
                              <span className="dash-badge dash-badge-green">
                                -{pricing.discount}%
                              </span>
                            </>
                          )}
                        </div>
                      );
                    })()}
                  </td>
                  <td>
                    {p.variants.length > 0 ? (
                      <span className="dash-badge dash-badge-grey">
                        {p.variants.length}{" "}
                        {p.variants.length === 1 ? "variant" : "variants"}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>
                    <span
                      className={`dash-badge ${
                        p.status === "published"
                          ? "dash-badge-green"
                          : "dash-badge-amber"
                      }`}
                    >
                      {p.status === "published" ? "Published" : "Draft"}
                    </span>
                  </td>
                  {canManage && (
                    <td
                      className="dash-col-actions"
                      onClick={(ev) => ev.stopPropagation()}
                    >
                      <DropdownMenu>
                        <DropdownMenuTrigger className="dash-row-menu">
                          <MoreHorizontal className="h-4 w-4" />
                          <span className="sr-only">Actions</span>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          align="end"
                          className="min-w-[180px]"
                        >
                          <DropdownMenuItem
                            className="cursor-pointer"
                            onClick={() => openEdit(p)}
                          >
                            <Pencil className="mr-2 h-4 w-4" />
                            Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="cursor-pointer"
                            onClick={() => handleTogglePublish(p)}
                            disabled={isPending}
                          >
                            {p.status === "published" ? (
                              <>
                                <Undo2 className="mr-2 h-4 w-4" />
                                Unpublish
                              </>
                            ) : (
                              <>
                                <Send className="mr-2 h-4 w-4" />
                                Publish
                              </>
                            )}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="cursor-pointer"
                            onClick={() =>
                              window.open(`/shop/${p.slug}`, "_blank")
                            }
                          >
                            <Eye className="mr-2 h-4 w-4" />
                            Preview
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            variant="destructive"
                            className="cursor-pointer"
                            onClick={() => setDeleteTarget(p)}
                          >
                            <Trash2 className="mr-2 h-4 w-4" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
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

      {/* Bulk action bar (appears while rows are selected) */}
      {canManage && (
        <BulkActionBar
          count={selection.count}
          onClear={selection.clear}
          busy={isPending}
        >
          <button
            type="button"
            className="dash-bulk-btn"
            disabled={isPending}
            onClick={() =>
              runBulk(
                () => bulkToggleProductPublish(selection.selectedIds, true),
                "Selected products published",
              )
            }
          >
            <Send className="h-4 w-4" />
            Publish
          </button>
          <button
            type="button"
            className="dash-bulk-btn"
            disabled={isPending}
            onClick={() =>
              runBulk(
                () => bulkToggleProductPublish(selection.selectedIds, false),
                "Selected products unpublished",
              )
            }
          >
            <Undo2 className="h-4 w-4" />
            Unpublish
          </button>
          <button
            type="button"
            className="dash-bulk-btn"
            disabled={isPending}
            onClick={() =>
              runBulk(
                () => bulkSetProductFeatured(selection.selectedIds, true),
                "Selected products featured",
              )
            }
          >
            <Star className="h-4 w-4" />
            Feature
          </button>
          <button
            type="button"
            className="dash-bulk-btn"
            disabled={isPending}
            onClick={() =>
              runBulk(
                () => bulkSetProductFeatured(selection.selectedIds, false),
                "Selected products unfeatured",
              )
            }
          >
            <Star className="h-4 w-4" />
            Unfeature
          </button>
          <button
            type="button"
            className="dash-bulk-btn dash-bulk-btn-danger"
            disabled={isPending}
            onClick={() => setBulkDeleteOpen(true)}
          >
            <Trash2 className="h-4 w-4" />
            Delete
          </button>
        </BulkActionBar>
      )}

      {/* Bulk delete confirmation */}
      <Dialog
        open={bulkDeleteOpen}
        onOpenChange={(open) => !open && setBulkDeleteOpen(false)}
      >
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>
              Delete {selection.count} product
              {selection.count === 1 ? "" : "s"}
            </DialogTitle>
            <DialogDescription>
              This permanently deletes the selected product
              {selection.count === 1 ? "" : "s"}, their variants and images.
              This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setBulkDeleteOpen(false)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={isPending}
              onClick={() =>
                runBulk(
                  () => bulkDeleteProducts(selection.selectedIds),
                  `Deleted ${selection.count} product${selection.count === 1 ? "" : "s"}`,
                )
              }
            >
              {isPending ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>Delete product</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete &ldquo;{deleteTarget?.name}
              &rdquo;? This also removes its variants and cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteTarget(null)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={isPending}
            >
              {isPending ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
