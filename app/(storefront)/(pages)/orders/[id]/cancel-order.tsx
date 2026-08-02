"use client";

// The shopper's cancel button (roadmap Step 2).
//
// ★ ONE BUTTON, TWO OUTCOMES — and the client does not decide which. Whether
// an order is still stoppable depends on its status, its age and the store's
// window, all of which the server re-checks inside the same statement that
// cancels (see cancelMyOrder). So this component asks, and reports back what
// happened; it never predicts.
//
// It deliberately does NOT hide once an order ships. Someone who wants out of
// an order still wants out after it has shipped, and a button that vanishes
// leaves them with nowhere to say so — which turns into a support email the
// merchant has to handle by hand anyway.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { cancelMyOrder } from "@/app/actions/customer-order-actions";
import styles from "../orders.module.css";

export function CancelOrderButton({ orderId }: { orderId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [done, setDone] = useState<"cancelled" | "requested" | null>(null);

  if (done === "cancelled") return null; // the page re-renders as cancelled
  if (done === "requested") {
    return (
      <div className={styles.cancelRow}>
        <p className={styles.cancelNote}>
          We&apos;ve asked the store to cancel this order. They&apos;ll be in
          touch — it may already be on its way.
        </p>
      </div>
    );
  }

  function onClick() {
    if (pending) return;
    if (
      !window.confirm(
        "Cancel this order? If it hasn't been sent yet we'll stop it right away.",
      )
    ) {
      return;
    }
    startTransition(async () => {
      try {
        const res = await cancelMyOrder(orderId);
        if (res.error) {
          toast.error(res.error);
          return;
        }
        if (res.cancelled) {
          setDone("cancelled");
          toast.success("Your order has been cancelled.");
          router.refresh();
        } else {
          setDone("requested");
          toast.success("We've asked the store to cancel this order.");
        }
      } catch {
        // A thrown action inside startTransition leaves `pending` stuck true
        // and shows nothing at all (the §25 lesson).
        toast.error("Something went wrong. Please try again.");
      }
    });
  }

  return (
    <div className={styles.cancelRow}>
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        className={styles.cancelBtn}
      >
        {pending ? "Cancelling…" : "Cancel this order"}
      </button>
      {/* Said up front, because a shopper who expects an instant refund and
          doesn't get one contacts the store either way. */}
      <p className={styles.cancelNote}>
        Any refund is handled by the store and may take a few days.
      </p>
    </div>
  );
}
