"use client";

// The shopper's "send it back" form (roadmap Step 3).
//
// ── What it shows, and what it refuses to promise ──────────────────────────
// The fee preview is computed CLIENT-side from the same pure module the server
// uses (`lib/returns/reasons.ts`), so picking "arrived damaged" visibly drops
// the deduction to zero as you choose it. That is the point of the rule —
// a customer should be able to SEE that they aren't being charged for the
// store's mistake — but it is a preview: the server recomputes everything and
// its number is the one that counts.
//
// A final-sale line renders disabled with the reason, rather than being hidden.
// A missing row reads as a bug; a row that says why is an answer.

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  cancelMyReturn,
  requestReturn,
  type ReturnableOrderView,
} from "@/app/actions/return-actions";
import {
  feesFor,
  returnReasonOptions,
  wantsPhoto,
  type ReturnReason,
} from "@/lib/returns/reasons";
import { exchangeSettlement } from "@/lib/returns/exchange";
import { refundBreakdown } from "@/lib/pos/returns";
import styles from "../orders.module.css";

function money(n: number): string {
  return `₹${n.toFixed(2)}`;
}

const STATUS_COPY: Record<string, string> = {
  requested: "Waiting for the store to review",
  approved: "Approved — send it back",
  received: "The store has your items",
  completed: "Completed",
  rejected: "Declined",
  cancelled: "Withdrawn",
};

