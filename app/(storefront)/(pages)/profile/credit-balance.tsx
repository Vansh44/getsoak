"use client";

// The shopper's store-credit card. Renders only when there is something to
// say — see the `nothingToShow` guard below.

import { useEffect, useState } from "react";
import { Wallet } from "lucide-react";
import {
  getMyCredit,
  type MyCreditEntry,
} from "@/app/actions/customer-credit-actions";
import { formatPrice } from "@/lib/pricing";
import styles from "./profile.module.css";

// ★ CUSTOMER WORDING, KEPT APART FROM THE MERCHANT'S. The same ledger row is
// "Refund on ORD100110097" in the dashboard and "Refund" here. §24 makes this
// split for order statuses for the same reason: merchant copy names internal
// records, and a shopper should never have to read one.
const KIND_LABEL: Record<string, string> = {
  refund: "Refund",
  reinstate: "Order cancelled",
  grant: "Added by the store",
  spend: "Spent on an order",
  expire: "Expired",
};

/** An unknown kind still renders — a blank row would look like a bug, and the
 *  amount and date are the parts that matter. */
function labelFor(kind: string): string {
  return KIND_LABEL[kind] ?? "Adjustment";
}

/** Dates are pinned to Asia/Kolkata to match the order pages (§24). Without a
 *  zone these would follow the reader's device and disagree with the same
 *  event shown one page away. */
function formatWhen(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  });
}

function Movement({ entry }: { entry: MyCreditEntry }) {
  const added = entry.delta > 0;
  return (
    <li className={styles.creditRow}>
      <span className={styles.creditRowLabel}>
        <strong>{labelFor(entry.kind)}</strong>
        <small>{formatWhen(entry.createdAt)}</small>
      </span>
      <span
        className={`${styles.creditRowAmount} ${
          added ? styles.creditRowAdded : styles.creditRowSpent
        }`}
      >
        {added ? "+" : "−"}
        {formatPrice(Math.abs(entry.delta))}
      </span>
    </li>
  );
}

export default function CreditBalance() {
  const [summary, setSummary] = useState<{
    balance: number;
    entries: MyCreditEntry[];
  } | null>(null);

  // Same shape as AddressBook's initial fetch: setState inside the promise
  // callback, with an `active` guard so a fast unmount can't set state.
  useEffect(() => {
    let active = true;
    getMyCredit()
      .then((res) => {
        if (active) setSummary(res);
      })
      .catch(() => {
        // getMyCredit already swallows its own errors; this is belt-and-braces
        // so a transport failure leaves the card absent rather than throwing
        // inside the profile page.
        if (active) setSummary({ balance: 0, entries: [] });
      });
    return () => {
      active = false;
    };
  }, []);

  // Nothing until the first read lands — a card that flashes "₹0.00" and then
  // corrects itself reads as a bug when the subject is money.
  if (!summary) return null;

  // ★ HIDDEN WHEN THERE IS NO CREDIT AND NEVER HAS BEEN. Most shoppers will
  // never hold any, and a permanent "₹0.00" on every profile is noise — the
  // same reason checkout renders its credit line only when `applied > 0`.
  // A spent-to-zero balance still shows, because the history explains where
  // the money went and disappearing entirely would look like it was lost.
  const nothingToShow = summary.balance <= 0 && summary.entries.length === 0;
  if (nothingToShow) return null;

  // slotCredit rides on the card itself, NOT a wrapper in the page: this
  // component returns null when there is no credit, and an empty wrapper would
  // still be a flex/grid item — the container's 24px gap would apply to it and
  // leave a phantom space above the next card.
  return (
    <div className={`${styles.card} ${styles.slotCredit}`}>
      <div className={styles.cardHeader}>
        <h2 className={styles.cardTitle}>Store credit</h2>
        <p className={styles.cardSubtitle}>
          Applied automatically at checkout — there is nothing to enter.
        </p>
      </div>

      <div className={styles.creditAmountRow}>
        <span className={styles.creditIcon} aria-hidden="true">
          <Wallet size={20} strokeWidth={1.75} />
        </span>
        <span>
          <span className={styles.creditAmount}>
            {formatPrice(summary.balance)}
          </span>
          <span className={styles.creditAmountCaption}>
            {summary.balance > 0
              ? "available to spend"
              : "you have used all of your credit"}
          </span>
        </span>
      </div>

      {summary.entries.length > 0 && (
        <>
          <h3 className={styles.creditHistoryTitle}>Recent activity</h3>
          <ul className={styles.creditList}>
            {summary.entries.map((entry) => (
              <Movement key={entry.id} entry={entry} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
