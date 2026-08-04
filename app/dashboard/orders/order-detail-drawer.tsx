"use client";

import {
  useCallback,
  useEffect,
  useState,
  useTransition,
  type ReactNode,
} from "react";
import Link from "next/link";
import Image from "next/image";
import { toast } from "sonner";
import {
  CheckCircle2,
  Circle,
  Clock,
  CreditCard,
  FileText,
  ImageIcon,
  Loader2,
  MapPin,
  Package,
  Truck,
  X,
  XCircle,
} from "lucide-react";
import { formatPrice } from "@/lib/pricing";
import {
  getOrderDetail,
  updateOrderStatus,
  type OrderDetail,
} from "@/app/actions/order-actions";
import { RefundPanel } from "./refund-panel";

const ORDER_STATUSES = [
  "pending",
  "processing",
  "shipped",
  "delivered",
  "cancelled",
];
/** What a human may choose. Mirrors SETTABLE_PAYMENT_STATUSES in order-actions. */
const PAYMENT_STATUSES = ["pending", "paid", "failed"];
/** Derived by the refund machinery — displayed, never offered. */
const DERIVED_PAYMENT_STATUSES = ["refunded", "partially_refunded"];

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

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return iso;
  }
}

function readAddress(a: Record<string, unknown> | null) {
  if (!a) return null;
  const s = (k: string) => (typeof a[k] === "string" ? (a[k] as string) : "");
  return {
    name: [s("firstName"), s("lastName")].filter(Boolean).join(" "),
    phone: s("phone"),
    email: s("email"),
    line: s("address") || s("line1") || s("street"),
    cityLine: [
      s("city"),
      s("state"),
      s("pincode") || s("postalCode") || s("zip"),
    ]
      .filter(Boolean)
      .join(", "),
    country: s("country"),
  };
}

function methodLabel(m: string): string {
  return m === "cash_on_delivery"
    ? "Cash on Delivery"
    : m === "razorpay"
      ? "Razorpay (online)"
      : m;
}