export function ReturnRequest({ view }: { view: ReturnableOrderView }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [qty, setQty] = useState<Record<string, number>>({});
  /** Per line: the variant they want instead, or "" for a refund. */
  const [swap, setSwap] = useState<Record<string, string>>({});
  const [reason, setReason] = useState<ReturnReason | "">("");
  const [note, setNote] = useState("");
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);

  const selectable = view.lines.filter((l) => l.remaining > 0);
  const anyReturnable = selectable.some((l) => l.returnable);

  /**
   * What the store will actually hand back for what is ticked.
   *
   * ★★ THE SERVER'S OWN FUNCTION, NOT AN APPROXIMATION OF IT. This used to sum
   * `unitPrice × qty`, which ignores EVERY discount — so a customer who had
   * used a coupon, or won an offer, was quoted the full list value of the goods
   * and refunded the discounted value. `requestReturn` settles with
   * `refundBreakdown`, so the estimate is computed with it too and the two
   * cannot disagree.
   *
   * ★ EVERY LINE IS PASSED, not just the ticked ones. The order-level remainder
   * is allocated ACROSS the order in proportion to each line's value, so
   * allocating over a subset would give the ticked lines a larger share than
   * the sale did — the same reason `priceReturn` reads all of `order_items`.
   */
  const breakdown = useMemo(
    () =>
      refundBreakdown({
        lines: view.lines.map((l) => ({
          id: l.orderItemId,
          quantity: l.quantity,
          lineTotal: l.lineTotal,
          taxAmount: l.taxAmount,
          offerDiscount: l.offerDiscount,
          alreadyReturned: l.returned,
        })),
        orderDiscount: view.orderDiscount,
        request: Object.entries(qty).map(([id, q]) => ({ id, quantity: q })),
      }),
    [view, qty],
  );

  // The GOODS value, excluding tax — what fees are charged on and what an
  // exchange is settled against, matching `requestReturn` on both counts.
  const goodsValue = breakdown.amount;

  const fees = useMemo(
    () =>
      feesFor(
        reason || null,
        {
          restockingFeePercent: view.restockingFeePercent,
          returnShippingFee: view.returnShippingFee,
        },
        goodsValue,
      ),
    [reason, goodsValue, view.restockingFeePercent, view.returnShippingFee],
  );

  // What the replacements cost, at the prices the server just quoted.
  const replacementValue = useMemo(
    () =>
      selectable.reduce((sum, l) => {
        const target = swap[l.orderItemId];
        if (!target) return sum;
        const opt = l.swapOptions.find((o) => o.variantId === target);
        return sum + (opt?.price ?? 0) * (qty[l.orderItemId] ?? 0);
      }, 0),
    [selectable, swap, qty],
  );

  const swapping = Object.values(swap).some(Boolean);
  const settlement = useMemo(
    () =>
      exchangeSettlement({
        returnValue: swapping ? goodsValue : 0,
        replacementValue,
      }),
    [swapping, goodsValue, replacementValue],
  );

  const picked = Object.values(qty).reduce((a, b) => a + b, 0);
  const needPhoto = wantsPhoto(reason || null, view.requirePhoto);

  function submit() {
    if (busy) return;
    if (picked <= 0) {
      toast.error("Choose what you'd like to send back.");
      return;
    }
    if (view.requireReason && !reason) {
      toast.error("Please tell us why it's coming back.");
      return;
    }
    setBusy(true);
    startTransition(async () => {
      try {
        const res = await requestReturn({
          orderId: view.orderId,
          lines: Object.entries(qty)
            .filter(([, q]) => q > 0)
            .map(([orderItemId, quantity]) => ({
              orderItemId,
              quantity,
              exchangeVariantId: swap[orderItemId] || null,
            })),
          reasonCode: reason || undefined,
          note: note.trim() || undefined,
        });
        if (res.error) {
          toast.error(res.error);
          return;
        }
        toast.success(
          res.isExchange
            ? "We've asked the store to swap this for you."
            : res.autoApproved
              ? "Return approved — check your email for what to do next."
              : "We've asked the store to review your return.",
        );
        setOpen(false);
        setQty({});
        setSwap({});
        setReason("");
        setNote("");
        router.refresh();
      } catch {
        // A thrown action inside startTransition leaves `pending` stuck true
        // and surfaces nothing at all.
        toast.error("Something went wrong. Please try again.");
      } finally {
        setBusy(false);
      }
    });
  }

  function withdraw(id: string) {
    setBusy(true);
    startTransition(async () => {
      try {
        const res = await cancelMyReturn(id);
        if (res.error) toast.error(res.error);
        else {
          toast.success("Request withdrawn.");
          router.refresh();
        }
      } catch {
        toast.error("Something went wrong.");
      } finally {
        setBusy(false);
      }
    });
  }

  const working = busy || pending;

  return (
    <div className={styles.card}>
      <div className={styles.sectionTitle}>Returns</div>

      {/* Requests already on this order, and what happened to them. A
          rejection shows the store's reason — a silent no is the worst
          outcome a returns process has. */}
      {view.existing.length > 0 && (
        <ul className={styles.returnList}>
          {view.existing.map((r) => (
            <li key={r.id} className={styles.returnItem}>
              <div>
                <strong>{STATUS_COPY[r.status] ?? r.status}</strong>
                <span className={styles.returnMeta}>
                  {" "}
                  · {r.itemCount} item{r.itemCount === 1 ? "" : "s"} ·{" "}
                  {money(r.total)}
                </span>
                {r.reviewNote && (
                  <p className={styles.returnNote}>{r.reviewNote}</p>
                )}
              </div>
              {r.status === "requested" && (
                <button
                  type="button"
                  disabled={working}
                  onClick={() => withdraw(r.id)}
                  className={styles.cancelBtn}
                >
                  Withdraw
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {!view.eligibility.eligible ? (
        <p className={styles.summary}>{view.blockedCopy}</p>
      ) : !anyReturnable ? (
        <p className={styles.summary}>
          Everything on this order has either been returned already or is final
          sale.
        </p>
      ) : !open ? (
        <div className={styles.cancelRow}>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className={styles.cancelBtn}
          >
            Return an item
          </button>
          {view.eligibility.daysLeft !== null && (
            <p className={styles.cancelNote}>
              {view.eligibility.daysLeft === 0
                ? "Today is the last day to return this order."
                : `${view.eligibility.daysLeft} days left to return this order.`}
            </p>
          )}
        </div>
      ) : (
        <div className={styles.returnForm}>
          <ul className={styles.returnLines}>
            {selectable.map((l) => (
              <li key={l.orderItemId} className={styles.returnLine}>
                <div>
                  <span>{l.name}</span>
                  {l.variantName && (
                    <span className={styles.returnMeta}>
                      {" "}
                      · {l.variantName}
                    </span>
                  )}
                  {!l.returnable && (
                    <p className={styles.returnNote}>
                      Final sale — this item can&apos;t be returned.
                    </p>
                  )}
                  {/* Swap, offered only when the store allows exchanges and
                      this product actually has another variant. A same-price
                      size change is what people overwhelmingly want, and it
                      settles to zero. */}
                  {view.allowExchanges &&
                    l.returnable &&
                    l.swapOptions.length > 0 &&
                    (qty[l.orderItemId] ?? 0) > 0 && (
                      <select
                        value={swap[l.orderItemId] ?? ""}
                        onChange={(e) =>
                          setSwap((sw) => ({
                            ...sw,
                            [l.orderItemId]: e.target.value,
                          }))
                        }
                        className={styles.returnSwap}
                      >
                        <option value="">Refund me instead</option>
                        {l.swapOptions.map((o) => (
                          <option
                            key={o.variantId}
                            value={o.variantId}
                            disabled={!o.available}
                          >
                            Swap for {o.name}
                            {o.available ? "" : " — out of stock"}
                          </option>
                        ))}
                      </select>
                    )}
                </div>
                <select
                  disabled={!l.returnable}
                  value={qty[l.orderItemId] ?? 0}
                  onChange={(e) =>
                    setQty((q) => ({
                      ...q,
                      [l.orderItemId]: Number(e.target.value),
                    }))
                  }
                  className={styles.returnQty}
                >
                  {Array.from({ length: l.remaining + 1 }, (_, i) => (
                    <option key={i} value={i}>
                      {i}
                    </option>
                  ))}
                </select>
              </li>
            ))}
          </ul>

          <label className={styles.returnField}>
            <span>Why is it coming back?{view.requireReason ? " *" : ""}</span>
            <select
              value={reason}
              onChange={(e) => setReason(e.target.value as ReturnReason | "")}
            >
              <option value="">Choose a reason…</option>
              {returnReasonOptions().map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>

          <label className={styles.returnField}>
            <span>Anything else? (optional)</span>
            <textarea
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Tell the store what happened"
            />
          </label>

          {needPhoto && (
            <p className={styles.returnNote}>
              The store may ask for a photo of the damage — have one ready.
            </p>
          )}

          {picked > 0 && (
            <div className={styles.returnTotals}>
              <div>
                <span>Items</span>
                <span>{money(goodsValue)}</span>
              </div>
              {fees.totalDeduction > 0 && (
                <div>
                  <span>
                    Fees
                    {fees.returnShippingFee > 0
                      ? " (incl. return postage)"
                      : ""}
                  </span>
                  <span>−{money(fees.totalDeduction)}</span>
                </div>
              )}
              {/* ★ Said out loud, because it is the whole reason the reason
                  matters — and a customer who can see it stops arguing. */}
              {fees.waived && (
                <p className={styles.returnNote}>
                  No fees — this one&apos;s on us, and we&apos;ll cover the
                  return postage.
                </p>
              )}
              {swapping ? (
                <>
                  <div>
                    <span>Replacement</span>
                    <span>{money(settlement.replacementValue)}</span>
                  </div>
                  <div className={styles.returnTotalRow}>
                    <span>
                      {settlement.even ? "Nothing to pay" : "You'd get back"}
                    </span>
                    <span>
                      {settlement.even
                        ? "₹0.00"
                        : money(
                            Math.max(
                              0,
                              settlement.storeOwes - fees.totalDeduction,
                            ),
                          )}
                    </span>
                  </div>
                  {/* ★ Refused before they submit, with what to do instead —
                      collecting a difference isn't something this can do yet. */}
                  {!settlement.allowed && (
                    <p className={styles.returnNote}>
                      {settlement.blockedCopy}
                    </p>
                  )}
                </>
              ) : (
                <div className={styles.returnTotalRow}>
                  <span>You&apos;d get back</span>
                  <span>
                    {money(Math.max(0, goodsValue - fees.totalDeduction))}
                  </span>
                </div>
              )}
              <p className={styles.returnNote}>
                An estimate — the store confirms the exact amount, and tax is
                refunded on top.
              </p>
            </div>
          )}

          <div className={styles.returnActions}>
            <button
              type="button"
              onClick={() => setOpen(false)}
              disabled={working}
              className={styles.cancelBtn}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={working || picked <= 0 || !settlement.allowed}
              className={styles.returnSubmit}
            >
              {working
                ? "Sending…"
                : swapping
                  ? "Request exchange"
                  : "Request return"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
