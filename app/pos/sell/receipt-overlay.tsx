"use client";

import { useEffect, useState } from "react";
import { Check, Loader2, Printer, X } from "lucide-react";
import { getPosReceipt } from "@/app/actions/pos-sale-actions";
import { ThermalReceipt } from "@/components/pos/thermal-receipt";
import type { ReceiptModel } from "@/lib/pos/receipt";

// Shown the moment a sale completes: confirmation + change to hand back, with
// the 80mm receipt ready to print. thermal-receipt.css hides everything except
// .tr-sheet when printing, so the dark register chrome never reaches paper.
export function ReceiptOverlay({
  orderId,
  onClose,
}: {
  orderId: string;
  onClose: () => void;
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
      <div className="tr-no-print w-full max-w-sm rounded-2xl border border-white/10 bg-[#12171f] p-5 text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-500/15 text-emerald-400">
          <Check className="h-7 w-7" strokeWidth={2.5} />
        </div>
        <h2 className="mt-3 text-lg font-bold">Sale complete</h2>

        {receipt && receipt.changeDue > 0 && (
          <div className="mt-3 rounded-xl bg-amber-400/15 px-4 py-3">
            <div className="text-sm text-amber-200">Change due</div>
            <div className="text-2xl font-bold text-amber-100">
              ₹{receipt.changeDue.toLocaleString("en-IN")}
            </div>
          </div>
        )}

        {receipt && (
          <p className="mt-2 text-sm text-white/60">
            {receipt.receiptNo} · ₹{receipt.total.toLocaleString("en-IN")}
          </p>
        )}
        {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
        {!receipt && !error && (
          <Loader2 className="mx-auto mt-3 h-5 w-5 animate-spin text-white/40" />
        )}

        <div className="mt-5 flex gap-2">
          <button
            type="button"
            disabled={!receipt}
            onClick={() => window.print()}
            className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-white/10 py-3 text-sm font-semibold hover:bg-white/20 disabled:opacity-40"
          >
            <Printer className="h-4 w-4" strokeWidth={2} />
            Print
          </button>
          <button
            type="button"
            onClick={onClose}
            className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-emerald-600 py-3 text-sm font-semibold hover:bg-emerald-500"
          >
            <X className="h-4 w-4" strokeWidth={2} />
            New sale
          </button>
        </div>
        <p className="mt-2 text-[11px] text-white/40">
          Press Enter to start the next sale
        </p>
      </div>

      {/* Off-screen until printed. */}
      {receipt && (
        <div className="pointer-events-none fixed left-[-9999px] top-0">
          <ThermalReceipt receipt={receipt} />
        </div>
      )}
    </div>
  );
}
