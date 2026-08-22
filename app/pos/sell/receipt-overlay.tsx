"use client";

import { useEffect, useState } from "react";
import { Check, Loader2, Printer, Receipt, X } from "lucide-react";
import { getPosReceipt } from "@/app/actions/pos-sale-actions";
import { ThermalReceipt } from "@/components/pos/thermal-receipt";
import type { ReceiptModel } from "@/lib/pos/receipt";

// Two decimals always — change handed back is money, and "₹249.9" reads as a
// typo at the exact moment a customer is checking it.
const money = (n: number) =>
  n.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

// Shown the moment a sale completes: confirmation + change to hand back, with
// the 80mm receipt ready to print. thermal-receipt.css hides everything except
// .tr-sheet when printing, so the dark register chrome never reaches paper.
export function ReceiptOverlay({
  orderId,
  onClose,
  mode = "completed",
}: {
  orderId: string;
  onClose: () => void;
  /**
   * "completed" is the moment of sale — it leads with change due, because
   * that's money about to leave the drawer. "reprint" is a customer asking
   * for a duplicate bill minutes or days later: the change was handed over
   * long ago, so repeating it would just be confusing.
   */
  mode?: "completed" | "reprint";
}) {
  const [receipt, setReceipt] = useState<ReceiptModel | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void getPosReceipt(orderId).then((r) => {
      if (!live) return;
      if (r.error) setError(r.error);
      else setReceipt(r.receipt ?? null);
    });
    return () => {
      live = false;
    };
  }, [orderId]);

  const reprint = mode === "reprint";

  // Enter starts the next sale — the cashier's hands stay on the keyboard.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="tr-no-print w-full max-w-sm rounded-2xl border border-[var(--pos-border)] bg-[var(--pos-surface)] shadow-2xl p-5 text-center">
        <div
          className={`mx-auto flex h-14 w-14 items-center justify-center rounded-2xl ${
            reprint
              ? "bg-[var(--pos-surface-2)] text-[var(--pos-ink-2)]"
              : "bg-[var(--pos-ok-soft)] text-[var(--pos-ok)]"
          }`}
        >
          {reprint ? (
            <Receipt className="h-7 w-7" strokeWidth={2} />
          ) : (
            <Check className="h-7 w-7" strokeWidth={2.5} />
          )}
        </div>
        <h2 className="mt-3 text-lg font-bold">
          {reprint ? "Receipt" : "Sale complete"}
        </h2>

        {!reprint && receipt && receipt.changeDue > 0 && (
          <div className="mt-3 rounded-xl bg-[var(--pos-warn-soft)] px-4 py-3">
            <div className="text-sm text-[var(--pos-warn)]">Change due</div>
            <div className="text-2xl font-bold text-[var(--pos-warn)]">
              ₹{money(receipt.changeDue)}
            </div>
          </div>
        )}

        {receipt && (
          <p className="mt-2 text-sm text-[var(--pos-ink-2)]">
            {receipt.receiptNo} · ₹{money(receipt.total)}
          </p>
        )}
        {error && (
          <p className="mt-2 text-sm text-[var(--pos-danger)]">{error}</p>
        )}
        {!receipt && !error && (
          <Loader2 className="mx-auto mt-3 h-5 w-5 animate-spin text-[var(--pos-ink-3)]" />
        )}

        <div className="mt-5 flex gap-2">
          <button
            type="button"
            disabled={!receipt}
            onClick={() => window.print()}
            className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-[var(--pos-surface-2)] py-3 text-sm font-semibold hover:bg-[var(--pos-surface-3)] disabled:opacity-40"
          >
            <Printer className="h-4 w-4" strokeWidth={2} />
            Print
          </button>
          <button
            type="button"
            onClick={onClose}
            className={`flex flex-1 items-center justify-center gap-2 rounded-xl py-3 text-sm font-semibold ${
              reprint
                ? "bg-[var(--pos-surface-2)] hover:bg-[var(--pos-surface-3)]"
                : "bg-emerald-600 hover:bg-emerald-500"
            }`}
          >
            <X className="h-4 w-4" strokeWidth={2} />
            {reprint ? "Done" : "New sale"}
          </button>
        </div>
        <p className="mt-2 text-[11px] text-[var(--pos-ink-3)]">
          {reprint
            ? "Press Enter to close"
            : "Press Enter to start the next sale"}
        </p>
      </div>

      {/* Off-screen until printed. */}
      {receipt && (
        <div className="tr-print-host pointer-events-none fixed top-0 left-[-9999px]">
          <ThermalReceipt receipt={receipt} />
        </div>
      )}
    </div>
  );
}
