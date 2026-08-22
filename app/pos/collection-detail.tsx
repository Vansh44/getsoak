"use client";

// One collection, opened at the counter.
//
// ★ WHY A PANEL AND NOT A ROUTE. The returns detail is a route because it is a
// STEP IN A FLOW — you leave the queue and come back. This is the opposite: the
// customer is standing there, and everything the cashier might do next (mark
// ready, take the money, hand it over) already lives in counter-client, wired
// to the tender pad and the queue's own refresh. A route would need a second
// copy of that wiring, and a second copy of hand-over is exactly the kind of
// duplication that ends with two screens disagreeing about what is owed.
//
// So it renders BELOW the pad (z-40 against the pad's z-50): tapping "Take
// payment" here opens the same pad over the same order, and completing it
// closes both.
//
// ★ IT OWNS NO ACTIONS OF ITS OWN. Every button calls back into the parent.
// This component reads and renders; it never mutates.

import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Check,
  Loader2,
  PackageCheck,
  Wallet,
  X,
} from "lucide-react";
import {
  collectionNote,
  collectionPayment,
  collectionState,
} from "@/lib/pos/collection-state";
import {
  getPickupOrderDetail,
  type PickupDetail,
  type PickupOrder,
} from "@/app/actions/pos-pickup-actions";