export function OrderDetailDrawer({
  orderId,
  orderRef,
  onClose,
  onChanged,
}: {
  orderId: string | null;
  orderRef?: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();
  // Derived (not effect state), so we never setState synchronously in the effect.
  const loading = orderId !== null && loadedId !== orderId;

  // Fetch when a new order is opened. setState happens only in the async `.then`
  // (after the await), never synchronously in the effect body.
  useEffect(() => {
    if (!orderId) return;
    let cancelled = false;
    getOrderDetail(orderId).then((res) => {
      if (cancelled) return;
      if (res.error) toast.error(res.error);
      setDetail(res.order ?? null);
      setLoadedId(orderId);
    });
    return () => {
      cancelled = true;
    };
  }, [orderId]);

  const reload = useCallback(async () => {
    if (!orderId) return;
    const fresh = await getOrderDetail(orderId);
    if (fresh.order) setDetail(fresh.order);
  }, [orderId]);

  function updateField(next: { status?: string; paymentStatus?: string }) {
    if (!detail) return;
    const id = detail.id;
    startSaving(async () => {
      const res = await updateOrderStatus(
        id,
        next.status ?? detail.status,
        // ONLY when the payment status is what's being changed. Echoing the
        // current one back used to be harmless; it isn't now that `refunded` /
        // `partially_refunded` exist — they're derived from order_refunds and
        // rejected as input, so re-sending one would make every fulfilment
        // change on a refunded order fail.
        next.paymentStatus,
      );
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success("Order updated");
      await reload();
      onChanged();
    });
  }

  const ship = readAddress(detail?.shipping_address ?? null);

  return (
    <div className="flex max-h-[calc(100dvh-80px)] flex-col overflow-hidden rounded-[12px] border border-border bg-card shadow-sm">
      {/* Header */}
      <div className="flex items-start justify-between gap-2 border-b border-border bg-muted/30 p-4">
        <div className="min-w-0">
          <div className="truncate font-mono text-base font-semibold text-foreground">
            {detail?.order_ref || orderRef || "Order"}
          </div>
          <div className="text-xs text-muted-foreground">
            {detail ? `Placed ${fmtDate(detail.created_at)}` : "Loading order…"}
          </div>
          {detail && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <Pill value={detail.status} tone={STATUS_TONE[detail.status]} />
              <Pill
                value={`payment: ${detail.payment_status}`}
                tone={PAY_TONE[detail.payment_status]}
              />
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/10 hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        {loading || !detail ? (
          <div className="flex h-64 items-center justify-center text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : (
          <div className="flex flex-col gap-5 p-4">
            {/* Timeline */}
            <section>
              <SectionTitle icon={<Clock className="h-4 w-4" />}>
                Timeline
              </SectionTitle>
              <ol className="mt-2 space-y-3 border-l border-border pl-4">
                <TimelineRow
                  icon={<CheckCircle2 className="h-4 w-4 text-emerald-600" />}
                  title="Order placed"
                  meta={fmtDate(detail.created_at)}
                />
                <TimelineRow
                  icon={
                    detail.payment_status === "paid" ? (
                      <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                    ) : detail.payment_status === "failed" ? (
                      <XCircle className="h-4 w-4 text-rose-600" />
                    ) : (
                      <Clock className="h-4 w-4 text-amber-600" />
                    )
                  }
                  title={
                    detail.payment_status === "paid"
                      ? "Payment received"
                      : detail.payment_status === "failed"
                        ? "Payment failed"
                        : "Payment pending"
                  }
                  meta={methodLabel(detail.payment_method)}
                />
                <TimelineRow
                  icon={
                    detail.status === "cancelled" ? (
                      <XCircle className="h-4 w-4 text-rose-600" />
                    ) : detail.status === "delivered" ? (
                      <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                    ) : detail.status === "shipped" ? (
                      <Truck className="h-4 w-4 text-indigo-600" />
                    ) : detail.status === "processing" ? (
                      <Package className="h-4 w-4 text-blue-600" />
                    ) : (
                      <Circle className="h-4 w-4 text-gray-400" />
                    )
                  }
                  title={
                    detail.status === "cancelled"
                      ? "Cancelled"
                      : detail.status === "delivered"
                        ? "Delivered"
                        : detail.status === "shipped"
                          ? "Shipped"
                          : detail.status === "processing"
                            ? "Processing"
                            : "Awaiting fulfillment"
                  }
                  meta={`Updated ${fmtDate(detail.updated_at)}`}
                />
              </ol>
            </section>

            {/* Items */}
            <section>
              <SectionTitle icon={<Package className="h-4 w-4" />}>
                Items ({detail.items.length})
              </SectionTitle>
              <div className="mt-2 divide-y divide-border rounded-lg border border-border">
                {detail.items.map((it) => (
                  <div
                    key={it.id}
                    className="flex items-center gap-3 px-3 py-2.5"
                  >
                    <div className="relative h-11 w-11 shrink-0 overflow-hidden rounded-md border border-border bg-muted">
                      {it.image ? (
                        <Image
                          src={it.image}
                          alt={it.name}
                          fill
                          sizes="44px"
                          className="object-cover"
                        />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                          <ImageIcon className="h-4 w-4" />
                        </div>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-foreground">
                        {it.name}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {it.variant_name ? `${it.variant_name} · ` : ""}
                        {formatPrice(it.price)} × {it.quantity}
                      </div>
                    </div>
                    <div className="shrink-0 text-sm font-medium tabular-nums">
                      {formatPrice(it.total)}
                    </div>
                  </div>
                ))}
              </div>
            </section>

            {/* Finance */}
            <section>
              <SectionTitle icon={<CreditCard className="h-4 w-4" />}>
                Payment
              </SectionTitle>
              <dl className="mt-2 space-y-1.5 rounded-lg border border-border p-3 text-sm">
                <Row label="Subtotal" value={formatPrice(detail.subtotal)} />
                {detail.discount > 0 && (
                  <Row
                    label={`Discount${detail.applied_coupon_code ? ` (${detail.applied_coupon_code})` : ""}`}
                    value={`−${formatPrice(detail.discount)}`}
                  />
                )}
                <Row
                  label={`Tax${detail.tax_inclusive ? " (incl.)" : ""}`}
                  value={formatPrice(detail.tax)}
                />
                <Row label="Shipping" value={formatPrice(detail.shipping)} />
                <div className="mt-1 flex items-center justify-between border-t border-border pt-2 text-[15px] font-semibold">
                  <span>Total</span>
                  <span className="tabular-nums">
                    {formatPrice(detail.total)}
                  </span>
                </div>
                <div className="flex items-center justify-between pt-1 text-xs text-muted-foreground">
                  <span>{methodLabel(detail.payment_method)}</span>
                  <Pill
                    value={detail.payment_status}
                    tone={PAY_TONE[detail.payment_status]}
                  />
                </div>
                {detail.razorpay_payment_id && (
                  <div className="pt-0.5 font-mono text-[11px] text-muted-foreground">
                    {detail.razorpay_payment_id}
                  </div>
                )}
              </dl>
              {/* Money out. Its own component because it reconciles pending
                  gateway refunds on mount and owns a form — the drawer stays
                  a read-and-set-status view. */}
              <RefundPanel orderId={detail.id} onRefunded={reload} />
            </section>

            {/* Delivery */}
            <section>
              <SectionTitle icon={<MapPin className="h-4 w-4" />}>
                Delivery
              </SectionTitle>
              <div className="mt-2 rounded-lg border border-border p-3 text-sm">
                {ship ? (
                  <>
                    {ship.name && (
                      <div className="font-medium text-foreground">
                        {ship.name}
                      </div>
                    )}
                    {ship.phone && (
                      <div className="text-muted-foreground">{ship.phone}</div>
                    )}
                    {ship.line && (
                      <div className="mt-1 text-muted-foreground">
                        {ship.line}
                      </div>
                    )}
                    {ship.cityLine && (
                      <div className="text-muted-foreground">
                        {ship.cityLine}
                      </div>
                    )}
                    {ship.country && (
                      <div className="text-muted-foreground">
                        {ship.country}
                      </div>
                    )}
                  </>
                ) : (
                  <span className="text-muted-foreground">
                    No shipping address on file.
                  </span>
                )}
              </div>
            </section>

            {detail.notes && (
              <section>
                <SectionTitle icon={<FileText className="h-4 w-4" />}>
                  Notes
                </SectionTitle>
                <p className="mt-2 rounded-lg border border-border p-3 text-sm text-muted-foreground">
                  {detail.notes}
                </p>
              </section>
            )}
          </div>
        )}
      </div>

      {/* Actions */}
      {detail && (
        <div className="border-t border-border bg-muted/30 p-4">
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
              Fulfillment
              <select
                value={detail.status}
                disabled={saving}
                onChange={(e) => updateField({ status: e.target.value })}
                className="h-9 rounded-md border border-input bg-background px-2 text-sm capitalize text-foreground disabled:opacity-60"
              >
                {ORDER_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
              Payment
              {DERIVED_PAYMENT_STATUSES.includes(detail.payment_status) ? (
                // Derived from the refunds that actually settled, so it is
                // shown and not offered — picking it would assert money went
                // back with no order_refunds row saying so. Refunding (or a
                // refund failing) is what moves it.
                <span className="flex h-9 items-center rounded-md border border-input bg-muted/50 px-2 text-sm capitalize text-muted-foreground">
                  {detail.payment_status.replace("_", " ")}
                </span>
              ) : (
                <select
                  value={detail.payment_status}
                  disabled={saving}
                  onChange={(e) =>
                    updateField({ paymentStatus: e.target.value })
                  }
                  className="h-9 rounded-md border border-input bg-background px-2 text-sm capitalize text-foreground disabled:opacity-60"
                >
                  {PAYMENT_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              )}
            </label>
          </div>
          <Link
            href={`/dashboard/orders/${detail.id}/invoice`}
            className="mt-3 flex h-9 items-center justify-center gap-1.5 rounded-md border border-input text-sm font-medium text-foreground transition-colors hover:bg-accent/10"
          >
            <FileText className="h-4 w-4" />
            Print invoice
          </Link>
          {saving && (
            <div className="mt-2 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving…
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SectionTitle({
  icon,
  children,
}: {
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      {icon}
      {children}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}

function TimelineRow({
  icon,
  title,
  meta,
}: {
  icon: ReactNode;
  title: string;
  meta: string;
}) {
  return (
    <li className="relative">
      <span className="absolute -left-[26px] flex h-5 w-5 items-center justify-center rounded-full bg-card ring-2 ring-card">
        {icon}
      </span>
      <div className="text-sm font-medium text-foreground">{title}</div>
      <div className="text-xs text-muted-foreground">{meta}</div>
    </li>
  );
}
