"use client";

// The shopper's cancel control (roadmap Step 2).
//
// ★ ASKING IS NOT CANCELLING, AND THE COPY HAS TO SAY SO. This raises a REQUEST
// the store reviews; it does not stop the order by itself. A button that reads
// "Cancel this order" and then silently only asks is how somebody assumes it is
// done, stops watching, and is surprised by a delivery.
//
// ★ A REAL CONFIRMATION STEP, not window.confirm. Two things have to be said
// before someone commits — that this cancels the ENTIRE order, and that the
// store decides — and a native dialog can carry neither, nor take the reason
// that makes the merchant's decision an informed one.
//
// It deliberately does NOT hide once an order ships. Someone who wants out
// still wants out, and a button that vanishes leaves them nowhere to say so —
// which becomes a support email the merchant handles by hand anyway. The server
// refuses and explains instead.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { cancelMyOrder } from "@/app/actions/customer-order-actions";
import styles from "../orders.module.css";

export function CancelOrderButton({ orderId }: { orderId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const [done, setDone] = useState<"cancelled" | "requested" | null>(null);

  if (done === "cancelled") return null; // the page re-renders as cancelled

  if (done === "requested") {
    return (
      <div className={styles.cancelRow}>
        <p className={styles.cancelNote}>
          <strong>Cancellation request submitted.</strong> The store is
          reviewing it and will let you know. Until then the order still stands.
        </p>
      </div>
    );
  }

  function submit() {
    if (pending) return;
    startTransition(async () => {
      try {
        const res = await cancelMyOrder(orderId, reason);
        if (res.error) {
          toast.error(res.error);
          setConfirming(false);
          return;
        }
        // The SERVER decides which of these happened — a store with automatic
        // approval switched on cancels outright, everyone else gets a request.
        // The client never predicts it.
        if (res.cancelled) {
          setDone("cancelled");
          toast.success("Your order has been cancelled.");
          router.refresh();
        } else {
          setDone("requested");
          toast.success("Cancellation request submitted.");
          router.refresh();
        }
      } catch {
        // A thrown action inside startTransition leaves `pending` stuck true
        // and surfaces nothing at all (the §25 lesson).
        toast.error("Something went wrong. Please try again.");
      }
    });
  }

  if (confirming) {
    return (
      <div className={styles.cancelPanel}>
        <p className={styles.cancelPanelTitle}>Request to cancel this order?</p>
        <p className={styles.cancelNote}>
          This asks the store to cancel <strong>the entire order</strong> —
          every item on it. They&apos;ll review the request and let you know.
          Any refund is handled by the store and may take a few days.
        </p>
        <textarea
          className={styles.cancelReasonInput}
          rows={2}
          maxLength={200}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Why are you cancelling? (optional)"
          aria-label="Reason for cancelling"
        />
        <div className={styles.cancelActions}>
          <button
            type="button"
            onClick={submit}
            disabled={pending}
            className={styles.cancelConfirmBtn}
          >
            {pending ? "Sending…" : "Request cancellation"}
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            disabled={pending}
            className={styles.cancelBtn}
          >
            Keep my order
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.cancelRow}>
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className={styles.cancelBtn}
      >
        Cancel order
      </button>
      <p className={styles.cancelNote}>
        Cancelling covers the whole order. The store reviews the request.
      </p>
    </div>
  );
}
