"use client";

import { useEffect, useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { RotateCcw, Search, Settings, ShoppingBag } from "lucide-react";
import { formatPrice } from "@/lib/pricing";
import { ListPagination } from "@/app/dashboard/components/list-pagination";
import type { OrderStatusCounts } from "@/app/actions/order-actions";
import type { OrderRow } from "./page";
import { OrderDetailDrawer } from "./order-detail-drawer";

type Props = {
  orders: OrderRow[];
  total: number;
  counts: OrderStatusCounts;
  page: number;
  pageSize: number;
  query: string;
  status: string;
  paymentStatus: string;
  paymentMethod: string;
  dateRange: string;
};

// Order-lifecycle tabs (the primary Shopify-style saved views). "" = All.
const STATUS_TABS: {
  key: string;
  label: string;
  countKey: keyof OrderStatusCounts;
}[] = [
  { key: "", label: "All", countKey: "all" },
  { key: "pending", label: "Pending", countKey: "pending" },
  { key: "processing", label: "Processing", countKey: "processing" },
  { key: "shipped", label: "Shipped", countKey: "shipped" },
  { key: "delivered", label: "Delivered", countKey: "delivered" },
  { key: "cancelled", label: "Cancelled", countKey: "cancelled" },
];

const DATE_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "All time" },
  { value: "today", label: "Today" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
];

const STATUS_TONE: Record<string, string> = {
  pending: "bg-amber-50 text-amber-700 ring-amber-600/20",
  processing: "bg-blue-50 text-blue-700 ring-blue-600/20",
  shipped: "bg-indigo-50 text-indigo-700 ring-indigo-600/20",
  delivered: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  cancelled: "bg-rose-50 text-rose-700 ring-rose-600/20",
};
const PAY_TONE: Record<string, string> = {
  paid: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  pending: "bg-amber-50 text-amber-700 ring-amber-600/20",
  failed: "bg-rose-50 text-rose-700 ring-rose-600/20",
};

