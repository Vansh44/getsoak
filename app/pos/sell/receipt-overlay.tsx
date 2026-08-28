"use client";

import { useEffect, useState } from "react";
import {
  Check,
  Loader2,
  PackageCheck,
  Printer,
  Receipt,
  UserRound,
  X,
} from "lucide-react";
import { getPosReceipt } from "@/app/actions/pos-sale-actions";
import { ThermalReceipt } from "@/components/pos/thermal-receipt";
import { TENDER_LABEL, type ReceiptModel } from "@/lib/pos/receipt";

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
  const [detail, setDetail] = useState<
    Awaited<ReturnType<typeof getPosReceipt>>["detail"] | null
  >(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void getPosReceipt(orderId).then((r) => {
      if (!live) return;
      if (r.error) setError(r.error);
      else {
        setReceipt(r.receipt ?? null);
        setDetail(r.detail ?? null);
      }
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
      <div
        className={`tr-no-print max-h-[calc(100vh-2rem)] w-full overflow-y-auto rounded-2xl border border-[var(--pos-border)] bg-[var(--pos-surface)] p-5 shadow-2xl ${
          reprint ? "max-w-2xl text-left" : "max-w-sm text-center"
        }`}
      >
        <div
          className={`${reprint ? "" : "mx-auto"} flex h-14 w-14 items-center justify-center rounded-2xl ${
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

        {reprint && receipt && detail && (
          <div className="mt-5 space-y-3 text-left">
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="rounded-xl bg-[var(--pos-surface-2)] p-3">
                <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-[var(--pos-ink-3)]">
                  <UserRound className="h-4 w-4" /> Customer
                </div>
                <div className="mt-2 text-sm font-semibold">
                  {detail.customerName || "Customer"}
                </div>
                <div className="text-xs text-[var(--pos-ink-2)]">
                  {[detail.customerPhone, detail.customerEmail]
                    .filter(Boolean)
                    .join(" · ") || "No contact details"}
                </div>
              </div>
              <div className="rounded-xl bg-[var(--pos-surface-2)] p-3">
                <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-[var(--pos-ink-3)]">
                  <PackageCheck className="h-4 w-4" /> Sale
                </div>
                <div className="mt-2 text-sm font-semibold">
                  {detail.kind === "pickup"
                    ? "Collected in store"
                    : "Register sale"}
                </div>
                <div className="text-xs text-[var(--pos-ink-2)]">
                  {new Date(detail.completedAt).toLocaleString("en-IN")} ·{" "}
                  {detail.paymentStatus}
                </div>
              </div>
            </div>

            <div className="overflow-hidden rounded-xl border border-[var(--pos-border)]">
              {receipt.lines.map((line, index) => (
                <div
                  key={`${line.name}-${index}`}
                  className="flex items-start justify-between gap-3 border-b border-[var(--pos-border)] px-3 py-2.5 last:border-b-0"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">
                      {line.name}
                    </div>
                    <div className="text-xs text-[var(--pos-ink-2)]">
                      {line.variantName ? `${line.variantName} · ` : ""}
                      {line.quantity} × ₹{money(line.unitPrice)}
                    </div>
                  </div>
                  <div className="shrink-0 text-sm font-semibold">
                    ₹{money(line.total)}
                  </div>
                </div>
              ))}
            </div>

            <div className="rounded-xl bg-[var(--pos-surface-2)] p-3 text-sm">
              <div className="flex justify-between text-[var(--pos-ink-2)]">
                <span>Subtotal</span>
                <span>₹{money(receipt.subtotal)}</span>
              </div>
              {receipt.discount > 0 && (
                <div className="mt-1 flex justify-between text-[var(--pos-ink-2)]">
                  <span>Discount</span>
                  <span>−₹{money(receipt.discount)}</span>
                </div>
              )}
              {receipt.tax > 0 && (
                <div className="mt-1 flex justify-between text-[var(--pos-ink-2)]">
                  <span>Tax{receipt.taxInclusive ? " (included)" : ""}</span>
                  <span>₹{money(receipt.tax)}</span>
                </div>
              )}
              <div className="mt-2 flex justify-between border-t border-[var(--pos-border)] pt-2 font-bold">
                <span>Total</span>
                <span>₹{money(receipt.total)}</span>
              </div>
              {receipt.tenders.map((tender, index) => (
                <div
                  key={`${tender.method}-${index}`}
                  className="mt-1 flex justify-between text-xs text-[var(--pos-ink-2)]"
                >
                  <span>{TENDER_LABEL[tender.method] ?? tender.method}</span>
                  <span>₹{money(tender.amount)}</span>
                </div>
              ))}
            </div>
          </div>
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
                : "bg-emerald-600 text-white hover:bg-emerald-500"
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