const money = (n: number) =>
  `₹${n.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

/** Tender words, not order-payment words. `card` at this counter means the
 *  shop's own terminal — see the tender pad's grouping for why that matters. */
const TENDER_LABEL: Record<string, string> = {
  cash: "Cash",
  card: "Card machine",
  upi: "UPI app",
  razorpay: "Online (Razorpay)",
  store_credit: "Store credit",
  split: "Split",
};

function fmtWhen(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function CollectionDetail({
  order,
  canFulfilPickup,
  busy,
  reloadKey,
  onClose,
  onMarkReady,
  onHandOver,
}: {
  /** The row that was tapped. Its figures paint the header immediately, so the
   *  panel opens with the order already named rather than on a spinner. */
  order: PickupOrder;
  canFulfilPickup: boolean;
  busy: boolean;
  /** Bumped by the parent when something moved the money on this order. */
  reloadKey: number;
  onClose: () => void;
  onMarkReady: () => void;
  /** The detail read is newer than the queue row. Returning that snapshot keeps
   *  the tender amount and action state on the same read the cashier saw. */
  onHandOver: (order: PickupOrder) => void;
}) {
  const [detail, setDetail] = useState<PickupDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Parent mutations (Mark ready, a deposit) are newer than both the tapped
  // row and any detail already on screen. Remember the original row so those
  // deliberate prop changes can override an older detail without letting the
  // original queue snapshot override the first live read.
  const [initialOrder] = useState(order);

  // ★ THE PREVIOUS READ IS NOT CLEARED ON A RELOAD. The parent remounts this
  // (keyed on the order id) when a DIFFERENT order is opened, which is when a
  // spinner is right; a reload is the same order re-read after a deposit, and
  // blanking the basket for a round trip there would be a flicker on the one
  // screen a cashier is reading aloud to a customer.
  useEffect(() => {
    let live = true;
    void getPickupOrderDetail(order.id).then((r) => {
      if (!live) return;
      // Cleared by the ARRIVING read, never up front: a synchronous setState
      // in an effect body cascades a render, and blanking the message before
      // the retry has landed just makes a failure flicker.
      setError(r.error ?? null);
      if (!r.error) setDetail(r.detail ?? null);
    });
    return () => {
      live = false;
    };
  }, [order.id, reloadKey]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Paint immediately from the row, then let the newer detail read own every
  // decision. Otherwise a cancelled/paid/refunded order can show current facts
  // while retaining stale controls and a stale tender amount from the queue.
  const current: PickupOrder = detail
    ? {
        ...detail,
        ...(order.status !== initialOrder.status
          ? { status: order.status }
          : {}),
        ...(order.amountDue !== initialOrder.amountDue ||
        order.paidSoFar !== initialOrder.paidSoFar
          ? { amountDue: order.amountDue, paidSoFar: order.paidSoFar }
          : {}),
      }
    : order;
  const state = collectionState(current.status, current.expiresAt);
  const note = collectionNote(state, current.status);
  const gone = state === "gone";
  const fullyRefunded = detail?.paymentStatus === "refunded";
  const pay = collectionPayment({
    paymentMethod: detail?.paymentMethod ?? null,
    paymentStatus: detail?.paymentStatus ?? null,
    paidSoFar: current.paidSoFar,
    amountDue: current.amountDue,
  });
  const owed = pay.state === "due" || pay.state === "part";

  // ★ THE PAYMENT LABEL WAITS FOR THE READ; the AMOUNT does not. `amountDue`
  // on the row is authoritative (same helper, same figure as markCollected
  // charges), so "₹45 due" can be shown at once. WHY nothing is owed cannot —
  // paid online, refunded and a failed payment all present as 0 until
  // payment_status arrives, and the fallback would flash "Nothing to collect at
  // the counter" a beat before "Paid online". On a screen a cashier reads out
  // to a customer, a word that changes is worse than a word that is late.
  const payKnown = detail !== null || order.amountDue > 0;
  const itemCount = current.itemCount;

  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl border border-[var(--pos-border)] bg-[var(--pos-surface)] shadow-2xl sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Outside the scroll area, so a long basket never scrolls the order
          reference off the screen it is being checked against. */}
        <div className="flex items-start gap-3 border-b border-[var(--pos-border)] px-5 py-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="font-mono text-base font-semibold">
                {order.orderRef}
              </span>
              {current.status === "ready" && !gone && (
                <span className="rounded-full bg-[var(--pos-ok-soft)] px-2 py-0.5 text-xs font-medium text-[var(--pos-ok)]">
                  Ready
                </span>
              )}
            </div>
            <p className="mt-0.5 truncate text-sm text-[var(--pos-ink-2)]">
              {order.customerName ?? "Customer"}
              {detail?.customerPhone ? ` · ${detail.customerPhone}` : ""}
            </p>
            {detail?.collectionCode && (
              <p className="mt-1 font-mono text-xs tracking-wider text-[var(--pos-ink-3)]">
                Code {detail.collectionCode}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-2 text-[var(--pos-ink-2)] hover:bg-[var(--pos-surface-2)]"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {note && (
            <p
              className={`mb-4 rounded-lg px-3 py-2 text-sm ${
                state === "lapsed"
                  ? "bg-[var(--pos-warn-soft)] text-[var(--pos-warn)]"
                  : "bg-[var(--pos-surface-2)] text-[var(--pos-ink-2)]"
              }`}
            >
              {note}
            </p>
          )}

          {/* ★ PAYMENT FIRST, ABOVE THE GOODS. It is the one thing that decides
            what happens next, and the cashier is reading this with a customer
            waiting. */}
          <div
            className={`rounded-xl border px-4 py-3 ${
              !payKnown
                ? "border-[var(--pos-border)] bg-[var(--pos-surface-2)]"
                : pay.state === "failed"
                  ? "border-[var(--pos-danger-border)] bg-[var(--pos-danger-soft)]"
                  : owed
                    ? "border-[var(--pos-warn-border)] bg-[var(--pos-warn-soft)]"
                    : "border-[var(--pos-ok-border)] bg-[var(--pos-ok-soft)]"
            }`}
          >
            <div className="flex items-center gap-2">
              {!payKnown ? (
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[var(--pos-ink-3)]" />
              ) : pay.state === "failed" ? (
                <AlertTriangle className="h-4 w-4 shrink-0 text-[var(--pos-danger)]" />
              ) : owed ? (
                <Wallet className="h-4 w-4 shrink-0 text-[var(--pos-warn)]" />
              ) : (
                <Check className="h-4 w-4 shrink-0 text-[var(--pos-ok)]" />
              )}
              <span
                className={`text-sm font-semibold ${
                  !payKnown
                    ? "text-[var(--pos-ink-2)]"
                    : pay.state === "failed"
                      ? "text-[var(--pos-danger)]"
                      : owed
                        ? "text-[var(--pos-warn)]"
                        : "text-[var(--pos-ok)]"
                }`}
              >
                {payKnown ? pay.label : "Checking payment…"}
              </span>
            </div>
            {owed && (
              <div className="mt-2 flex items-baseline justify-between">
                <span className="text-sm text-[var(--pos-ink-2)]">
                  Still to collect
                </span>
                <span className="text-2xl font-bold text-[var(--pos-warn)]">
                  {money(pay.due)}
                </span>
              </div>
            )}

            {/* What was taken, and how — a deposit is otherwise only visible as
              a smaller "still to collect", which is a figure to be trusted
              rather than checked. */}
            {detail && detail.payments.length > 0 && (
              <ul className="mt-2 space-y-1 border-t border-black/5 pt-2">
                {detail.payments.map((p, i) => (
                  <li
                    key={`${p.capturedAt}:${i}`}
                    className="flex items-baseline justify-between gap-2 text-sm"
                  >
                    <span className="text-[var(--pos-ink-2)]">
                      {TENDER_LABEL[p.method] ?? p.method}
                      <span className="text-[var(--pos-ink-3)]">
                        {p.capturedAt ? ` · ${fmtWhen(p.capturedAt)}` : ""}
                      </span>
                    </span>
                    <span className="font-medium">{money(p.amount)}</span>
                  </li>
                ))}
              </ul>
            )}
            {detail && detail.storeCreditUsed > 0 && (
              <div className="mt-2 flex items-baseline justify-between border-t border-black/5 pt-2 text-sm">
                <span className="text-[var(--pos-ink-2)]">
                  Store credit applied
                </span>
                <span className="font-medium">
                  {money(detail.storeCreditUsed)}
                </span>
              </div>
            )}
          </div>

          {/* The goods. */}
          <h3 className="mt-5 mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--pos-ink-3)]">
            {/* The DETAIL's count once it lands: it is summed from the lines
              rendered directly below, so the two can never contradict each
              other the way "0 items" over two products would. */}
            {itemCount} item{itemCount === 1 ? "" : "s"}
          </h3>

          {error && (
            <p className="rounded-lg bg-[var(--pos-danger-soft)] px-3 py-2 text-sm text-[var(--pos-danger)]">
              {error}
            </p>
          )}
          {!detail && !error && (
            <div className="flex items-center gap-2 py-4 text-sm text-[var(--pos-ink-3)]">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading the order…
            </div>
          )}

          {detail && (
            <>
              <ul className="divide-y divide-[var(--pos-border)]">
                {detail.lines.map((l, i) => (
                  <li key={i} className="flex gap-3 py-2.5">
                    <span className="min-w-[2.25rem] shrink-0 rounded-md bg-[var(--pos-surface-2)] px-2 py-0.5 text-center text-sm font-semibold">
                      {l.quantity}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{l.name}</p>
                      {l.variantName && (
                        <p className="text-xs text-[var(--pos-ink-2)]">
                          {l.variantName}
                        </p>
                      )}
                      <p className="text-xs text-[var(--pos-ink-3)]">
                        {money(l.price)} each
                        {l.lineDiscount > 0
                          ? ` · less ${money(l.lineDiscount)}`
                          : ""}
                      </p>
                    </div>
                    <span className="shrink-0 text-sm font-semibold">
                      {money(l.total)}
                    </span>
                  </li>
                ))}
              </ul>

              <dl className="mt-4 space-y-1 border-t border-[var(--pos-border)] pt-3 text-sm">
                <Row label="Subtotal" value={money(detail.subtotal)} />
                {detail.discount > 0 && (
                  <Row
                    label="Discount"
                    value={`− ${money(detail.discount)}`}
                    muted
                  />
                )}
                {detail.shipping > 0 && (
                  <Row label="Shipping" value={money(detail.shipping)} muted />
                )}
                {detail.tax > 0 && (
                  <Row
                    label={detail.taxInclusive ? "Tax (included)" : "Tax"}
                    value={money(detail.tax)}
                    muted
                  />
                )}
                <div className="flex items-baseline justify-between border-t border-[var(--pos-border)] pt-2 text-base font-bold">
                  <dt>Order total</dt>
                  <dd>{money(detail.total)}</dd>
                </div>
              </dl>

              <p className="mt-3 text-xs text-[var(--pos-ink-3)]">
                Placed {fmtWhen(detail.placedAt)}
                {detail.preparedAt
                  ? ` · prepared ${fmtWhen(detail.preparedAt)}`
                  : ""}
                {detail.collectedAt
                  ? ` · collected ${fmtWhen(detail.collectedAt)}`
                  : ""}
              </p>
            </>
          )}
        </div>

        {/* ★ THE SAME TWO ACTIONS THE ROW OFFERS, AND THE SAME RULE: nothing
          once the order is gone, because every control could only fail. */}
        {!gone && !fullyRefunded && (
          <div className="flex gap-2 border-t border-[var(--pos-border)] px-5 py-4">
            {current.status === "awaiting" && canFulfilPickup && (
              <button
                type="button"
                disabled={busy}
                onClick={onMarkReady}
                className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-[var(--pos-surface-2)] px-4 py-3 text-sm font-semibold hover:bg-[var(--pos-surface-3)] disabled:opacity-50"
              >
                <PackageCheck className="h-4 w-4" />
                Mark ready
              </button>
            )}
            {/* ★ A FAILED PAYMENT DOES NOT GET THE GREEN BUTTON. `markCollected`
              still permits it — its claim only reads `pickup_status`, so it
              would hand the parcel over having taken nothing, and narrowing
              that is a change to what the counter does today. What can change
              here is that it must not READ as the expected next step: a
              full-strength "Hand over" directly under "this order was never
              settled" is the screen contradicting itself, and the button wins
              that argument every time. Demoted and renamed, never hidden — the
              customer may well be entitled to it, and the shop decides. */}
            <button
              type="button"
              disabled={busy}
              onClick={() => onHandOver(current)}
              className={`inline-flex flex-1 items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold disabled:opacity-50 ${
                pay.state === "failed"
                  ? "bg-[var(--pos-surface-2)] hover:bg-[var(--pos-surface-3)]"
                  : "bg-emerald-600 text-white hover:bg-emerald-500"
              }`}
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : owed ? (
                <Wallet className="h-4 w-4" />
              ) : pay.state === "failed" ? (
                <AlertTriangle className="h-4 w-4" />
              ) : (
                <Check className="h-4 w-4" />
              )}
              {owed
                ? `Take ${money(pay.due)}`
                : pay.state === "failed"
                  ? "Hand over anyway"
                  : "Hand over"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  muted,
}: {
  label: string;
  value: string;
  muted?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between">
      <dt className={muted ? "text-[var(--pos-ink-2)]" : ""}>{label}</dt>
      <dd className={muted ? "text-[var(--pos-ink-2)]" : ""}>{value}</dd>
    </div>
  );
}
