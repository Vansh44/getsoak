"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import {
  Lock,
  Mail,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Ticket,
  Trash2,
} from "lucide-react";
import { ListPagination } from "../../components/list-pagination";
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
import { Switch } from "@/components/ui/switch";
import {
  deleteCoupon,
  toggleCouponVisibility,
} from "@/app/actions/coupon-actions";
import { saveStoreSettings } from "@/app/actions/store-settings";
import { ImportExportMenu } from "@/app/dashboard/components/import-export-menu";
import type { Coupon, CouponGroup } from "./page";

const BASE = "/dashboard/marketing/coupons";

type Props = {
  coupons: Coupon[];
  groups: CouponGroup[];
  canManage?: boolean;
  total: number;
  page: number;
  pageSize: number;
  query: string;
  showAllCoupons?: boolean;
};

function formatDiscount(c: Coupon): string {
  return c.discount_type === "percentage"
    ? `${c.discount_value}% off`
    : `₹${c.discount_value.toLocaleString("en-IN")} off`;
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

// A coupon is effectively unusable when disabled, past its end date, or capped.
function isExpired(c: Coupon): boolean {
  if (c.valid_until && new Date(c.valid_until).getTime() < Date.now())
    return true;
  if (c.max_uses > 0 && c.used_count >= c.max_uses) return true;
  return false;
}

export function CouponsManagementView({
  coupons,
  groups,
  canManage = true,
  total,
  page,
  pageSize,
  query,
  showAllCoupons = false,
}: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const groupName = useMemo(
    () => new Map(groups.map((g) => [g.id, g.name])),
    [groups],
  );
  const [isPending, startTransition] = useTransition();
  const [navigating, startNavigation] = useTransition();
  const [search, setSearch] = useState(query);
  const [deleteTarget, setDeleteTarget] = useState<Coupon | null>(null);

  const hrefFor = (next: { q?: string; page?: number }): string => {
    const q = (next.q ?? query).trim();
    const p = next.page ?? (next.q !== undefined ? 1 : page);
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (p > 1) params.set("page", String(p));
    const qs = params.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  };

  // Debounce the search box → URL; the server returns the matching page.
  useEffect(() => {
    if (search.trim() === query.trim()) return;
    const handle = setTimeout(() => {
      startNavigation(() => router.push(hrefFor({ q: search })));
    }, 400);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const handleDelete = () => {
    if (!deleteTarget) return;
    startTransition(async () => {
      const result = await deleteCoupon(deleteTarget.id);
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success("Coupon deleted");
        setDeleteTarget(null);
        router.refresh();
      }
    });
  };

  return (
    <div className="dash-page-enter">
      <header className="dash-page-header row">
        <div>
          <h1>Coupons</h1>
          <p>Create and manage storefront discount codes</p>
        </div>
        <div className="flex items-center gap-4 shrink-0">
          {canManage && (
            <label className="flex items-center gap-2 text-sm font-medium text-[#1f2937]">
              <Switch
                checked={showAllCoupons}
                onCheckedChange={(checked) => {
                  startTransition(async () => {
                    const result = await saveStoreSettings({
                      "marketing.showAllCoupons": checked,
                    });
                    if (result.error) toast.error(result.error);
                    else
                      toast.success(
                        checked
                          ? "All coupons shown on storefront"
                          : "Storefront coupon discovery disabled",
                      );
                  });
                }}
                disabled={isPending}
              />
              Show all on storefront
            </label>
          )}
          <ImportExportMenu resource="coupons" canImport={canManage} />
          {canManage && (
            <Link href={`${BASE}/new`} className="dash-btn dash-btn-primary">
              <Plus className="h-4 w-4" />
              New coupon
            </Link>
          )}
        </div>
      </header>

      <div className="dash-toolbar">
        <div className="dash-toolbar-actions ml-auto">
          <label className="dash-search-bar">
            <Search className="h-4 w-4 shrink-0 opacity-50" />
            <input
              type="text"
              placeholder="Search coupons..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
        </div>
      </div>

      <div className="dash-card">
        <div className="dash-card-header">
          <div>
            <div className="dash-card-title">Coupons</div>
            <div className="dash-card-sub">
              {total} {total === 1 ? "coupon" : "coupons"}
              {navigating ? " · updating…" : ""}
            </div>
          </div>
        </div>

        {coupons.length === 0 ? (
          <div className="dash-empty">
            <span className="dash-empty-icon">
              <Ticket className="h-5 w-5" />
            </span>
            <div className="dash-empty-title">
              {search ? "No coupons match your search" : "No coupons yet"}
            </div>
            <p className="dash-empty-text">
              {search
                ? "Try a different search term."
                : "Create your first discount code for the storefront."}
            </p>
            {!search && canManage && (
              <Link href={`${BASE}/new`} className="dash-btn dash-btn-primary">
                <Plus className="h-4 w-4" />
                New coupon
              </Link>
            )}
          </div>
        ) : (
          <table className="dash-table dash-table-wide">
            <thead>
              <tr>
                <th>Code</th>
                <th>Discount</th>
                <th>Min order</th>
                <th>Usage</th>
                <th>Validity</th>
                <th>Status</th>
                <th>Storefront</th>
                {canManage && <th className="dash-col-actions">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {coupons.map((c) => {
                const expired = isExpired(c);
                return (
                  <tr key={c.id}>
                    <td>
                      <div className="dash-cell-title mono">{c.code}</div>
                      {c.description && (
                        <div className="dash-cell-sub">{c.description}</div>
                      )}
                      {c.restricted_group_ids.length > 0 && (
                        <div className="dash-cell-sub mt-1 flex flex-wrap items-center gap-1">
                          <Lock className="h-3 w-3 text-[#9ca3af]" />
                          {c.restricted_group_ids
                            .map((id) => groupName.get(id))
                            .filter(Boolean)
                            .join(", ") || "Restricted"}
                        </div>
                      )}
                    </td>
                    <td>
                      <div className="dash-cell-title">{formatDiscount(c)}</div>
                    </td>
                    <td className="text-muted">
                      {c.min_order_amount > 0
                        ? `₹${c.min_order_amount.toLocaleString("en-IN")}`
                        : "—"}
                    </td>
                    <td className="text-dim font-mono-dash">
                      {c.used_count}
                      {c.max_uses > 0 ? ` / ${c.max_uses}` : " / ∞"}
                    </td>
                    <td className="text-muted">
                      {c.valid_from || c.valid_until
                        ? `${formatDate(c.valid_from)} → ${formatDate(c.valid_until)}`
                        : "Always"}
                    </td>
                    <td>
                      <span
                        className={`dash-badge ${
                          c.status === "active" && !expired
                            ? "dash-badge-green"
                            : c.status === "active" && expired
                              ? "dash-badge-amber"
                              : "dash-badge-grey"
                        }`}
                      >
                        {c.status !== "active"
                          ? "Disabled"
                          : expired
                            ? "Expired"
                            : "Active"}
                      </span>
                    </td>
                    <td>
                      <Switch
                        checked={c.show_on_storefront}
                        onCheckedChange={(checked) => {
                          startTransition(async () => {
                            const result = await toggleCouponVisibility(
                              c.id,
                              checked,
                            );
                            if (result.error) toast.error(result.error);
                            else toast.success("Storefront visibility updated");
                          });
                        }}
                        disabled={isPending || !canManage}
                      />
                    </td>
                    {canManage && (
                      <td className="dash-col-actions">
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
                              onClick={() =>
                                router.push(`${BASE}/${c.id}/edit`)
                              }
                            >
                              <Pencil className="mr-2 h-4 w-4" />
                              Edit
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              className="cursor-pointer"
                              onClick={() =>
                                router.push(`${BASE}/${c.id}/email`)
                              }
                            >
                              <Mail className="mr-2 h-4 w-4" />
                              Send email
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              variant="destructive"
                              className="cursor-pointer"
                              onClick={() => setDeleteTarget(c)}
                            >
                              <Trash2 className="mr-2 h-4 w-4" />
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        <ListPagination
          page={page}
          total={total}
          pageSize={pageSize}
          busy={navigating}
          onPage={(p) =>
            startNavigation(() => router.push(hrefFor({ page: p })))
          }
        />
      </div>

      {/* Delete Confirmation */}
      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>Delete coupon</DialogTitle>
            <DialogDescription>
              Delete &ldquo;{deleteTarget?.code}&rdquo;? Shoppers will no longer
              be able to apply this code. This can&rsquo;t be undone.
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
