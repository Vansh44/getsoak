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
  const [reason, setReason] = useState<ReturnReason | "">("");
  const [note, setNote] = useState("");
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);

  const selectable = view.lines.filter((l) => l.remaining > 0);
  const anyReturnable = selectable.some((l) => l.returnable);

  // The goods value of what's ticked — an approximation of the server's
  // `refundBreakdown.amount`, good enough to preview a fee against.
  const goodsValue = useMemo(
    () =>
      selectable.reduce(
        (sum, l) => sum + (qty[l.orderItemId] ?? 0) * l.unitPrice,
        0,
      ),
    [selectable, qty],
  );

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
            .map(([orderItemId, quantity]) => ({ orderItemId, quantity })),
          reasonCode: reason || undefined,
          note: note.trim() || undefined,
        });
        if (res.error) {
          toast.error(res.error);
          return;
        }
        toast.success(
          res.autoApproved
            ? "Return approved — check your email for what to do next."
            : "We've asked the store to review your return.",
        );
        setOpen(false);
        setQty({});
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
              <div className={styles.returnTotalRow}>
                <span>You&apos;d get back</span>
                <span>
                  {money(Math.max(0, goodsValue - fees.totalDeduction))}
                </span>
              </div>
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
              disabled={working || picked <= 0}
              className={styles.returnSubmit}
            >
              {working ? "Sending…" : "Request return"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