function Pill({ value, tone }: { value: string; tone?: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize ring-1 ring-inset ${
        tone ?? "bg-gray-100 text-gray-700 ring-gray-500/20"
      }`}
    >
      {value}
    </span>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function methodLabel(m: string): string {
  return m === "cash_on_delivery" ? "COD" : m === "razorpay" ? "Online" : m;
}

// Deterministic date for the SSR'd table: pin BOTH locale and timezone so the
// server and the browser render the IDENTICAL string. `toLocaleDateString`
// otherwise uses each runtime's default locale (US on the server → "Jul 21,
// 2026", en-GB in the browser → "21 Jul 2026") and default timezone (UTC on
// Cloud Run vs the visitor's), which trips React hydration. Asia/Kolkata is the
// India-first default until per-store timezones exist.
function fmtListDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  });
}

export function OrdersManagementView({
  orders,
  total,
  counts,
  page,
  pageSize,
  query,
  status,
  paymentStatus,
  paymentMethod,
  dateRange,
}: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const [navigating, startNavigation] = useTransition();
  const [search, setSearch] = useState(query);
  const [selected, setSelected] = useState<OrderRow | null>(null);

  // Build a URL with the merged facet state. Changing any facet resets to
  // page 1 (a filtered result set has its own paging).
  const hrefFor = (next: {
    q?: string;
    status?: string;
    payment?: string;
    method?: string;
    date?: string;
    page?: number;
  }): string => {
    const q = (next.q ?? query).trim();
    const st = next.status ?? status;
    const pay = next.payment ?? paymentStatus;
    const method = next.method ?? paymentMethod;
    const date = next.date ?? dateRange;
    const changedFacet =
      next.q !== undefined ||
      next.status !== undefined ||
      next.payment !== undefined ||
      next.method !== undefined ||
      next.date !== undefined;
    const p = next.page ?? (changedFacet ? 1 : page);

    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (st) params.set("status", st);
    if (pay) params.set("payment", pay);
    if (method) params.set("method", method);
    if (date) params.set("date", date);
    if (p > 1) params.set("page", String(p));
    const qs = params.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  };

  const go = (next: Parameters<typeof hrefFor>[0]) =>
    startNavigation(() => router.push(hrefFor(next)));

  // Debounce free-text search into the URL (server re-queries).
  useEffect(() => {
    if (search.trim() === query.trim()) return;
    const handle = setTimeout(() => {
      startNavigation(() => router.push(hrefFor({ q: search })));
    }, 400);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const hasFilters = Boolean(
    query || status || paymentStatus || paymentMethod || dateRange,
  );

  const selectClass =
    "rounded-md border border-[var(--dash-border)] bg-[var(--dash-surface)] px-3 py-[7px] text-[13px] text-[var(--dash-text)] outline-none";

  return (
    <div className="dash-page-enter">
      {/* Two-pane: the list shifts left and the detail panel docks on the right
          (a real column, not an overlay) when an order is open. */}
      <div className="flex items-start gap-4">
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="dash-page-header row">
            <div>
              <h1>Orders</h1>
              <p>View and manage all customer orders</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Link
                href="/dashboard/orders/returns"
                className="dash-btn dash-btn-ghost"
              >
                <RotateCcw className="h-4 w-4" />
                Returns
              </Link>
              <Link
                href="/dashboard/orders/settings"
                className="dash-btn dash-btn-ghost"
              >
                <Settings className="h-4 w-4" />
                Settings
              </Link>
            </div>
          </header>

          <div className="dash-card flex flex-col" style={{ flex: "1 1 auto" }}>
            {/* Toolbar: status tabs + date/payment facets + search */}
            <div className="dash-toolbar px-5 pt-4 pb-2 border-b border-[var(--dash-border)] mb-0 flex flex-col gap-4">
              <div className="dash-filter-tabs">
                {STATUS_TABS.map((tab) => (
                  <button
                    key={tab.key || "all"}
                    className={`dash-filter-tab${status === tab.key ? " active" : ""}`}
                    onClick={() => go({ status: tab.key })}
                  >
                    {tab.label}
                    <span className="dash-tab-count">
                      {counts[tab.countKey]}
                    </span>
                  </button>
                ))}
              </div>

              <div className="dash-toolbar-actions flex w-full flex-wrap justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    value={dateRange}
                    onChange={(e) => go({ date: e.target.value })}
                    className={selectClass}
                    aria-label="Filter by date"
                  >
                    {DATE_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <select
                    value={paymentStatus}
                    onChange={(e) => go({ payment: e.target.value })}
                    className={selectClass}
                    aria-label="Filter by payment status"
                  >
                    <option value="">All payments</option>
                    <option value="paid">Paid</option>
                    <option value="pending">Payment pending</option>
                    <option value="failed">Payment failed</option>
                  </select>
                  <select
                    value={paymentMethod}
                    onChange={(e) => go({ method: e.target.value })}
                    className={selectClass}
                    aria-label="Filter by payment method"
                  >
                    <option value="">All methods</option>
                    <option value="cash_on_delivery">COD</option>
                    <option value="razorpay">Online (Razorpay)</option>
                  </select>
                </div>

                <label className="dash-search-bar">
                  <Search className="h-4 w-4 shrink-0 opacity-50" />
                  <input
                    type="text"
                    placeholder="Search orders…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </label>
              </div>
            </div>

            {orders.length === 0 ? (
              <div className="dash-empty">
                <span className="dash-empty-icon">
                  <ShoppingBag className="h-5 w-5" />
                </span>
                <div className="dash-empty-title">
                  {hasFilters
                    ? "No orders match your filters"
                    : "No orders yet"}
                </div>
                <p className="dash-empty-text">
                  {hasFilters
                    ? "Try adjusting your filters."
                    : "No orders have been placed yet."}
                </p>
              </div>
            ) : (
              <table className="dash-table dash-table-wide">
                <thead>
                  <tr>
                    <th>Order</th>
                    <th>Customer</th>
                    <th>Date</th>
                    <th className="text-right">Total</th>
                    <th>Payment</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((order) => {
                    const customerName =
                      `${order.shipping_address?.firstName || ""} ${order.shipping_address?.lastName || ""}`.trim();
                    return (
                      <tr
                        key={order.id}
                        onClick={() => setSelected(order)}
                        className={`cursor-pointer${selected?.id === order.id ? " bg-[var(--dash-surface-2)]" : ""}`}
                        title="View order"
                      >
                        <td
                          className="font-mono text-sm font-semibold text-gray-900"
                          title={order.id}
                        >
                          {order.order_ref}
                        </td>
                        <td>
                          <div className="flex items-center gap-2.5">
                            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--dash-surface-2)] text-[11px] font-semibold text-[var(--dash-text-2)]">
                              {initials(customerName)}
                            </span>
                            <div className="min-w-0">
                              <div className="truncate font-medium text-gray-900">
                                {customerName || "Unknown"}
                              </div>
                              <div className="truncate text-xs text-[var(--dash-text-3)]">
                                {[
                                  order.shipping_address?.city,
                                  order.shipping_address?.state,
                                ]
                                  .filter(Boolean)
                                  .join(", ")}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="whitespace-nowrap text-xs">
                          {fmtListDate(order.created_at)}
                        </td>
                        <td className="text-right font-medium tabular-nums text-gray-900">
                          {formatPrice(order.total)}
                        </td>
                        <td>
                          <div className="flex flex-col items-start gap-0.5">
                            <Pill
                              value={order.payment_status}
                              tone={PAY_TONE[order.payment_status]}
                            />
                            <span className="text-[11px] text-[var(--dash-text-3)]">
                              {methodLabel(order.payment_method)}
                            </span>
                          </div>
                        </td>
                        <td>
                          <Pill
                            value={order.status}
                            tone={STATUS_TONE[order.status]}
                          />
                        </td>
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
              onPage={(p) => go({ page: p })}
            />
          </div>
        </div>

        {selected && (
          <aside className="sticky top-2 w-[380px] shrink-0 self-start xl:w-[420px]">
            <OrderDetailDrawer
              orderId={selected.id}
              orderRef={selected.order_ref}
              onClose={() => setSelected(null)}
              onChanged={() => router.refresh()}
            />
          </aside>
        )}
      </div>
    </div>
  );
}
