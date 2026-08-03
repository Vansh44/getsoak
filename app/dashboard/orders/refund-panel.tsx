"use client";

// The merchant's way to send money back (roadmap Step 2,
// docs/returns-exchanges-plan.md §3).
//
// ── Two rules this UI exists to express ────────────────────────────────────
// 1. The TENDER decides where the money goes (§3.1). An online order offers
//    the gateway; a COD order does not, because there is no instrument to
//    reverse. There is deliberately no "refund as cash" control on an online
//    order — that is the card-not-present laundering path, and a control that
//    always fails server-side is worse than no control.
// 2. An unknown gateway outcome is NOT a failure. When `pendingReconcile`
//    comes back, the refund is real and in flight; this panel says so and
//    removes the button, because the one thing that must not happen next is
//    the merchant clicking Refund again.

import { useCallback, useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { AlertCircle, Clock, Loader2, RotateCcw } from "lucide-react";
import { formatPrice } from "@/lib/pricing";
import {
  getOrderRefundState,
  refundOrder,
  type DashboardRefundMethod,
  type OrderRefundState,
} from "@/app/actions/refund-actions";

const REFUND_TONE: Record<string, string> = {
  completed: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  pending: "bg-amber-50 text-amber-700 ring-amber-600/20",
  failed: "bg-rose-50 text-rose-700 ring-rose-600/20",
};

function methodLabel(m: string): string {
  switch (m) {
    case "razorpay":
      return "Online";
    case "manual":
      return "Paid by hand";
    default:
      return m.charAt(0).toUpperCase() + m.slice(1);
  }
}

export function RefundPanel({
  orderId,
  onRefunded,
}: {
  orderId: string;
  onRefunded?: () => void;
}) {
  const [state, setState] = useState<OrderRefundState | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [reference, setReference] = useState("");
  const [method, setMethod] = useState<DashboardRefundMethod>("razorpay");
  const [inFlight, setInFlight] = useState(false);
  const [pending, startTransition] = useTransition();

  const load = useCallback(async () => {
    setLoading(true);
    const res = await getOrderRefundState(orderId);
    if (res.state) {
      setState(res.state);
      setMethod(res.state.canRefundOnline ? "razorpay" : "manual");
    }
    setLoading(false);
  }, [orderId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <div className="mt-2 flex items-center gap-2 rounded-lg border border-border p-3 text-sm text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Checking refunds…
      </div>
    );
  }
  if (!state) return null;

  const {
    refunds,
    refundable,
    canRefundOnline,
    onlineBlockedReason,
    refundOwed,
  } = state;
  const nothingLeft = refundable <= 0;

  function submit() {
    if (inFlight) return;
    const parsed = amount.trim() === "" ? undefined : Number(amount);
    if (parsed !== undefined && (!Number.isFinite(parsed) || parsed <= 0)) {
      toast.error("Enter a valid amount, or leave it blank to refund it all.");
      return;
    }
    setInFlight(true);
    startTransition(async () => {
      try {
        const res = await refundOrder(orderId, {
          amount: parsed,
          method,
          reason: reason.trim() || undefined,
          reference: reference.trim() || undefined,
        });
        if (res.error) {
          toast.error(res.error);
          return;
        }
        if (res.pendingReconcile) {
          // Deliberately NOT an error, and deliberately not retryable.
          toast.info(
            "The refund is with Razorpay and hasn't confirmed yet. We'll keep checking — don't send it again.",
          );
        } else {
          toast.success(`Refunded ${formatPrice(res.amount ?? 0)}.`);
        }
        setOpen(false);
        setAmount("");
        setReason("");
        setReference("");
        await load();
        onRefunded?.();
      } catch {
        // A thrown action inside startTransition leaves `pending` stuck true
        // and surfaces nothing (the §25 lesson) — so it is caught here.
        toast.error(
          "Something went wrong. Check the refund list before retrying.",
        );
      } finally {
        setInFlight(false);
      }
    });
  }

  const busy = inFlight || pending;

  return (
    <div
      className={`mt-2 rounded-lg border p-3 text-sm ${
        refundOwed ? "border-amber-300 bg-amber-50/60" : "border-border"
      }`}
    >
      {/* ★ The prompt. A cancelled order that was paid for owes money, and
          nothing pays it on a schedule (returns-exchanges-plan §2.2) — so the
          obligation is stated here rather than left for the customer to chase.
          It disappears on its own once the refund lands, because it is derived
          from the order rather than stored as a flag. */}
      {refundOwed && (
        <p className="mb-2 flex items-start gap-1.5 text-[13px] font-medium text-amber-900">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          This order was cancelled after it was paid for —{" "}
          {formatPrice(refundable)} is owed back.
        </p>
      )}
      {refunds.length > 0 && (
        <ul className="mb-2 space-y-1.5">
          {refunds.map((r) => (
            <li key={r.id} className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="font-medium tabular-nums">
                    {formatPrice(r.amount)}
                  </span>
                  <span
                    className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium capitalize ring-1 ring-inset ${
                      REFUND_TONE[r.status] ??
                      "bg-gray-100 text-gray-700 ring-gray-500/20"
                    }`}
                  >
                    {r.status}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {methodLabel(r.method)}
                  </span>
                </div>
                {(r.reason || r.reference) && (
                  <div className="truncate text-xs text-muted-foreground">
                    {[r.reason, r.reference].filter(Boolean).join(" · ")}
                  </div>
                )}
                {r.status === "pending" && (
                  <div className="mt-0.5 flex items-center gap-1 text-[11px] text-amber-700">
                    <Clock className="h-3 w-3" />
                    Waiting on the gateway — we&apos;re checking.
                  </div>
                )}
              </div>
              <div className="flex shrink-0 flex-col items-end gap-0.5">
                {r.gatewayRefundId && (
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {r.gatewayRefundId}
                  </span>
                )}
                {/* The GST document. Only settled refunds on taxed orders have
                    one — the serial can't be issued earlier without risking a
                    gap in the series. */}
                {r.creditNoteRef && (
                  <Link
                    href={`/dashboard/orders/credit-notes/${r.id}`}
                    className="font-mono text-[10px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
                  >
                    {r.creditNoteRef}
                  </Link>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {nothingLeft ? (
        <p className="text-xs text-muted-foreground">
          {refunds.length > 0
            ? "Fully refunded."
            : "Nothing to refund on this order."}
        </p>
      ) : !open ? (
        <div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">
              {formatPrice(refundable)} can still be refunded
            </span>
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs font-medium hover:bg-muted"
            >
              <RotateCcw className="h-3 w-3" />
              Refund
            </button>
          </div>
          {onlineBlockedReason && (
            <p className="mt-1.5 flex items-start gap-1.5 text-[11px] text-muted-foreground">
              <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
              {onlineBlockedReason}
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {/* The method is offered, never assumed — but an online refund is
              only offered when the order actually went through the gateway. */}
          <div className="flex gap-1.5">
            {canRefundOnline && (
              <MethodChip
                active={method === "razorpay"}
                onClick={() => setMethod("razorpay")}
                label="Refund online"
              />
            )}
            <MethodChip
              active={method === "manual"}
              onClick={() => setMethod("manual")}
              label="I paid them by hand"
            />
          </div>

          <label className="block">
            <span className="text-xs text-muted-foreground">
              Amount (blank = all {formatPrice(refundable)})
            </span>
            <input
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              max={refundable}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder={String(refundable)}
              className="mt-0.5 w-full rounded-md border border-border px-2 py-1 text-sm"
            />
          </label>

          {method === "manual" && (
            <label className="block">
              <span className="text-xs text-muted-foreground">
                Reference (UPI or bank transaction id) — required
              </span>
              <input
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder="e.g. UPI 402913887711"
                className="mt-0.5 w-full rounded-md border border-border px-2 py-1 text-sm"
              />
            </label>
          )}

          <label className="block">
            <span className="text-xs text-muted-foreground">
              Reason (optional)
            </span>
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Damaged on arrival"
              className="mt-0.5 w-full rounded-md border border-border px-2 py-1 text-sm"
            />
          </label>

          <div className="flex items-center justify-end gap-2 pt-0.5">
            <button
              type="button"
              onClick={() => setOpen(false)}
              disabled={busy}
              className="rounded-md px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-2.5 py-1 text-xs font-medium text-background disabled:opacity-50"
            >
              {busy && <Loader2 className="h-3 w-3 animate-spin" />}
              {method === "razorpay" ? "Send refund" : "Record refund"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function MethodChip({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md border px-2 py-1 text-xs font-medium ${
        active
          ? "border-foreground bg-foreground text-background"
          : "border-border hover:bg-muted"
      }`}
    >
      {label}
    </button>
  );
}
