"use client";

import { useEffect, useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import {
  RotateCcw,
  Search,
  Settings,
  ShoppingBag,
  CircleSlash,
  Globe2,
  Store,
} from "lucide-react";
import { formatPrice } from "@/lib/pricing";
import { ListPagination } from "@/app/dashboard/components/list-pagination";
import { ImportExportMenu } from "@/app/dashboard/components/import-export-menu";
import type {
  OrderChannel,
  OrderChannelCounts,
  OrderStatusCounts,
} from "@/app/actions/order-actions";
import type { OrderRow } from "./page";
import { OrderDetailDrawer } from "./order-detail-drawer";
import { PickupBadge, isPickupOrder, pickupStageLabel } from "./pickup-badge";

type Props = {
  orders: OrderRow[];
  total: number;
  counts: OrderStatusCounts;
  channelCounts: OrderChannelCounts;
  page: number;
  pageSize: number;
  query: string;
  status: string;
  paymentStatus: string;
  paymentMethod: string;
  dateRange: string;
  channel: OrderChannel;
  supportsPos: boolean;
};

type StatusTab = {
  key: string;
  label: string;
  countKeys: (keyof OrderStatusCounts)[];
};

// Order-lifecycle tabs (the primary saved views). "" = All. The combined
// book groups lifecycle states into the cross-channel vocabulary in the ref.
const ALL_STATUS_TABS: StatusTab[] = [
  { key: "", label: "All", countKeys: ["all"] },
  { key: "attention", label: "Needs attention", countKeys: ["pending"] },
  { key: "open", label: "Open", countKeys: ["processing", "shipped"] },
  {
    key: "completed",
    label: "Completed",
    countKeys: ["delivered", "completed"],
  },
];

const WEBSITE_STATUS_TABS: StatusTab[] = [
  { key: "", label: "All", countKeys: ["all"] },
  { key: "pending", label: "Pending", countKeys: ["pending"] },
  { key: "processing", label: "Processing", countKeys: ["processing"] },
  { key: "shipped", label: "Shipped", countKeys: ["shipped"] },
  { key: "delivered", label: "Delivered", countKeys: ["delivered"] },
  { key: "cancelled", label: "Cancelled", countKeys: ["cancelled"] },
];

const POS_STATUS_TABS: StatusTab[] = [
  { key: "", label: "All", countKeys: ["all"] },
  { key: "completed", label: "Completed", countKeys: ["completed"] },
  { key: "cancelled", label: "Cancelled", countKeys: ["cancelled"] },
];

const CHANNEL_COPY: Record<
  OrderChannel,
  { title: string; description: string }
> = {
  all: {
    title: "All orders",
    description: "Search and manage orders across every sales channel",
  },
  website: {
    title: "Website orders",
    description: "Orders placed through your online storefront",
  },
  pos: {
    title: "POS orders",
    description: "Completed in-person sales, payments and customer history",
  },
};

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
  completed: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  cancelled: "bg-rose-50 text-rose-700 ring-rose-600/20",
};
const PAY_TONE: Record<string, string> = {
  paid: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  pending: "bg-amber-50 text-amber-700 ring-amber-600/20",
  failed: "bg-rose-50 text-rose-700 ring-rose-600/20",
  refunded: "bg-slate-100 text-slate-700 ring-slate-500/20",
  partially_refunded: "bg-violet-50 text-violet-700 ring-violet-600/20",
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
  if (m === "cash_on_delivery" || m === "cod") return "COD";
  if (m === "razorpay") return "Online";
  // Was falling through to the raw enum, so a collection order's payment read
  // "pay_at_store" in the list.
  if (m === "pay_at_store") return "Pay at store";
  if (m === "store_credit") return "Store credit";
  if (m === "cash") return "Cash";
  if (m === "card") return "Card";
  if (m === "upi") return "UPI";
  if (m === "split") return "Split tender";
  return m;
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
  channelCounts,
  page,
  pageSize,
  query,
  status,
  paymentStatus,
  paymentMethod,
  dateRange,
  channel,
  supportsPos,
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
    channel?: OrderChannel;
    page?: number;
  }): string => {
    const q = (next.q ?? query).trim();
    const st = next.status ?? status;
    const pay = next.payment ?? paymentStatus;
    const method = next.method ?? paymentMethod;
    const date = next.date ?? dateRange;
    const orderChannel = next.channel ?? channel;
    const changedFacet =
      next.q !== undefined ||
      next.status !== undefined ||
      next.payment !== undefined ||
      next.method !== undefined ||
      next.date !== undefined ||
      next.channel !== undefined;
    const p = next.page ?? (changedFacet ? 1 : page);

    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (st) params.set("status", st);
    if (pay) params.set("payment", pay);
    if (method) params.set("method", method);
    if (date) params.set("date", date);
    if (supportsPos && orderChannel !== "all") {
      params.set("channel", orderChannel);
    }
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

  const statusTabs = !supportsPos
    ? WEBSITE_STATUS_TABS
    : channel === "all"
      ? ALL_STATUS_TABS
      : channel === "pos"
        ? POS_STATUS_TABS
        : WEBSITE_STATUS_TABS;
  const channelCopy = supportsPos
    ? CHANNEL_COPY[channel]
    : {
        title: "Orders",
        description: "View and manage all customer orders",
      };

  const switchChannel = (next: OrderChannel) => {
    if (next === channel) return;
    go({
      channel: next,
      status: "",
      payment: "",
      method: "",
      page: 1,
    });
  };

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
              <h1>{channelCopy.title}</h1>
              <p>{channelCopy.description}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {/* Export only — orders can never be imported. See the note on
                  ORDER_COLUMNS in lib/import-export/resources.ts. */}
              <ImportExportMenu
                resource="orders"
                filters={supportsPos ? { status, channel } : { status }}
              />
              <Link
                href="/dashboard/orders/returns"
                className="dash-btn dash-btn-ghost"
              >
                <RotateCcw className="h-4 w-4" />
                Returns
              </Link>
              <Link
                href="/dashboard/orders/cancellations"
                className="dash-btn dash-btn-ghost"
              >
                <CircleSlash className="h-4 w-4" />
                Cancellations
              </Link>
              <Link
                href="/dashboard/orders/settings"
                className="dash-btn dash-btn-ghost"
              >
                <Settings className="h-4 w-4" />
                Settings
              </Link>
              {supportsPos && channel === "pos" && (
                <Link href="/pos/sell" className="dash-btn dash-btn-primary">
                  <Store className="h-4 w-4" />
                  Open POS
                </Link>
              )}
            </div>
          </header>

          <div className="dash-card flex flex-col" style={{ flex: "1 1 auto" }}>
            {/* POS-enabled stores get the omnichannel workspace. Lower plans
                and stores that have POS switched off keep the original Orders
                page, with no empty/teasing channel navigation. */}
            {supportsPos && (
              <div className="grid grid-cols-3 border-b border-[var(--dash-border)] bg-[var(--dash-surface-2)]/55 p-1.5">
                <button
                  type="button"
                  aria-pressed={channel === "all"}
                  onClick={() => switchChannel("all")}
                  className={`flex min-w-0 items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-sm font-semibold transition-colors ${
                    channel === "all"
                      ? "bg-[var(--dash-surface)] text-[var(--dash-text)] shadow-sm ring-1 ring-[var(--dash-border)]"
                      : "text-[var(--dash-text-2)] hover:text-[var(--dash-text)]"
                  }`}
                >
                  <ShoppingBag className="h-4 w-4 shrink-0" />
                  <span className="truncate">All orders</span>
                  <span className="rounded-full bg-[var(--dash-surface-2)] px-2 py-0.5 text-[11px] tabular-nums text-[var(--dash-text-2)]">
                    {channelCounts.all}
                  </span>
                </button>
                <button
                  type="button"
                  aria-pressed={channel === "website"}
                  onClick={() => switchChannel("website")}
                  className={`flex min-w-0 items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-sm font-semibold transition-colors ${
                    channel === "website"
                      ? "bg-[var(--dash-surface)] text-[var(--dash-text)] shadow-sm ring-1 ring-[var(--dash-border)]"
                      : "text-[var(--dash-text-2)] hover:text-[var(--dash-text)]"
                  }`}
                >
                  <Globe2 className="h-4 w-4 shrink-0" />
                  <span className="truncate">Website orders</span>
                  <span className="rounded-full bg-[var(--dash-surface-2)] px-2 py-0.5 text-[11px] tabular-nums text-[var(--dash-text-2)]">
                    {channelCounts.website}
                  </span>
                </button>
                <button
                  type="button"
                  aria-pressed={channel === "pos"}
                  onClick={() => switchChannel("pos")}
                  className={`flex min-w-0 items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-sm font-semibold transition-colors ${
                    channel === "pos"
                      ? "bg-[var(--dash-surface)] text-[var(--dash-text)] shadow-sm ring-1 ring-[var(--dash-border)]"
                      : "text-[var(--dash-text-2)] hover:text-[var(--dash-text)]"
                  }`}
                >
                  <Store className="h-4 w-4 shrink-0" />
                  <span className="truncate">POS orders</span>
                  <span className="rounded-full bg-[var(--dash-surface-2)] px-2 py-0.5 text-[11px] tabular-nums text-[var(--dash-text-2)]">
                    {channelCounts.pos}
                  </span>
                </button>
              </div>
            )}

            {/* Toolbar: channel-specific status tabs + shared facets/search. */}
            <div className="dash-toolbar px-5 pt-4 pb-2 border-b border-[var(--dash-border)] mb-0 flex flex-col gap-4">
              <div className="dash-filter-tabs">
                {statusTabs.map((tab) => (
                  <button
                    key={tab.key || "all"}
                    className={`dash-filter-tab${status === tab.key ? " active" : ""}`}
                    onClick={() => go({ status: tab.key })}
                  >
                    {tab.label}
                    <span className="dash-tab-count">
                      {tab.countKeys.reduce((sum, key) => sum + counts[key], 0)}
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
                    {/* Derived by the refund machinery (order-actions'
                        PAYMENT_STATUSES). They are FILTERABLE but not
                        settable — and without them here a merchant cannot
                        find their own refunded orders, which is the whole
                        reason that list was split. */}
                    <option value="refunded">Refunded</option>
                    <option value="partially_refunded">
                      Partially refunded
                    </option>
                  </select>
                  <select
                    value={paymentMethod}
                    onChange={(e) => go({ method: e.target.value })}
                    className={selectClass}
                    aria-label="Filter by payment method"
                  >
                    <option value="">All methods</option>
                    {channel === "website" ? (
                      <>
                        <option value="cash_on_delivery">COD</option>
                        <option value="pay_at_store">Pay at store</option>
                        <option value="razorpay">Online (Razorpay)</option>
                      </>
                    ) : channel === "pos" ? (
                      <>
                        <option value="cash">Cash</option>
                        <option value="card">Card</option>
                        <option value="upi">UPI</option>
                        <option value="razorpay">Online (Razorpay)</option>
                        <option value="store_credit">Store credit</option>
                        <option value="split">Split tender</option>
                      </>
                    ) : (
                      <>
                        <option value="cash_on_delivery">COD</option>
                        <option value="pay_at_store">Pay at store</option>
                        <option value="cash">Cash</option>
                        <option value="card">Card</option>
                        <option value="upi">UPI</option>
                        <option value="razorpay">Online (Razorpay)</option>
                        <option value="store_credit">Store credit</option>
                        <option value="split">Split tender</option>
                      </>
                    )}
                  </select>
                </div>

                <label className="dash-search-bar">
                  <Search className="h-4 w-4 shrink-0 opacity-50" />
                  <input
                    type="text"
                    placeholder={
                      !supportsPos
                        ? "Search orders…"
                        : channel === "all"
                          ? "Order, receipt or customer…"
                          : channel === "pos"
                            ? "Receipt, customer, location…"
                            : "Order or customer…"
                    }
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
                    : !supportsPos
                      ? "No orders yet"
                      : channel === "all"
                        ? "No orders yet"
                        : channel === "pos"
                          ? "No POS orders yet"
                          : "No website orders yet"}
                </div>
                <p className="dash-empty-text">
                  {hasFilters
                    ? "Try adjusting your filters."
                    : !supportsPos
                      ? "No orders have been placed yet."
                      : channel === "all"
                        ? "Website orders and register sales will appear here."
                        : channel === "pos"
                          ? "Sales completed at the register will appear here."
                          : "Orders placed through your website will appear here."}
                </p>
              </div>
            ) : (
              <table className="dash-table dash-table-wide">
                <thead>
                  <tr>
                    <th>{channel === "pos" ? "Receipt" : "Order"}</th>
                    {channel === "all" && <th>Channel</th>}
                    <th>Customer</th>
                    {channel === "pos" && <th>Location</th>}
                    <th>Date</th>
                    <th className="text-right">Total</th>
                    {channel !== "all" && <th>Payment</th>}
                    <th>
                      {channel === "all"
                        ? "Next step"
                        : channel === "pos"
                          ? "Sale"
                          : supportsPos
                            ? "Fulfillment"
                            : "Status"}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((order) => {
                    const isPos = order.sales_channel === "pos";
                    const websiteCustomer =
                      `${order.shipping_address?.firstName || ""} ${order.shipping_address?.lastName || ""}`.trim();
                    const posCustomer =
                      `${order.customer_first_name || ""} ${order.customer_last_name || ""}`.trim();
                    const customerName = isPos ? posCustomer : websiteCustomer;
                    const customerMeta = isPos
                      ? order.customer_phone ||
                        order.customer_email ||
                        "No customer attached"
                      : [
                          order.shipping_address?.city,
                          order.shipping_address?.state,
                        ]
                          .filter(Boolean)
                          .join(", ");
                    const orderLabel = isPos
                      ? order.receipt_no || order.order_ref
                      : order.order_ref;
                    const allOrderMeta = isPos
                      ? ["POS", order.location_name].filter(Boolean).join(" · ")
                      : isPickupOrder(order)
                        ? ["Pickup", order.location_name]
                            .filter(Boolean)
                            .join(" · ")
                        : "Standard shipping";
                    const nextStep =
                      !isPos && isPickupOrder(order) && order.pickup_status
                        ? pickupStageLabel(order.pickup_status)
                        : !isPos && order.status === "pending"
                          ? "Ready to fulfill"
                          : order.status;
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
                          <div className="flex flex-col items-start gap-1">
                            {orderLabel}
                            {channel === "all" ? (
                              <span className="font-sans text-[11px] font-normal text-[var(--dash-text-3)]">
                                {allOrderMeta}
                              </span>
                            ) : isPos ? (
                              order.receipt_no && (
                                <span className="font-sans text-[11px] font-normal text-[var(--dash-text-3)]">
                                  {order.order_ref}
                                </span>
                              )
                            ) : (
                              isPickupOrder(order) && <PickupBadge />
                            )}
                          </div>
                        </td>
                        {channel === "all" && (
                          <td>
                            <span
                              className={`inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-xs font-medium ${
                                isPos
                                  ? "bg-slate-100 text-slate-700"
                                  : "bg-blue-50 text-blue-700"
                              }`}
                            >
                              <span
                                className={`h-1.5 w-1.5 rounded-full ${
                                  isPos ? "bg-slate-400" : "bg-blue-400"
                                }`}
                              />
                              {isPos ? "POS" : "Website"}
                            </span>
                          </td>
                        )}
                        <td>
                          <div className="flex items-center gap-2.5">
                            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--dash-surface-2)] text-[11px] font-semibold text-[var(--dash-text-2)]">
                              {initials(customerName)}
                            </span>
                            <div className="min-w-0">
                              <div className="truncate font-medium text-gray-900">
                                {customerName ||
                                  (isPos ? "Walk-in" : "Unknown")}
                              </div>
                              <div className="truncate text-xs text-[var(--dash-text-3)]">
                                {customerMeta}
                              </div>
                            </div>
                          </div>
                        </td>
                        {channel === "pos" && (
                          <td>
                            <div className="max-w-[150px] truncate font-medium text-gray-900">
                              {order.location_name || "Unknown location"}
                            </div>
                            <div className="max-w-[150px] truncate text-xs text-[var(--dash-text-3)]">
                              {order.cashier_name
                                ? `By ${order.cashier_name}`
                                : "Cashier not recorded"}
                            </div>
                          </td>
                        )}
                        <td className="whitespace-nowrap text-xs">
                          {fmtListDate(order.created_at)}
                        </td>
                        <td className="text-right font-medium tabular-nums text-gray-900">
                          {formatPrice(order.total)}
                        </td>
                        {channel !== "all" && (
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
                        )}
                        <td>
                          <div className="flex flex-col items-start gap-0.5">
                            <Pill
                              value={
                                channel === "all" ? nextStep : order.status
                              }
                              tone={STATUS_TONE[order.status]}
                            />
                            {/* The collection stage, where "processing" alone
                                doesn't say whether it's packed or gone. */}
                            {channel === "website" &&
                              isPickupOrder(order) &&
                              order.pickup_status && (
                                <span className="text-[11px] text-[var(--dash-text-3)]">
                                  {pickupStageLabel(order.pickup_status)}
                                </span>
                              )}
                          </div>
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
